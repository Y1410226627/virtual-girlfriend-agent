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
import { dbAll, dbGet, dbRun, tx, DEFAULT_USER_ID } from './db';
import { nowIso, clamp, safeJson, errMsg } from './utils';
import { chat, cleanContent, type ChatMessage } from './llm';
import { applyDelta } from './companion-relations';
import { getCompanion } from './companion';
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
/** 群成员上限（常量，对齐架构 §7） */
export const GROUP_MAX_MEMBERS = 6;
/** 群成员下限（群聊至少两人） */
export const GROUP_MIN_MEMBERS = 2;
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
export interface BuildGroupPromptOptions {
  speakerId: number;
  memberIds: number[];
  history: GroupMessageRow[];
  topic?: string | null;
  userName?: string;
  maxHistory?: number;
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
 */
export function buildGroupPrompt(opts: BuildGroupPromptOptions): ChatMessage[] {
  const speakerCard = publicCardOf(opts.speakerId);
  const memberIds = uniqueIds(opts.memberIds);
  const cards = memberIds.map((id) => publicCardOf(id));

  const sys = buildGroupSystemPrompt({
    speakerName: speakerCard.name,
    memberNames: cards.map((c) => c.name),
    topic: opts.topic ?? null,
    cards,
    userName: opts.userName ?? GROUP_USER_LABEL,
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
  const notGf = ids.filter((id) => !isGirlfriend(id));
  if (notGf.length) return { ok: false, code: 'PERMISSION_ONLY_GIRLFRIEND', error: '只有已晋升为女友的角色才能入群' };
  return { ok: true };
}

/** 建群：2–6 名【已晋升女友】；非 girlfriend → PERMISSION_ONLY_GIRLFRIEND；>6 → GROUP_MEMBER_LIMIT */
export function createGroup(name: string, topic: string | null, memberIds: number[]): GroupOpResult {
  const nm = String(name ?? '').trim().slice(0, 30);
  if (!nm) return { ok: false, code: 'INVALID_INPUT', error: '群名不能为空' };
  const ids = uniqueIds(memberIds);
  if (ids.length < GROUP_MIN_MEMBERS) {
    return { ok: false, code: 'INVALID_INPUT', error: `群聊至少需要 ${GROUP_MIN_MEMBERS} 名已晋升女友` };
  }
  if (ids.length > GROUP_MAX_MEMBERS) {
    return { ok: false, code: 'GROUP_MEMBER_LIMIT', error: `群成员最多 ${GROUP_MAX_MEMBERS} 名` };
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

/** 改群名 / 话题 / 增删成员（PATCH）。成员总数须落在 [2, 6]；新增者必须是已晋升女友。 */
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
  if (total > GROUP_MAX_MEMBERS) {
    return { ok: false, code: 'GROUP_MEMBER_LIMIT', error: `群成员最多 ${GROUP_MAX_MEMBERS} 名` };
  }
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
   * 非空时，本轮发言者**只**从该名单里取（成员存在者），完全绕过 planSpeakers 的
   * @提及/轮转/反三连击逻辑——保证除名单外的人一条都不产出（含 reaction）。
   * 缺省 undefined = 不限制，既有群聊多角色调度行为零变化。
   */
  onlySpeakers?: number[];
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
}

/**
 * 处理一次用户发帖（或「继续」）：
 *   1) 取/建 run；若上一轮已结束且未要求新开 → GROUP_ENDED；
 *   2) 落用户消息；
 *   3) 命中收尾词 → 直接结束并插 system 分隔；
 *   4) 否则按 planSpeakers 调度，逐条生成 AI 发言 / reaction，直到达到单轮上限、轮数上限、收尾或中止。
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
    };
  }

  // ---- 生成 AI 发言 ----
  let endedReason: string | null = null;
  let endByPhrase = false;
  let roundsThisTurn = 0;
  let utterancesThisTurn = 0;
  let prevSpeaker: number | null = readRecentSpeakers(run).slice(-1)[0] ?? null;
  let guard = 0;

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
        : planSpeakers(fresh, members, {
            rng,
            mentions: roundsThisTurn === 0 ? mentions : [],
            maxSpeakers: 2,
          });
    if (!speakers.length) break;

    let emittedThisRound = 0;
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
        emittedThisRound++;
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
        emittedThisRound++;
        utterancesThisTurn++;

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

    if (!emittedThisRound) break; // 本轮无任何产出 → 停止，避免空转

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
  };
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
    case 'PERMISSION_ONLY_GIRLFRIEND':
      return 403;
    case 'GROUP_ENDED':
    case 'GROUP_MEMBER_LIMIT':
      return 409;
    default:
      return 400;
  }
}

export { withGroupLock, GROUP_MAX_ROUNDS };
