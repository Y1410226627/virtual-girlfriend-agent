// 群聊引擎（T04 · 单模型多角色扮演）。
//
// 设计要点（对齐架构 §3.4 / §3.6 / §3.8）：
// - 群表是【全局表】（跨伴侣），一律用 dbAll/dbGet/dbRun，绝不套 cAll/cGet/cRun。
// - buildGroupPrompt：★隐私红线★ 只取 companions 表的【公开字段】(name/identity/personality_tags/intro)，
//   群内历史只用 group_messages；**绝不**调用 retrieveMemories/stableFacts/recentMessagesForPrompt/
//   buildReplySystemPrompt 等任何会加载私密记忆 / 用户画像的入口。
// - planSpeakers：纯函数 + 可注入 RNG → @ 优先 → 未发言轮转 → 随机 1–2 人（spoke_counts 平衡）。
// - 禁三连击：同一人不得连说 3 条（由 recent_speakers 尾部连续计数判定）。
// - reaction 代替发言：以概率（REACTION_CHANCE）产出一条 speaker_type='reaction' 的 emoji 消息（只看不说）。
// - 自然收尾：命中 END_PHRASES 或 run.round >= max_rounds → status='ended' + 插 system 分隔消息。
// - 可中止：abort(groupId) 置 run.status='cancelled'，随后 planSpeakers 返回空即停止。
// - 感知/关系联动：发言被回应/reaction → 小幅亲近（+1~+3），经 companion-relations.applyDelta 落到
//   companion_relations，其好感闭环由该模块内部经 applyRelationshipDelta 完成（群聊里绝不直接改 emotional_balance）。
// - 并发：群聊运行【只持群锁】（withGroupLock，见 group-run.ts）；对伴侣数据的写入走可重入 tx()（applyDelta 内部），
//   绝不获取伴侣会话锁（叶子锁原则，避免死锁）。
import { dbAll, dbGet, dbRun, tx, cGet, cRun, DEFAULT_USER_ID } from './db';
import { nowIso, clamp, safeJson, errMsg } from './utils';
import { chat, cleanContent, type ChatMessage } from './llm';
import { applyDelta, getRelation } from './companion-relations';
import { getCompanion } from './companion';
import { withCompanion } from './companion-context';
import { memoriesByType } from './memory';
import { buildGroupSystemPrompt, type GroupPublicCard } from './prompts';
import {
  GROUP_MAX_ROUNDS,
  getCurrentRun,
  getLastRun,
  getRunById,
  createRun,
  updateScheduling,
  endRun,
  cancelRun,
  readRecentSpeakers,
  readSpokeCounts,
  totalSpokeCount,
  withGroupLock,
} from './group-run';
import type { GroupRow, GroupMessageRow, GroupRunRow, CompanionRow } from './types';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */
/**
 * 群成员【软上限】——仅用于 prompt/UI 的提示与预算控制，**不再阻塞任何人**。
 * 产品要求：女友数量 / 群成员数 / 活动参与人数均无硬上限。
 */
export const GROUP_SOFT_MEMBER_LIMIT = 30;
/**
 * @deprecated 旧名（原名是 6 的【硬上限】，会拒绝建群/加人）。硬上限已废弃：
 * 保留此导出仅为兼容既有引用（如 api 层 `max: GROUP_MAX_MEMBERS` 展示），
 * 现语义 = {@link GROUP_SOFT_MEMBER_LIMIT}（软上限，不阻塞）。
 */
export const GROUP_MAX_MEMBERS = GROUP_SOFT_MEMBER_LIMIT;
/** 群成员下限（群聊至少两人） */
export const GROUP_MIN_MEMBERS = 2;
/**
 * 群聊 prompt 中最多展开【完整公开角色卡】的成员数。
 * 人数超过此值时，其余成员只以名单形式出现（`群成员还有：…`）——**纯上下文裁剪，不阻塞任何人参与**。
 */
export const GROUP_PROMPT_CARD_LIMIT = 12;
/** reaction 代替发言的概率 */
export const REACTION_CHANCE = 0.25;
/** 单次用户发言后，最多推进的「轮」数（每轮选 1–2 人 → 支撑"AI 互聊 2–4 句"） */
export const MAX_ROUNDS_PER_TURN = 3;
/** 单次用户发言后，最多产生的 AI 正式发言（LLM 调用）条数 */
export const MAX_UTTERANCES_PER_TURN = 4;
/** 单个 run 的 LLM 调用上限（防止上下文成本失控） */
export const MAX_LLM_CALLS_PER_RUN = 40;
/** 每次群发言的 LLM 调用超时（毫秒） */
export const GROUP_CALL_TIMEOUT_MS = 30000;
/** 群发言的 maxTokens */
export const GROUP_MAX_TOKENS = 300;

/* ------------------------------------------------------------------ */
/* 自由发言模型（planBeat）的规则常量                                   */
/* ------------------------------------------------------------------ */
/** 每名成员每个「拍」的基础开口概率（temperature 可整体缩放） */
const BEAT_BASE_P = 0.45;
/** 名字被最近一条消息（话题）点到 → 更想接话 */
const BEAT_TOPIC_MENTION_BOOST = 2.2;
/** 刚发过言（最近 1 条内）→ 明显收敛 */
const BEAT_JUST_SPOKE_DECAY = 0.25;
/** 很久没发言（最近 members.length*2 条里都没出现）→ 想补位 */
const BEAT_NEW_FACE_BOOST = 1.5;
/** 与上一位发言者关系好（value>0）→ 更可能接话 */
const BEAT_RELATION_GOOD_BOOST = 1.3;
/** 与上一位发言者关系差（value<0）→ 更可能沉默 */
const BEAT_RELATION_BAD_DECAY = 0.7;
/** 上一拍冷场 → 本拍升温 */
const BEAT_SILENT_BOOST = 1.6;
/** 单个「拍」最多几人开口（@ 强制者不受此上限约束） */
export const GROUP_BEAT_MAX_SPEAKERS = 3;
/** 连续多少拍为空 → 本轮自然结束（不空跑 LLM） */
export const MAX_SILENT_BEATS = 2;

/** reaction 用的 emoji 池 */
export const REACTION_EMOJIS = ['👍', '😄', '😂', '🤔', '👀', '😮', '🙌', '😊', '👏', '🤭', '😅', '🥺'];

/**
 * 群聊中用户的显示标签。
 * ★隐私选择★：群聊里一律以「我」称呼用户，绝不加载/注入用户的真实姓名与画像
 * （对齐架构 §3.4 的上下文示例「…以及「我」（用户）」，也是隐私红线的一部分）。
 */
export const GROUP_USER_LABEL = '我';

/**
 * 群聊自然收尾词（集中定义于此，对齐架构 §7）。
 * 命中即结束本 run（含用户消息与 AI 发言）。
 */
export const END_PHRASES = [
  '再见',
  '拜拜',
  '88',
  '晚安',
  '困了',
  '我先睡了',
  '睡了',
  '不聊了',
  '下线',
  '先走',
  '溜了',
  '撤了',
  '先忙',
  '改天聊',
];

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */
function asId(v: unknown): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 去重 + 只保留正整数，保持出现顺序 */
export function uniqueIds(ids: unknown[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of ids) {
    const id = asId(raw);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ */
/* 收尾判定                                                            */
/* ------------------------------------------------------------------ */
/** 文本是否命中收尾词 */
export function hitsEndPhrase(text: string): boolean {
  const t = String(text ?? '');
  if (!t) return false;
  return END_PHRASES.some((p) => t.includes(p));
}

/** 该 run 是否应当自然结束（命中收尾词 或 达到轮数上限） */
export function shouldEnd(run: GroupRunRow, text: string): boolean {
  return hitsEndPhrase(text) || Number(run.round) >= Number(run.max_rounds);
}

/* ------------------------------------------------------------------ */
/* 发言者调度（纯函数 + 可注入 RNG）                                     */
/* ------------------------------------------------------------------ */
/** 由 recent_speakers 求某人在尾部连续出现的次数（禁三连击依据） */
function consecutiveStreak(recent: number[], id: number): number {
  let n = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i] === id) n++;
    else break;
  }
  return n;
}

/** 平衡选择：优先取 spoke_counts 最小者；同分时用 rng 选（轮转场景传 () => 0 即取最靠前者） */
function pickByBalance(pool: number[], counts: Record<number, number>, rng: () => number): number | null {
  if (!pool.length) return null;
  let min = Infinity;
  for (const id of pool) min = Math.min(min, counts[id] ?? 0);
  const ties = pool.filter((id) => (counts[id] ?? 0) === min);
  if (!ties.length) return null;
  const idx = Math.min(ties.length - 1, Math.max(0, Math.floor(rng() * ties.length)));
  return ties[idx] ?? ties[0] ?? null;
}

export interface PlanSpeakersOptions {
  /** 注入的 RNG（返回 [0,1)），便于单测确定性复现 */
  rng: () => number;
  /** @ 提及的 companion id（强制优先） */
  mentions?: number[];
  /** 单轮最多选几人（默认 2） */
  maxSpeakers?: number;
}

/**
 * 发言调度（纯函数，不读写数据库 —— 调度状态由调用方从 run 解析后传入 run 行）：
 *   ① 被 @ 提及者【全部】发言（强制；但过滤掉会触发"三连击"的人）；
 *   ② 否则「上次未发言者」轮转（用 recent_speakers：取最近一轮窗口内未出现者，发言次数最少者优先）；
 *   ③ 否则随机 1–2 人（spoke_counts 平衡，避免抢话）。
 * 返回值：本轮的发言者 id 数组（有序）；无可用发言者时返回空数组。
 *
 * @deprecated 旧的「一人发言 → 全员指派应答」模型。群聊引擎 `runGroupTurn` 已改用
 * {@link planBeat}（情境驱动的自由发挥：谁想接话谁接、可 0 人开口）。此函数**保留导出**
 * 仅为过渡期兼容（部分调用方/测试仍在用）；新代码请使用 `planBeat`。
 */
export function planSpeakers(run: GroupRunRow | null, members: number[], opts: PlanSpeakersOptions): number[] {
  const rng = opts.rng;
  const uniqueMembers = uniqueIds(members);
  if (!uniqueMembers.length) return [];

  const memberSet = new Set(uniqueMembers);
  const maxSpeakers = clamp(Math.trunc(Number(opts.maxSpeakers ?? 2)) || 2, 1, 3);
  const recent = readRecentSpeakers(run);
  // 再说一条就会"三连击"（尾部已连续 2 次）→ 本轮禁选
  const blocked = (id: number) => consecutiveStreak(recent, id) >= 2;

  // ① @ 提及者（强制全部发言，但过滤掉会三连击的人）
  const mentioned = uniqueIds(opts.mentions ?? []).filter((id) => memberSet.has(id) && !blocked(id));
  if (mentioned.length) return mentioned.slice(0, uniqueMembers.length);

  const counts = readSpokeCounts(run);

  // ② 未发言者轮转：最近一轮窗口（长度=成员数）内未出现者
  const window = recent.slice(-uniqueMembers.length);
  const windowSet = new Set(window);
  const unspoken = uniqueMembers.filter((id) => !windowSet.has(id) && !blocked(id));
  if (unspoken.length) {
    // 轮转取确定性：发言次数最少者优先，同分按成员顺序（rng=() => 0 取最靠前者）
    const picked = pickByBalance(unspoken, counts, () => 0);
    return picked ? [picked] : [];
  }

  // ③ 随机 1–2 人（平衡）
  const candidates = uniqueMembers.filter((id) => !blocked(id));
  if (!candidates.length) return [];
  const count = clamp(1 + Math.floor(rng() * 2), 1, Math.min(maxSpeakers, candidates.length));
  const chosen: number[] = [];
  const pool = [...candidates];
  for (let i = 0; i < count; i++) {
    const pick = pickByBalance(pool, counts, rng);
    if (pick == null) break;
    chosen.push(pick);
    const idx = pool.indexOf(pick);
    if (idx >= 0) pool.splice(idx, 1);
  }
  return chosen;
}

/* ------------------------------------------------------------------ */
/* 自由发言模型（planBeat · 情境驱动）                                  */
/* ------------------------------------------------------------------ */
export interface PlanBeatOptions {
  /** 注入的 RNG（返回 [0,1)），便于单测确定性复现 */
  rng: () => number;
  /** 被 @ 提及的 companion id（强制发言，不受概率影响） */
  mentions?: number[];
  /** 整体温度：>1 更活跃、<1 更沉默（默认 1.0，作用于基础概率） */
  temperature?: number;
  /** 本拍最多几人开口（@ 强制者不受此上限约束；默认 GROUP_BEAT_MAX_SPEAKERS） */
  maxSpeakers?: number;
  /** 上一拍是否冷场（0 人开口）→ 本拍整体升温 */
  prevSilent?: boolean;
  /** 最近一条消息文本（用于判断"自己的名字被话题点到"） */
  lastText?: string | null;
  /** 关系取值注入（默认读 companion_relations.value，规范序）；便于单测 */
  relationValue?: (id: number, other: number) => number;
  /** 逐成员权重乘数（默认 1）。用于「主导者优先」场景（如线下约会聚焦对象 ×3.5），
   *  注意这是**加权而非独占**——其他人仍有概率开口，符合"各说各话"。 */
  boost?: Record<number, number>;
}

/**
 * 「一拍」的发言人集合（纯函数 + 可注入 RNG，允许返回**空数组**）。
 *
 * 这是取代「一人发言 → 全员指派应答」的**情境驱动自由发挥**模型：每名成员**独立**判定
 * 是否开口，谁想接话谁接、可以没人接（冷场）、也可以几个人陆续聊起来（AI 互聊）。
 *
 * 规则（最终实现）：
 *   基础概率 base = 0.45 × temperature（默认 1.0）
 *   ├─ 被 @ 提及                        → p = 1（强制；但若会三连击则被硬不变量剔除）
 *   ├─ 名字出现在最近一条消息文本里     → ×2.2（被话题点名）
 *   ├─ 尾部已连续 2 条同一人（三连击）  → p = 0（**硬不变量，不得突破**）
 *   ├─ 刚发过言（最近 1 条内）          → ×0.25
 *   ├─ 很久没发言（最近 members.length*2 条里都没出现）→ ×1.5
 *   ├─ 与上一位发言者关系好（value>0）  → ×1.3；关系差（value<0）→ ×0.7
 *   └─ 上一拍冷场                       → ×1.6（冷场后升温，避免一直没人说话）
 *   每拍最多 maxSpeakers 人（默认 3，避免刷屏）；@ 强制者不计入该上限。
 *
 * 返回值：本拍发言者 id（按成员顺序，稳定有序）；可以为空。
 */
export function planBeat(run: GroupRunRow | null, members: number[], opts: PlanBeatOptions): number[] {
  const rng = opts.rng;
  const uniqueMembers = uniqueIds(members);
  if (!uniqueMembers.length) return [];

  const memberSet = new Set(uniqueMembers);
  const recent = readRecentSpeakers(run);
  const temperature = Number.isFinite(Number(opts.temperature)) ? Number(opts.temperature) : 1.0;
  const base = clamp(BEAT_BASE_P * temperature, 0, 1);
  const maxSpeakers = clamp(
    Math.trunc(Number(opts.maxSpeakers ?? GROUP_BEAT_MAX_SPEAKERS)) || GROUP_BEAT_MAX_SPEAKERS,
    1,
    500
  );

  const mentionSet = new Set(uniqueIds(opts.mentions ?? []).filter((id) => memberSet.has(id)));
  const lastText = String(opts.lastText ?? '');
  const prevSpeaker = recent.slice(-1)[0] ?? null;
  const recentWindow = recent.slice(-(uniqueMembers.length * 2));
  const relationValue =
    opts.relationValue ??
    ((id: number, other: number): number => {
      try {
        return Number(getRelation(id, other)?.value ?? 0);
      } catch {
        return 0;
      }
    });

  // 硬不变量：再说一条就会"三连击"（尾部已连续 2 次）→ 本拍禁开口（@ 也不例外）
  const blocked = (id: number): boolean => consecutiveStreak(recent, id) >= 2;

  // ① @ 强制（过滤掉会三连击者）——不受概率与 maxSpeakers 约束
  const forced = uniqueIds(opts.mentions ?? []).filter((id) => memberSet.has(id) && !blocked(id));

  // ② 其余成员各自独立判定
  const probabilistic: number[] = [];
  for (const id of uniqueMembers) {
    if (blocked(id)) continue;
    if (mentionSet.has(id)) continue; // 已在 forced 中（@ 强制）
    let p = base;
    const boost = Number(opts.boost?.[id]);
    if (Number.isFinite(boost) && boost > 0) p *= boost; // 逐成员加权（如线下焦点优先）
    const name = companionName(id);
    if (name && lastText.includes(name)) p *= BEAT_TOPIC_MENTION_BOOST;
    if (recent.length && recent[recent.length - 1] === id) p *= BEAT_JUST_SPOKE_DECAY;
    else if (recent.length && !recentWindow.includes(id)) p *= BEAT_NEW_FACE_BOOST;
    if (prevSpeaker && prevSpeaker !== id) {
      const v = relationValue(id, prevSpeaker);
      if (v > 0) p *= BEAT_RELATION_GOOD_BOOST;
      else if (v < 0) p *= BEAT_RELATION_BAD_DECAY;
    }
    if (opts.prevSilent) p *= BEAT_SILENT_BOOST;
    p = clamp(p, 0, 1);
    // 仅在概率为"模糊区间"时消耗 RNG（p>=1 必开口、p<=0 必沉默，都短路）
    if (p >= 1 || (p > 0 && rng() < p)) probabilistic.push(id);
  }

  const room = Math.max(0, maxSpeakers - forced.length);
  const chosen = probabilistic.slice(0, room);
  return uniqueMembers.filter((id) => forced.includes(id) || chosen.includes(id));
}

/** reaction 是否发生（概率 REACTION_CHANCE） */
export function maybeReact(rng: () => number, chance = REACTION_CHANCE): boolean {
  return rng() < clamp(chance, 0, 1);
}

/** 从 emoji 池随机取一个 reaction */
export function pickReactionEmoji(rng: () => number): string {
  const idx = Math.min(REACTION_EMOJIS.length - 1, Math.max(0, Math.floor(rng() * REACTION_EMOJIS.length)));
  return REACTION_EMOJIS[idx] ?? REACTION_EMOJIS[0]!;
}

/** 从 clean 文本中清洗出发言内容（去角色名前缀 / 引号 / 代码块，限 1-2 句） */
export function cleanGroupReply(text: string, speakerName: string): string {
  let t = String(text ?? '').trim();
  if (!t) return '';
  t = t.replace(/```[\s\S]*?```/g, ' ').trim();
  const name = String(speakerName ?? '').trim();
  if (name) {
    const re = new RegExp(`^\\s*(?:\\[|【)?\\s*${escapeRegExp(name)}\\s*(?:\\]|】)?\\s*[:：]\\s*`);
    t = t.replace(re, '');
  }
  t = t.replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/g, '').trim();
  const lines = t
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  t = lines.slice(0, 2).join(' ');
  if (t.length > 200) t = t.slice(0, 200);
  return t.trim();
}

/** 从文本里解析 @ 提及（匹配群成员显示名） */
export function parseMentions(text: string, members: number[]): number[] {
  const t = String(text ?? '');
  if (!t) return [];
  const found: number[] = [];
  for (const id of uniqueIds(members)) {
    const name = companionName(id);
    if (name && t.includes('@' + name)) found.push(id);
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* 公开角色卡（★只取 companions 公开字段，绝不触碰私密记忆/画像★）        */
/* ------------------------------------------------------------------ */
function companionName(id: number): string {
  const row = dbGet<{ name: string }>('SELECT name FROM companions WHERE id = ?', asId(id));
  const name = row?.name ? String(row.name).trim() : '';
  return name || `角色${asId(id)}`;
}

/**
 * 读取一名伴侣的【公开】角色卡。
 * ★只 SELECT companions 的 name/identity/personality_tags/intro 四列★
 * —— 不查 personas.self_story、不查 memories、不查 messages、不查 settings.user_profile。
 */
function publicCardOf(id: number): GroupPublicCard {
  const row =
    dbGet<{ name: string; identity: string | null; personality_tags: string | null; intro: string | null }>(
      'SELECT name, identity, personality_tags, intro FROM companions WHERE id = ?',
      asId(id)
    ) ?? null;
  const name = row?.name ? String(row.name).trim() : `角色${asId(id)}`;
  let tags: string[] = [];
  if (row?.personality_tags) {
    const v = safeJson<unknown>(row.personality_tags, []);
    if (Array.isArray(v)) tags = v.map((x) => String(x)).slice(0, 8);
  }
  return { name: name || `角色${asId(id)}`, identity: row?.identity ?? null, personalityTags: tags, intro: row?.intro ?? null };
}

/* ------------------------------------------------------------------ */
/* buildGroupPrompt（★隐私红线★）                                       */
/* ------------------------------------------------------------------ */
/**
 * 当前发言者「自己」记得的事（她与用户的共同经历摘要）。
 *  ★隐私不变量（三条，缺一不可）：
 *   1. 只读**该发言者自己**作用域下的 memories（`withCompanion(speakerId)`）；
 *   2. 其他成员的任何数据（记忆/关系数值/私聊）绝不进入本 prompt；
 *   3. 群聊**只读不写**——不产生新记忆，避免把群聊内容混进各人的个人记忆库。
 *  用于「女友之间根据各自的记忆聊起来」：她说的是她和你的事，别人只听到她说出口的那句。
 *  v16：类型加入 'shared'（共域记忆，source_group_id 指向共处群）——她们能聊起「上次共处时…」；
 *  不变量依旧：只读该发言者自己的行（withCompanion 作用域），别人的记忆绝不进 prompt。 */
export function memoryLinesFor(speakerId: number, limit = 6): string[] {
  try {
    return withCompanion(speakerId, () =>
      memoriesByType(['fact', 'relationship', 'preference', 'shared'], limit)
        .map((m) => String(m.content || '').trim())
        .filter(Boolean)
        .map((s) => (s.length > 120 ? `${s.slice(0, 120)}…` : s))
    );
  } catch {
    return [];
  }
}

export interface BuildGroupPromptOptions {
  speakerId: number;
  memberIds: number[];
  history: GroupMessageRow[];
  topic?: string | null;
  userName?: string;
  maxHistory?: number;
  /** 本拍被 @ 的成员（角色卡裁剪优先级最高；可选） */
  mentionIds?: number[];
  /** 最近发言者 id（角色卡裁剪优先级；可选） */
  recentSpeakerIds?: number[];
  /**
   * **当前发言者自己**记得的事（她与用户的共同经历摘要）。
   * ★隐私不变量：只允许传该发言者自己作用域下的记忆——其他人的记忆/关系数值
   * 绝不进入 prompt。群聊只读不写（不产生新记忆，避免把群聊内容混进个人记忆库）。
   */
  speakerMemories?: string[];
}

/**
 * 选择「哪些成员展开完整公开角色卡」——人数很多时做**纯上下文裁剪**（不阻塞任何人参与）：
 * 优先级：当前发言人 → 被 @ 的 → 最近发言的（新→旧）→ 名字出现在话题里的 → 其余按成员顺序。
 * 取前 `limit`（默认 {@link GROUP_PROMPT_CARD_LIMIT}）名为「完整角色卡」，其余进「仅列名」。
 */
export function selectPromptMembers(input: {
  memberIds: number[];
  speakerId: number;
  mentionIds?: number[];
  recentSpeakerIds?: number[];
  topic?: string | null;
  limit?: number;
}): { cardIds: number[]; nameOnlyIds: number[] } {
  const members = uniqueIds(input.memberIds);
  const memberSet = new Set(members);
  const limit = clamp(
    Math.trunc(Number(input.limit ?? GROUP_PROMPT_CARD_LIMIT)) || GROUP_PROMPT_CARD_LIMIT,
    1,
    1000
  );
  const ordered: number[] = [];
  const push = (id: number): void => {
    if (id && memberSet.has(id) && !ordered.includes(id)) ordered.push(id);
  };
  push(input.speakerId); // ① 当前发言人（必须完整）
  for (const id of uniqueIds(input.mentionIds ?? [])) push(id); // ② 被 @ 的
  for (const id of uniqueIds(input.recentSpeakerIds ?? []).reverse()) push(id); // ③ 最近发言的（新→旧）
  const topic = String(input.topic ?? '');
  if (topic) {
    for (const id of members) if (topic.includes(companionName(id))) push(id); // ④ 名字出现在话题里
  }
  for (const id of members) push(id); // ⑤ 其余按成员顺序
  const cardIds = ordered.slice(0, limit);
  const cardSet = new Set(cardIds);
  return { cardIds, nameOnlyIds: members.filter((id) => !cardSet.has(id)) };
}

/** 把一条群内历史格式化成一行（reaction 显示为（emoji）） */
export function formatHistoryLine(m: GroupMessageRow): string {
  const who = m.speaker_name || (m.speaker_type === 'user' ? '你' : '系统');
  if (m.speaker_type === 'system') return `— ${m.content}`;
  if (m.speaker_type === 'reaction' || m.reaction) return `${who}：（${m.reaction || m.content}）`;
  return `${who}：${m.content}`;
}

/**
 * 组装群聊的完整 messages（投给同一个 chat()）。
 * 只使用 companions 公开角色卡 + group_messages 群内历史；
 * 群内历史【只】来自 group_messages（各角色私聊 messages 不得进入群上下文）。
 * 人数很多时，仅对优先的至多 {@link GROUP_PROMPT_CARD_LIMIT} 名成员展开完整角色卡，
 * 其余成员只以名单形式出现（`群成员还有：…`）——纯裁剪，不阻塞参与。
 */
export function buildGroupPrompt(opts: BuildGroupPromptOptions): ChatMessage[] {
  const speakerCard = publicCardOf(opts.speakerId);
  const memberIds = uniqueIds(opts.memberIds);
  const { cardIds, nameOnlyIds } = selectPromptMembers({
    memberIds,
    speakerId: opts.speakerId,
    mentionIds: opts.mentionIds,
    recentSpeakerIds: opts.recentSpeakerIds,
    topic: opts.topic ?? null,
  });
  const cards = cardIds.map((id) => publicCardOf(id));

  const sys = buildGroupSystemPrompt({
    speakerName: speakerCard.name,
    memberNames: memberIds.map((id) => companionName(id)),
    topic: opts.topic ?? null,
    cards,
    nameOnlyMembers: nameOnlyIds.map((id) => companionName(id)),
    userName: opts.userName ?? GROUP_USER_LABEL,
    speakerMemories: opts.speakerMemories,
  });

  const history = opts.history.slice(-(opts.maxHistory ?? 16));
  const lines = history.map((m) => formatHistoryLine(m));
  const userMsg = [
    history.length ? `【群内历史】\n${lines.join('\n')}` : '【群内历史】（暂无）',
    '',
    `（现在请你以「${speakerCard.name}」的身份，只说出 ta 这一刻要说的一句话：1-2 句、口语、不带角色名前缀。）`,
  ].join('\n');

  return [
    { role: 'system', content: sys },
    { role: 'user', content: userMsg },
  ];
}

/* ------------------------------------------------------------------ */
/* 群读写                                                              */
/* ------------------------------------------------------------------ */
export function getGroup(groupId: number): GroupRow | null {
  const gid = asId(groupId);
  if (!gid) return null;
  return dbGet<GroupRow>('SELECT * FROM groups WHERE id = ?', gid) ?? null;
}

export function isGirlfriend(id: number): boolean {
  const row = dbGet<{ status: string }>('SELECT status FROM companions WHERE id = ?', asId(id));
  return row?.status === 'girlfriend';
}

export function listMemberIds(groupId: number): number[] {
  const gid = asId(groupId);
  if (!gid) return [];
  return dbAll<{ companion_id: number }>('SELECT companion_id FROM group_members WHERE group_id = ? ORDER BY id ASC', gid)
    .map((r) => asId(r.companion_id))
    .filter((n) => n > 0);
}

export function listMessages(groupId: number, limit = 50): GroupMessageRow[] {
  const gid = asId(groupId);
  if (!gid) return [];
  const n = clamp(Math.trunc(Number(limit)) || 50, 1, 500);
  // 取最近 n 条，再按 id 升序返回（保证时间正序）
  return dbAll<GroupMessageRow>(
    `SELECT * FROM (
       SELECT * FROM group_messages WHERE group_id = ? ORDER BY id DESC LIMIT ?
     ) ORDER BY id ASC`,
    gid,
    n
  );
}

/** 每条群消息插入后都刷新群的 last_message_at / updated_at */
function insertMessage(row: {
  group_id: number;
  companion_id: number | null;
  speaker_type: string;
  speaker_name: string | null;
  content: string;
  reaction: string | null;
  round: number;
  meta?: string | null;
}): GroupMessageRow {
  const now = nowIso();
  const res = dbRun(
    `INSERT INTO group_messages (group_id, companion_id, speaker_type, speaker_name, content, reaction, round, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.group_id,
    row.companion_id,
    row.speaker_type,
    row.speaker_name,
    row.content,
    row.reaction,
    Math.max(0, Math.trunc(Number(row.round)) || 0),
    row.meta ?? null,
    now
  );
  dbRun('UPDATE groups SET last_message_at = ?, updated_at = ? WHERE id = ?', now, now, row.group_id);
  const created = dbGet<GroupMessageRow>('SELECT * FROM group_messages WHERE id = ?', res.lastInsertRowid);
  if (!created) throw new Error('GROUP_MESSAGE_INSERT_FAILED');
  return created;
}

export interface GroupSummary {
  group: GroupRow;
  memberIds: number[];
  memberNames: string[];
  lastMessageId: number;
}

export function listGroups(): GroupSummary[] {
  const groups = dbAll<GroupRow>('SELECT * FROM groups ORDER BY COALESCE(last_message_at, created_at) DESC, id DESC');
  return groups.map((g) => {
    const memberIds = listMemberIds(Number(g.id));
    const lastRow = dbGet<{ m: number | null }>('SELECT MAX(id) AS m FROM group_messages WHERE group_id = ?', Number(g.id));
    return {
      group: g,
      memberIds,
      memberNames: memberIds.map((id) => companionName(id)),
      lastMessageId: Number(lastRow?.m ?? 0),
    };
  });
}

export interface GroupMemberLite {
  id: number;
  name: string;
  avatar_url: string | null;
  identity: string | null;
  age: number;
}

export interface GroupDetail {
  group: GroupRow;
  memberIds: number[];
  members: GroupMemberLite[];
  messages: GroupMessageRow[];
  run: GroupRunRow | null;
}

export function getGroupDetail(groupId: number): GroupDetail | null {
  const group = getGroup(groupId);
  if (!group) return null;
  const gid = Number(group.id);
  const memberIds = listMemberIds(gid);
  const members: GroupMemberLite[] = memberIds.map((id) => {
    const c: CompanionRow | null = getCompanion(id);
    return {
      id,
      name: c?.name ? String(c.name) : `角色${id}`,
      avatar_url: c?.avatar_url ?? null,
      identity: c?.identity ?? null,
      age: Number(c?.age ?? 0),
    };
  });
  return { group, memberIds, members, messages: listMessages(gid, 100), run: getCurrentRun(gid) };
}

/* ------------------------------------------------------------------ */
/* 建群 / 改群 / 解散 / 中止                                            */
/* ------------------------------------------------------------------ */
export interface GroupOpResult {
  ok: boolean;
  code?: string;
  error?: string;
  group?: GroupRow;
}

function validateNewMembers(ids: number[]): { ok: true } | { ok: false; code: string; error: string } {
  const bad = ids.filter((id) => !getCompanion(id));
  if (bad.length) return { ok: false, code: 'COMPANION_NOT_FOUND', error: '有角色不存在' };
  return validateMemberStatuses(ids);
}

/**
 * @deprecated 旧的成员资格错误码（只有 girlfriend 可入群）。资格已放宽为「认识及以上」
 * （status NOT IN ('stranger','closed')）；保留此导出仅为兼容既有引用，勿在新代码中使用。
 */
export const PERMISSION_ONLY_GIRLFRIEND = 'PERMISSION_ONLY_GIRLFRIEND';

/**
 * 成员资格校验（群聊 / 活动共用）：认识及以上即可入群（status NOT IN ('stranger','closed')）。
 * - 陌生人（stranger）→ PERMISSION_NOT_ACQUAINTED（还没认识，不能同群）
 * - 已关闭（closed）→ COMPANION_CLOSED
 * - 其余状态（acquaintance/ambiguous/pursuing/girlfriend/cold/rejected）均放行。
 */
export function validateMemberStatuses(ids: number[]): { ok: true } | { ok: false; code: string; error: string } {
  for (const id of ids) {
    const row = dbGet<{ status: string }>('SELECT status FROM companions WHERE id = ?', asId(id));
    const status = row?.status ?? '';
    if (status === 'stranger') {
      return { ok: false, code: 'PERMISSION_NOT_ACQUAINTED', error: '还没认识的角色不能入群（先认识再说）' };
    }
    if (status === 'closed') {
      return { ok: false, code: 'COMPANION_CLOSED', error: '该角色已关闭，不能入群' };
    }
  }
  return { ok: true };
}

/** 建群：≥2 名【认识及以上】（见 validateMemberStatuses）；人数**无硬上限** */
export function createGroup(name: string, topic: string | null, memberIds: number[]): GroupOpResult {
  const nm = String(name ?? '').trim().slice(0, 30);
  if (!nm) return { ok: false, code: 'INVALID_INPUT', error: '群名不能为空' };
  const ids = uniqueIds(memberIds);
  if (ids.length < GROUP_MIN_MEMBERS) {
    return { ok: false, code: 'INVALID_INPUT', error: `群聊至少需要 ${GROUP_MIN_MEMBERS} 名已晋升女友` };
  }
  const v = validateNewMembers(ids);
  if (!v.ok) return { ok: false, code: v.code, error: v.error };

  const now = nowIso();
  const gid = Number(
    dbRun(
      'INSERT INTO groups (user_id, name, topic, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      DEFAULT_USER_ID,
      nm,
      topic ? String(topic).slice(0, 60) : null,
      'active',
      now,
      now
    ).lastInsertRowid
  );
  for (const id of ids) {
    dbRun('INSERT OR IGNORE INTO group_members (group_id, companion_id, joined_at) VALUES (?, ?, ?)', gid, id, now);
  }
  const group = getGroup(gid);
  return group ? { ok: true, group } : { ok: false, code: 'DB_ERROR', error: '建群失败' };
}

export interface UpdateGroupPatch {
  name?: string;
  topic?: string | null;
  add?: number[];
  remove?: number[];
}

/** 改群名 / 话题 / 增删成员（PATCH）。成员总数下限为 2，**无上限**；新增者必须是已晋升女友。 */
export function updateGroup(groupId: number, patch: UpdateGroupPatch): GroupOpResult {
  const gid = asId(groupId);
  const group = getGroup(gid);
  if (!group) return { ok: false, code: 'GROUP_NOT_FOUND', error: '群不存在' };

  const current = listMemberIds(gid);
  const currentSet = new Set(current);
  const toRemove = uniqueIds(patch.remove ?? []).filter((id) => currentSet.has(id));
  const removeSet = new Set(toRemove);
  const remaining = current.filter((id) => !removeSet.has(id));
  const toAdd = uniqueIds(patch.add ?? []).filter((id) => !currentSet.has(id) && !removeSet.has(id));

  const total = remaining.length + toAdd.length;
  if (total < GROUP_MIN_MEMBERS) {
    return { ok: false, code: 'INVALID_INPUT', error: `群聊至少保留 ${GROUP_MIN_MEMBERS} 名成员` };
  }
  if (toAdd.length) {
    const v = validateNewMembers(toAdd);
    if (!v.ok) return { ok: false, code: v.code, error: v.error };
  }

  const now = nowIso();
  tx(() => {
    if (patch.name !== undefined) {
      const nm = String(patch.name).trim().slice(0, 30);
      if (nm) dbRun('UPDATE groups SET name = ?, updated_at = ? WHERE id = ?', nm, now, gid);
    }
    if (patch.topic !== undefined) {
      dbRun(
        'UPDATE groups SET topic = ?, updated_at = ? WHERE id = ?',
        patch.topic ? String(patch.topic).slice(0, 60) : null,
        now,
        gid
      );
    }
    for (const id of toAdd) {
      dbRun('INSERT OR IGNORE INTO group_members (group_id, companion_id, joined_at) VALUES (?, ?, ?)', gid, id, now);
    }
    for (const id of toRemove) {
      dbRun('DELETE FROM group_members WHERE group_id = ? AND companion_id = ?', gid, id);
    }
    dbRun('UPDATE groups SET updated_at = ? WHERE id = ?', now, gid);
  });

  return { ok: true, group: getGroup(gid) ?? undefined };
}

/** 解散群（连同成员/消息/run 一并清除） */
export function deleteGroup(groupId: number): { ok: boolean; code?: string; error?: string } {
  const gid = asId(groupId);
  const group = getGroup(gid);
  if (!group) return { ok: false, code: 'GROUP_NOT_FOUND', error: '群不存在' };
  tx(() => {
    dbRun('DELETE FROM group_messages WHERE group_id = ?', gid);
    dbRun('DELETE FROM group_runs WHERE group_id = ?', gid);
    dbRun('DELETE FROM group_members WHERE group_id = ?', gid);
    dbRun('DELETE FROM groups WHERE id = ?', gid);
  });
  return { ok: true };
}

/** 中止当前 run（用户点「停止」）：status='cancelled'，随后 planSpeakers 返回空即停止。 */
export function abort(groupId: number): { ok: boolean; code?: string; error?: string; run: GroupRunRow | null } {
  const gid = asId(groupId);
  const group = getGroup(gid);
  if (!group) return { ok: false, code: 'GROUP_NOT_FOUND', error: '群不存在', run: null };
  const run = getCurrentRun(gid);
  if (run) cancelRun(Number(run.id), 'user_abort');
  return { ok: true, run: run ? getRunById(Number(run.id)) : null };
}

/** 开启一个新 run（「继续」/首条消息）。已有 running 的 run 则原样返回。 */
export function startRun(groupId: number, maxRounds = GROUP_MAX_ROUNDS): GroupRunRow | null {
  const gid = asId(groupId);
  if (!getGroup(gid)) return null;
  return getCurrentRun(gid) ?? createRun(gid, { maxRounds });
}

/* ------------------------------------------------------------------ */
/* 关系联动（经 applyDelta → 内部 tx → applyRelationshipDelta 唯一写点）  */
/* ------------------------------------------------------------------ */
function applySocialDelta(a: number, b: number, delta: number, reason: string): void {
  const x = asId(a);
  const y = asId(b);
  if (!x || !y || x === y) return;
  try {
    applyDelta(x, y, delta, reason);
  } catch (e) {
    console.warn('[group] 伴侣关系闭环失败:', errMsg(e));
  }
}

/* ------------------------------------------------------------------ */
/* 群聊回合（发言调度 + 生成 + 收尾 + 中止）                             */
/* ------------------------------------------------------------------ */
export type GroupChatFn = (
  messages: ChatMessage[],
  opts: { maxTokens: number; temperature: number; timeoutMs: number; signal?: AbortSignal }
) => Promise<string>;

export interface GroupTurnOptions {
  /** 显式 @ 提及的 companionId（缺省时由 content 中的 @名字 解析） */
  mentions?: number[];
  /** 注入 RNG（测试确定性） */
  rng?: () => number;
  /** 注入的 chat 实现（缺省用 llm.ts 的 chat()） */
  chatFn?: GroupChatFn;
  /** 中止信号 */
  signal?: AbortSignal;
  /** 每产生一条新消息即时回调（SSE 逐条推送用） */
  onMessage?: (m: GroupMessageRow) => void;
  /** 需要新开 run 时用的轮数上限 */
  maxRounds?: number;
  /** true = 强制新开一个 run（「继续」按钮）；false/缺省 = 若上一轮已结束则报 GROUP_ENDED */
  newRun?: boolean;
  /** 覆盖 now（确定性测试） */
  now?: string;
  /**
   * 仅允许这些 companionId 发言（用于线下「轮流聚焦」等单人对场）：
   * 非空时，本轮发言者**只**从该名单里取（成员存在者），完全绕过 planBeat 的
   * @提及/概率/反三连击逻辑——保证除名单外的人一条都不产出（含 reaction）。
   * 缺省 undefined = 不限制，走 planBeat 的自由发言模型。
   */
  onlySpeakers?: number[];
  /**
   * 逐成员权重乘数（默认 1）——**加权而非独占**。
   * 用于「主导者优先」场景：线下约会把被约对象的概率乘以 FOCUS_BOOST，
   * 让她更容易先开口/接话，但其他人仍按情境自然参与（各说各话）。
   */
  boost?: Record<number, number>;
}

export interface GroupTurnResult {
  ok: boolean;
  code?: string;
  error?: string;
  userMessage?: GroupMessageRow;
  /** 本次产生的新消息（用户 + AI + reaction + system 分隔） */
  messages: GroupMessageRow[];
  run: GroupRunRow | null;
  ended: boolean;
  endedReason?: string | null;
  /** 本轮是否「冷场」：没有任何 AI 产出（正式发言与 reaction 都没有） */
  silent?: boolean;
}

/**
 * 处理一次用户发帖（或「继续」）：
 *   1) 取/建 run；若上一轮已结束且未要求新开 → GROUP_ENDED；
 *   2) 落用户消息；
 *   3) 命中收尾词 → 直接结束并插 system 分隔；
 *   4) 否则按 planBeat（自由发言模型）逐「拍」调度 AI 发言 / reaction，直到达到单轮上限、
 *      轮数上限、收尾或中止；一拍可为 0 人（冷场），连续 2 拍冷场 → 本轮自然结束。
 * 整段应在 withGroupLock(groupId, …) 内调用。
 */
export async function runGroupTurn(groupId: number, text: string, opts: GroupTurnOptions = {}): Promise<GroupTurnResult> {
  const gid = asId(groupId);
  const group = getGroup(gid);
  if (!group) {
    return { ok: false, code: 'GROUP_NOT_FOUND', error: '群不存在', messages: [], run: null, ended: false };
  }
  const members = listMemberIds(gid);
  if (members.length < GROUP_MIN_MEMBERS) {
    return { ok: false, code: 'INVALID_INPUT', error: '群成员不足', messages: [], run: getCurrentRun(gid), ended: false };
  }

  const rng = opts.rng ?? Math.random;
  const chatFn: GroupChatFn =
    opts.chatFn ??
    ((messages, o) =>
      chat(messages, { maxTokens: o.maxTokens, temperature: o.temperature, timeoutMs: o.timeoutMs, signal: o.signal }));

  const emitted: GroupMessageRow[] = [];
  const emit = (m: GroupMessageRow): void => {
    emitted.push(m);
    try {
      opts.onMessage?.(m);
    } catch {
      /* 回调异常不影响引擎 */
    }
  };

  // ---- 取/建 run ----
  let run = getCurrentRun(gid);
  if (!run) {
    const last = getLastRun(gid);
    if (last && (last.status === 'ended' || last.status === 'cancelled') && !opts.newRun) {
      return {
        ok: false,
        code: 'GROUP_ENDED',
        error: '本群聊已结束，点「继续」开启新一轮',
        messages: [],
        run: last,
        ended: true,
        endedReason: last.ended_reason,
      };
    }
    run = createRun(gid, { maxRounds: opts.maxRounds, now: opts.now });
  }
  if (run.status !== 'running') {
    return { ok: false, code: 'GROUP_ENDED', error: '本群聊已结束', messages: [], run, ended: true, endedReason: run.ended_reason };
  }

  const cleanText = String(text ?? '').trim().slice(0, 1000);
  const userName = GROUP_USER_LABEL;

  // ---- 落用户消息 ----
  let userMessage: GroupMessageRow | undefined;
  if (cleanText) {
    userMessage = insertMessage({
      group_id: gid,
      companion_id: null,
      speaker_type: 'user',
      speaker_name: userName,
      content: cleanText,
      reaction: null,
      round: run.round,
    });
    emit(userMessage);
  }

  const mentions = opts.mentions && opts.mentions.length ? uniqueIds(opts.mentions) : parseMentions(cleanText, members);

  // ---- 命中收尾词 → 立即结束 ----
  if (cleanText && hitsEndPhrase(cleanText)) {
    endRun(Number(run.id), 'farewell');
    const sep = insertMessage({
      group_id: gid,
      companion_id: null,
      speaker_type: 'system',
      speaker_name: null,
      content: `群聊结束 · 共 ${run.round} 轮`,
      reaction: null,
      round: run.round,
      meta: JSON.stringify({ reason: '自然收尾' }),
    });
    emit(sep);
    return {
      ok: true,
      userMessage,
      messages: emitted,
      run: getRunById(Number(run.id)),
      ended: true,
      endedReason: 'farewell',
      silent: false,
    };
  }

  // ---- 生成 AI 发言 ----
  let endedReason: string | null = null;
  let endByPhrase = false;
  let roundsThisTurn = 0;
  let utterancesThisTurn = 0;
  let prevSpeaker: number | null = readRecentSpeakers(run).slice(-1)[0] ?? null;
  let guard = 0;
  // 自由发言模型：允许一拍 0 人开口（冷场）；连续 2 拍冷场 → 本轮自然结束
  let silentBeats = 0;
  let prevSilent = false;
  let producedAi = 0;
  let recentText = cleanText;

  while (guard++ < 100) {
    if (opts.signal?.aborted) break;
    const fresh = getRunById(Number(run.id));
    if (!fresh || fresh.status !== 'running') {
      endedReason = fresh ? fresh.ended_reason : endedReason;
      break;
    }
    if (fresh.round >= fresh.max_rounds) {
      endedReason = 'max_rounds';
      break;
    }
    if (totalSpokeCount(fresh) >= MAX_LLM_CALLS_PER_RUN) {
      endedReason = 'call_limit';
      break;
    }
    if (roundsThisTurn >= MAX_ROUNDS_PER_TURN) break;
    if (utterancesThisTurn >= MAX_UTTERANCES_PER_TURN) break;

    const speakers =
      opts.onlySpeakers && opts.onlySpeakers.length
        ? uniqueIds(opts.onlySpeakers).filter((id) => members.includes(id))
        : planBeat(fresh, members, {
            rng,
            mentions: roundsThisTurn === 0 ? mentions : [],
            maxSpeakers: GROUP_BEAT_MAX_SPEAKERS,
            prevSilent,
            lastText: recentText,
            boost: opts.boost,
            // run 的第一拍整体升温：刚聚起来的场子总得有人先开口，避免「建群即冷场」的糟糕体验。
            // （@ 强制不受影响；冷场升温机制在后续拍继续兜底。）
            temperature: fresh.round === 0 ? 1.5 : 1.0,
          });

    // 一拍 0 人开口 → 本拍不产出任何消息（这就是「谁想接话谁接、可以没人接」）
    if (!speakers.length) {
      silentBeats++;
      prevSilent = true;
      if (silentBeats >= MAX_SILENT_BEATS) break; // 连续 2 拍冷场 → 本轮自然结束
      continue;
    }
    prevSilent = false;

    let emittedThisBeat = 0;
    for (const sp of speakers) {
      if (opts.signal?.aborted) break;
      const cur = getRunById(Number(run.id));
      if (!cur || cur.status !== 'running') break;
      if (utterancesThisTurn >= MAX_UTTERANCES_PER_TURN) break;

      // —— reaction 代替发言（只看不说）——
      if (maybeReact(rng)) {
        const emoji = pickReactionEmoji(rng);
        const msg = insertMessage({
          group_id: gid,
          companion_id: sp,
          speaker_type: 'reaction',
          speaker_name: companionName(sp),
          content: emoji,
          reaction: emoji,
          round: cur.round + 1,
        });
        emit(msg);
        emittedThisBeat++;
        producedAi++;
        recentText = msg.content;
        if (prevSpeaker && prevSpeaker !== sp) applySocialDelta(sp, prevSpeaker, 1, '群聊 reaction');
        continue;
      }

      // —— 正式发言（LLM）——
      try {
        const history = listMessages(gid, 20);
        const msgs = buildGroupPrompt({
          speakerId: sp,
          memberIds: members,
          history,
          topic: group.topic,
          userName,
          mentionIds: roundsThisTurn === 0 ? mentions : [],
          recentSpeakerIds: readRecentSpeakers(cur),
          // 她「自己」记得的事（只有她自己的记忆进上下文；群聊只读不写）
          speakerMemories: memoryLinesFor(sp),
        });
        const raw = await chatFn(msgs, {
          maxTokens: GROUP_MAX_TOKENS,
          temperature: 0.95,
          timeoutMs: GROUP_CALL_TIMEOUT_MS,
          signal: opts.signal,
        });
        if (opts.signal?.aborted) break;
        const content = cleanGroupReply(cleanContent(raw), companionName(sp));
        if (!content) continue;

        const msg = insertMessage({
          group_id: gid,
          companion_id: sp,
          speaker_type: 'companion',
          speaker_name: companionName(sp),
          content,
          reaction: null,
          round: cur.round + 1,
        });
        emit(msg);
        emittedThisBeat++;
        producedAi++;
        utterancesThisTurn++;
        recentText = content;

        // 更新调度状态：recent_speakers（追加）+ spoke_counts（+1）+ last_speaker_id
        const recent = readRecentSpeakers(cur);
        recent.push(sp);
        const counts = readSpokeCounts(cur);
        counts[sp] = (counts[sp] ?? 0) + 1;
        updateScheduling(Number(cur.id), { lastSpeakerId: sp, recentSpeakers: recent, spokeCounts: counts });

        if (prevSpeaker && prevSpeaker !== sp) applySocialDelta(sp, prevSpeaker, 2, '群聊回应');
        prevSpeaker = sp;

        if (hitsEndPhrase(content)) {
          endByPhrase = true;
          break;
        }
      } catch (e) {
        console.warn('[group] 生成失败:', errMsg(e));
        break;
      }
    }

    // 选了人却没有任何产出（LLM 空 / 被中止）→ 视作一拍冷场，避免空转
    if (!emittedThisBeat) {
      silentBeats++;
      prevSilent = true;
      if (silentBeats >= MAX_SILENT_BEATS) break;
      continue;
    }
    silentBeats = 0;

    // 推进一步轮次
    const after = getRunById(Number(run.id));
    if (!after || after.status !== 'running') {
      endedReason = after ? after.ended_reason : endedReason;
      break;
    }
    const nextRound = after.round + 1;
    updateScheduling(Number(after.id), { round: nextRound });
    roundsThisTurn++;

    if (nextRound >= after.max_rounds) {
      endedReason = 'max_rounds';
      break;
    }
    if (endByPhrase) {
      endedReason = 'farewell';
      break;
    }
    if (utterancesThisTurn >= MAX_UTTERANCES_PER_TURN) break;
  }

  // ---- 收尾：结束 run + 插 system 分隔（中止/已结束则不补分隔）----
  const finalRun = getRunById(Number(run.id));
  let ended = false;
  if (finalRun && finalRun.status === 'running' && endedReason) {
    endRun(Number(finalRun.id), endedReason);
    const reasonText = endedReason === 'farewell' ? '自然收尾' : endedReason === 'max_rounds' ? '达到轮数上限' : endedReason;
    const sep = insertMessage({
      group_id: gid,
      companion_id: null,
      speaker_type: 'system',
      speaker_name: null,
      content: `群聊结束 · 共 ${finalRun.round} 轮`,
      reaction: null,
      round: finalRun.round,
      meta: JSON.stringify({ reason: reasonText }),
    });
    emit(sep);
    ended = true;
  } else if (finalRun && (finalRun.status === 'ended' || finalRun.status === 'cancelled')) {
    ended = true;
  }

  const latest = getRunById(Number(run.id));
  return {
    ok: true,
    userMessage,
    messages: emitted,
    run: latest,
    ended,
    endedReason: latest?.ended_reason ?? endedReason,
    silent: producedAi === 0,
  };
}

/* ------------------------------------------------------------------ */
/* 共域记忆（v16 同场感知）                                             */
/* ------------------------------------------------------------------ */
/**
 * 为群内**每个成员**各写一条「自己视角」的共处记忆（type='shared'，source_group_id=群 id）。
 *
 * ★隔离保证★：每人一行、`companion_id` 各自（经 withCompanion 作用域 + cRun 注入），
 * 内容模板相同但归属互斥——任何其他成员的记忆行都绝不包含她人私域记忆。
 *
 * ★幂等取舍（有意为之，简单够用）★：**每群每人只写一条**。写入前检查该成员是否已有
 * `source_group_id=gid` 的记忆行，有则跳过；内容取「截至本次调用时」的群消息摘要。
 * 不做「每满 12 条消息自动续写」——那需要记录消息水位（key 膨胀/重复累积两难），
 * 而共处记忆的价值在「记得有过这段共处」，不在完整流水。触发点：endPresenceGroup 必写、
 * 手动（API）可触发；重复调用零副作用。
 *
 * 摘要为**确定性统计**（不调 LLM）：用户发言句数、成员互动次数、最近一条用户消息前 60 字。
 */
export function writeSharedMemories(groupId: number): number {
  const gid = asId(groupId);
  if (!gid) return 0;
  const members = listMemberIds(gid);
  if (members.length < 1) return 0;

  const msgs = listMessages(gid, 120);
  const userSaid = msgs.filter((m) => m.speaker_type === 'user').length;
  const interacted = msgs.filter((m) => m.speaker_type === 'companion' || m.speaker_type === 'reaction').length;
  const lastUser = [...msgs].reverse().find((m) => m.speaker_type === 'user');
  const lastText = lastUser ? String(lastUser.content || '').trim().slice(0, 60) : '（还没聊到什么）';
  const memberNames = members.map((id) => companionName(id));

  let written = 0;
  const now = nowIso();
  for (const memberId of members) {
    withCompanion(memberId, () => {
      // 幂等：该成员已有本群的共域记忆 → 跳过（每群每人只写一条）
      const exists = cGet<{ id: number }>('SELECT id FROM memories WHERE companion_id = ? AND source_group_id = ?', gid);
      if (exists) return;
      // 自己视角：列「其他人」的名字（不含自己）
      const others = memberNames.filter((n, i) => members[i] !== memberId).map((n) => `「${n}」`).join('');
      const content =
        `【共处】和${others || '大家'}在一起的时候：你说 ${userSaid} 句、她们互动 ${interacted} 次；` +
        `最近聊到：${lastText}`;
      cRun(
        `INSERT INTO memories (companion_id, user_id, type, content, importance, status, source_group_id, created_at, access_count)
         VALUES (?, ?, 'shared', ?, 6, 'active', ?, ?, 0)`,
        DEFAULT_USER_ID,
        content,
        gid,
        now
      );
      written++;
    });
  }
  return written;
}

/* ------------------------------------------------------------------ */
/* 错误码 → HTTP 状态（沿用既有 { error } 风格）                         */
/* ------------------------------------------------------------------ */
export function groupHttpStatus(code: string | undefined): number {
  switch (code) {
    case 'GROUP_NOT_FOUND':
      return 404;
    case 'COMPANION_NOT_FOUND':
      return 404;
    case 'PERMISSION_ONLY_GIRLFRIEND': // deprecated 资格码，保留映射以兼容旧调用方
      return 403;
    case 'PERMISSION_NOT_ACQUAINTED':
      return 400;
    case 'COMPANION_CLOSED':
      return 410;
    case 'GROUP_ENDED':
    case 'GROUP_MEMBER_LIMIT':
      return 409;
    default:
      return 400;
  }
}

export { withGroupLock, GROUP_MAX_ROUNDS };
