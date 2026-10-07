// 候选人生成器（T03）：LLM 生成 + 模板兜底。
//
// 设计要点（对齐架构 §3.2 / §7）：
// - 候选生成与行为 RNG 均可复现：统一由 gen_seed 派生的确定性 RNG（mulberry32）驱动；
//   调用方可显式注入 rng / seed（测试用），保证同一 seed 产出同样的候选人。
// - 去重：dedupe_hash = sha1(normalize(name) + '|' + normalize(identity) + '|' + normalize(portrait_desc))，
//   唯一索引 idx_companions_dedupe 兜底，同名同身份不会重复生成。
// - 待处理上限 MAX_PENDING_CANDIDATES = 3（发现区同时最多 3 个待处理候选人）。
// - 18+ 红线：应用层校验（< 18 直接拒绝，错误码 AGE_RESTRICTED）+ DB 层 CHECK(age >= 18) 双拦。
// - 离线可用：未配置模型 / 模型失败 → 模板兜底，始终能产出一名成年候选人。
import { createHash } from 'node:crypto';
import { dbAll, dbGet, dbRun, llmConfig, DEFAULT_USER_ID, getCounter, setCounter } from './db';
import { withCompanion, ck } from './companion-context';
import { getCast } from './life-shared';
import { nowIso } from './utils';
import { chatJson, type ChatMessage } from './llm';
import type { CompanionRow } from './types';

/** 发现区「软」上限：**只作 UI 分页/折叠提示，不再阻塞生成**（需求：女友数量无上限）。 */
export const PENDING_SOFT_LIMIT = 20;
/** @deprecated 语义已改为软上限（不再阻塞生成）；保留导出仅为兼容既有引用。 */
export const MAX_PENDING_CANDIDATES = PENDING_SOFT_LIMIT;
/** ★18+ 硬红线：任何伴侣角色的最小年龄（应用层 + DB 层双重拦截） */
export const AGE_MIN = 18;
/** 自动识别：cast 成员在近期消息里被提及达到该次数，即自动浮现为候选人 */
export const CAST_MENTION_THRESHOLD = 2;
/** 自动识别：扫描最近多少条消息 */
export const CAST_MENTION_LOOKBACK = 200;

/** 模板兜底的用词池（去性别化、成年、非情色化，符合内容边界） */
const NAME_POOL = [
  '林知夏', '苏晚', '顾清和', '江疏影', '许南', '温以宁', '沈酌', '陆知遥', '白露', '夏未央',
  '周念', '叶蓁', '宋予', '程澄', '许星野',
];
const IDENTITY_POOL = [
  '独立书店店员', '插画师', '法医助理', '甜品店主理人', '古典乐手', '儿科护士',
  '建筑设计师', '植物学研究生', '纪录片剪辑师', '咖啡师', '陶艺工作室主理人', '气象台研究员',
];
const TAG_POOL = [
  '文静', '慢热', '爱读书', '爱笑', '理性', '感性', '独立', '温柔', '元气', '细心', '浪漫', '毒舌',
  '爱运动', '宅', '动手能力强', '有点社恐',
];
const SCENE_POOL = [
  '在书店的转角擦肩而过', '雨天共撑一把伞', '朋友聚会上被介绍认识', '同一家咖啡馆的常客',
  '深夜电台的一条留言', '一次线上兴趣小组里聊了起来', '宠物医院门口同时蹲下来逗猫', '楼道里帮对方捡起散落的书',
];
const PORTRAIT_POOL = [
  '黑色长直发，安静的气质，常穿米色针织衫',
  '短发利落，笑起来有酒窝，爱穿牛仔外套',
  '微卷的棕色长发，戴细边眼镜，习惯抱着一本纸质书',
  '齐肩发扎成低马尾，穿浅灰卫衣，手上沾着颜料',
  '黑发挽成丸子头，素颜，喜欢宽松的亚麻衬衫',
  '长发及腰，神情清冷，脖颈上挂着一条细银链',
];
const INTRO_POOL = [
  '话不多，但记得住别人随口提过的每一个细节。',
  '看着冷淡，熟了之后是个爱分享奇怪冷知识的人。',
  '习惯把想说的话先在心里过一遍，再慢慢讲出来。',
  '对喜欢的事会钻得很深，聊起来眼睛是亮的。',
  '不太会主动，但被人认真对待时会悄悄记很久。',
];

/** 候选草稿（尚未落库的结构化角色卡） */
export interface CandidateDraft {
  name: string;
  age: number;
  gender: string;
  identity: string | null;
  personality_tags: string[];
  portrait_desc: string | null;
  intro: string | null;
  first_meet_scene: string | null;
  gen_seed: string;
}

export interface GenerateOptions {
  /** 固定种子（可复现）；缺省时按当前时间生成 */
  seed?: string;
  /** 注入的 RNG（返回 [0,1)）；缺省由 seed 派生 */
  rng?: () => number;
  /** 强制走模板兜底（离线测试用） */
  forceTemplate?: boolean;
  /** 覆盖 now（确定性测试用） */
  now?: string;
}

export type GenerateResult =
  | { ok: true; row: CompanionRow; draft: CandidateDraft; source: 'llm' | 'template' }
  | { ok: false; code: string; error: string; existingId?: number };

/** 文本归一化：小写、去首尾与多余空白 */
export function normalizeText(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** 去重哈希：sha1(normalize(name)+'|'+normalize(identity)+'|'+normalize(portrait_desc)) */
export function dedupeHash(name: unknown, identity: unknown, portraitDesc: unknown): string {
  const payload = `${normalizeText(name)}|${normalizeText(identity)}|${normalizeText(portraitDesc)}`;
  return createHash('sha1').update(payload, 'utf8').digest('hex');
}

/** 把种子串散列成 32 位无符号整数（供 mulberry32 使用） */
function seedToInt(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 确定性 PRNG（mulberry32）：同一种子给出同一序列，便于单测复现 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(pool: readonly T[], rng: () => number): T {
  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
  return pool[idx] ?? pool[0]!;
}

/** 模板兜底：确定性生成一名成年候选人（同一 seed + rng 结果一致） */
export function templateDraft(rng: () => number, seed: string): CandidateDraft {
  const tagCount = 2 + Math.floor(rng() * 3); // 2..4 个标签
  const tags: string[] = [];
  while (tags.length < tagCount) {
    const t = pick(TAG_POOL, rng);
    if (!tags.includes(t)) tags.push(t);
  }
  const age = 20 + Math.floor(rng() * 10); // 20..29，恒 >= 18
  return {
    name: pick(NAME_POOL, rng),
    age,
    gender: 'female',
    identity: pick(IDENTITY_POOL, rng),
    personality_tags: tags,
    portrait_desc: pick(PORTRAIT_POOL, rng),
    intro: pick(INTRO_POOL, rng),
    first_meet_scene: pick(SCENE_POOL, rng),
    gen_seed: seed,
  };
}

/** 让她「认识」这名候选人前的 LLM 草稿；未配置模型 / 失败 / 年龄不合规 → null（交给模板兜底） */
async function tryLlmDraft(seed: string): Promise<CandidateDraft | null> {
  const cfg = llmConfig();
  if (!cfg.baseUrl) return null; // 未配置模型：离线直接用模板
  try {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          '你是一个恋爱模拟游戏的角色设计师。请设计一个全新的、与用户尚未相识的成年女性角色。' +
          '角色必须年满 18 岁。只输出一个 JSON 对象，不要解释、不要 markdown。',
      },
      {
        role: 'user',
        content:
          `随机种子 ${seed}。请输出 JSON：` +
          '{"name":"中文姓名","age":数字(必须>=18且<=40),"identity":"身份或职业",' +
          '"personality_tags":["标签1","标签2"],"portrait_desc":"一句话立绘描述",' +
          '"intro":"一段简短介绍","first_meet_scene":"初见场景"}',
      },
    ];
    const j = await chatJson<Record<string, unknown>>(messages, { maxTokens: 700, temperature: 0.9 });
    if (!j || typeof j !== 'object') return null;
    const age = Math.trunc(Number(j.age));
    if (!Number.isFinite(age) || age < AGE_MIN) return null; // 不合规 → 模板兜底
    const name = String(j.name ?? '').trim();
    if (!name) return null;
    return {
      name,
      age,
      gender: 'female',
      identity: j.identity ? String(j.identity) : null,
      personality_tags: Array.isArray(j.personality_tags) ? j.personality_tags.map(String).slice(0, 8) : [],
      portrait_desc: j.portrait_desc ? String(j.portrait_desc) : null,
      intro: j.intro ? String(j.intro) : null,
      first_meet_scene: j.first_meet_scene ? String(j.first_meet_scene) : null,
      gen_seed: seed,
    };
  } catch {
    return null;
  }
}

/** 当前待处理候选人数（发现区，全库统计；companions 是全局表） */
export function countPendingCandidates(): number {
  const row = dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM companions WHERE pending = 1');
  return Number(row?.c ?? 0);
}

/** 按去重哈希查已存在的候选人 */
export function findByDedupeHash(hash: string): CompanionRow | null {
  return dbGet<CompanionRow>('SELECT * FROM companions WHERE dedupe_hash = ?', hash) ?? null;
}

/** 候选人来历（写入 companions.origin_kind / origin_companion_id） */
export interface OriginInfo {
  /** 'cast'=她的室友/同事/朋友等身边人升格；'auto'=交往中被自动识别；'random'=陌生人 */
  kind: 'cast' | 'auto' | 'random';
  /** 通过哪位伴侣认识（cast/auto 时有值） */
  companionId: number | null;
  /** 认识方式的自然语言描述（写进 companion_events 与 first_meet_scene 兜底） */
  sceneHint?: string | null;
}

/** 落库一名候选人（两条来源共用）：18+ 校验 → 去重 → INSERT → 事件流水 */
function persistCandidate(
  draft: CandidateDraft,
  origin: OriginInfo,
  now: string,
  source: 'llm' | 'template'
): GenerateResult {
  // 应用层 18+ 校验（双拦之一；另一层是 DB 的 CHECK(age>=18)）
  const age = Math.trunc(Number(draft.age));
  if (!Number.isFinite(age) || age < AGE_MIN) {
    return { ok: false, code: 'AGE_RESTRICTED', error: '候选人必须年满 18 岁' };
  }

  const name = String(draft.name ?? '').trim().slice(0, 24);
  if (!name) return { ok: false, code: 'INVALID_INPUT', error: '候选人缺少名字' };
  const identity = draft.identity ? String(draft.identity).slice(0, 60) : null;
  const portrait = draft.portrait_desc ? String(draft.portrait_desc).slice(0, 300) : null;
  const hash = dedupeHash(name, identity, portrait);

  const dup = findByDedupeHash(hash);
  if (dup) {
    return { ok: false, code: 'DUPLICATE', error: '同名同身份的候选人已存在', existingId: Number(dup.id) };
  }

  const tags = Array.isArray(draft.personality_tags)
    ? draft.personality_tags.slice(0, 8).map((t) => String(t).slice(0, 12))
    : [];

  const res = dbRun(
    `INSERT INTO companions
       (user_id, name, age, gender, identity, personality_tags, portrait_desc, intro, first_meet_scene,
        gen_seed, dedupe_hash, status, attraction, is_primary, is_discovered, pending, pursue_opt_in,
        reject_count, origin_kind, origin_companion_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stranger', 0, 0, 0, 1, 0, 0, ?, ?, ?, ?)`,
    DEFAULT_USER_ID, // user_id（全局用户引用，恒为 1）
    name,
    age,
    'female',
    identity,
    JSON.stringify(tags),
    portrait,
    draft.intro ? String(draft.intro).slice(0, 400) : null,
    draft.first_meet_scene ? String(draft.first_meet_scene).slice(0, 160) : null,
    draft.gen_seed,
    hash,
    origin.kind,
    origin.companionId,
    now,
    now
  );
  const id = Number(res.lastInsertRowid);
  const row = dbGet<CompanionRow>('SELECT * FROM companions WHERE id = ?', id);
  if (!row) return { ok: false, code: 'DB_ERROR', error: '候选人写入失败' };

  const summary =
    origin.kind === 'random'
      ? `发现一名潜在伴侣：${name}`
      : origin.kind === 'cast'
        ? `通过${origin.sceneHint || '她'}认识了${name}`
        : `交往中注意到的人：${name}`;
  dbRun(
    `INSERT INTO companion_events (user_id, companion_id, kind, summary, new_value, created_at)
     VALUES (?, ?, 'discover', ?, ?, ?)`,
    DEFAULT_USER_ID,
    id,
    summary,
    JSON.stringify({ name, identity, age, origin: origin.kind, from_companion_id: origin.companionId }),
    now
  );

  return {
    ok: true,
    row,
    draft: { ...draft, name, age, identity, portrait_desc: portrait, personality_tags: tags },
    source,
  };
}

/** 生成一名陌生人候选人并落库（pending=1、is_discovered=0）；返回结果对象（不抛错）
 *  注意：**不再有数量上限**——待处理候选人可无限累积（UI 侧分页/折叠）。 */
export async function generateCandidate(opts: GenerateOptions = {}): Promise<GenerateResult> {
  const seed = opts.seed && opts.seed.trim() ? opts.seed.trim() : `seed-${Date.now().toString(36)}`;
  const rng = opts.rng ?? mulberry32(seedToInt(seed));

  let draft: CandidateDraft | null = null;
  let source: 'llm' | 'template' = 'template';
  if (!opts.forceTemplate) {
    draft = await tryLlmDraft(seed);
    if (draft) source = 'llm';
  }
  if (!draft) {
    draft = templateDraft(rng, seed);
    source = 'template';
  }

  return persistCandidate(draft, { kind: 'random', companionId: null }, opts.now ?? nowIso(), source);
}

/* ------------------------------------------------------------------ */
/* 候选人来源②：她身边的人（cast）升格                                  */
/* ------------------------------------------------------------------ */

/** 一名「她身边的人」（来自 shared_world.cast_json 的 {name, role, note}） */
export interface CastOriginInput {
  name: string;
  /** 关系角色：室友 / 同事 / 闺蜜 / 大学同学 / 表妹 … */
  role: string;
  /** 备注（性格、近况等自由文本） */
  note: string;
}

/** cast 升格时的模板兜底：年龄 20-29（恒 ≥18），标签/立绘/介绍按角色气质抽取 */
export function castTemplateDraft(
  member: CastOriginInput,
  rng: () => number,
  seed: string,
  ownerName: string
): CandidateDraft {
  const tagCount = 2 + Math.floor(rng() * 2); // 2..3 个标签
  const tags: string[] = [];
  while (tags.length < tagCount) {
    const t = pick(TAG_POOL, rng);
    if (!tags.includes(t)) tags.push(t);
  }
  const role = String(member.role || '朋友').trim().slice(0, 20);
  return {
    name: String(member.name).trim().slice(0, 24),
    age: 20 + Math.floor(rng() * 10),
    gender: 'female',
    identity: role,
    personality_tags: tags,
    portrait_desc: pick(PORTRAIT_POOL, rng),
    intro: String(member.note || '').trim().slice(0, 300) || pick(INTRO_POOL, rng),
    first_meet_scene: `在${ownerName}那里，你见到了她的${role}`,
    gen_seed: seed,
  };
}

/** 让模型按「她身边的人」润色角色卡（立绘/标签/介绍）；未配置模型 / 失败 / 年龄不合规 → null（模板兜底） */
async function tryLlmCastDraft(member: CastOriginInput, seed: string, ownerName: string): Promise<CandidateDraft | null> {
  const cfg = llmConfig();
  if (!cfg.baseUrl) return null;
  try {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          `你是一个恋爱模拟游戏的角色设计师。用户正在和「${ownerName}」交往，` +
          `现在用户遇到了${ownerName}身边的人：${member.name}（${member.role}）。` +
          '请把这个已经存在的熟人补全成一张完整角色卡（不要改名字、不要改关系角色）。' +
          '角色必须年满 18 岁。只输出一个 JSON 对象，不要解释、不要 markdown。',
      },
      {
        role: 'user',
        content:
          `随机种子 ${seed}。已知备注：${member.note || '（无）'}。请输出 JSON：` +
          '{"age":数字(必须>=18且<=40),"personality_tags":["标签1","标签2"],' +
          '"portrait_desc":"一句话立绘描述","intro":"一段简短介绍"}',
      },
    ];
    const j = await chatJson<Record<string, unknown>>(messages, { maxTokens: 600, temperature: 0.85 });
    if (!j || typeof j !== 'object') return null;
    const age = Math.trunc(Number(j.age));
    if (!Number.isFinite(age) || age < AGE_MIN) return null;
    const role = String(member.role || '朋友').trim().slice(0, 20);
    return {
      name: String(member.name).trim().slice(0, 24),
      age,
      gender: 'female',
      identity: role,
      personality_tags: Array.isArray(j.personality_tags) ? j.personality_tags.map(String).slice(0, 8) : [],
      portrait_desc: j.portrait_desc ? String(j.portrait_desc) : null,
      intro: j.intro ? String(j.intro).slice(0, 300) : String(member.note || '').slice(0, 300) || null,
      first_meet_scene: `在${ownerName}那里，你见到了她的${role}`,
      gen_seed: seed,
    };
  } catch {
    return null;
  }
}

/** 由「她身边的人」生成一名候选人（cast 升格）。
 *  - 名字与关系角色来自 cast，不会改名；立绘/标签/年龄由模型润色（失败则模板兜底）；
 *  - 记录 `origin_kind='cast'|'auto'` 与 `origin_companion_id`（谁介绍），供关系网初始化；
 *  - 与陌生人共用去重与 18+ 双拦。 */
export async function generateCandidateFromCast(
  ownerCompanionId: number,
  member: CastOriginInput,
  opts: GenerateOptions & { ownerName?: string; kind?: 'cast' | 'auto' } = {}
): Promise<GenerateResult> {
  const name = String(member?.name ?? '').trim();
  if (!name) return { ok: false, code: 'INVALID_INPUT', error: '她身边的人缺少名字' };
  const kind = opts.kind === 'auto' ? 'auto' : 'cast';
  const seed = opts.seed && opts.seed.trim() ? opts.seed.trim() : `${kind}:${ownerCompanionId}:${name}`;
  const rng = opts.rng ?? mulberry32(seedToInt(seed));
  const ownerName = String(opts.ownerName || '她').slice(0, 24);

  let draft: CandidateDraft | null = null;
  let source: 'llm' | 'template' = 'template';
  if (!opts.forceTemplate) {
    draft = await tryLlmCastDraft(member, seed, ownerName);
    if (draft) source = 'llm';
  }
  if (!draft) draft = castTemplateDraft(member, rng, seed, ownerName);

  return persistCandidate(
    draft,
    {
      kind,
      companionId: Number.isFinite(ownerCompanionId) && ownerCompanionId > 0 ? ownerCompanionId : null,
      sceneHint: ownerName,
    },
    opts.now ?? nowIso(),
    source
  );
}

/* ------------------------------------------------------------------ */
/* 候选人来源③：交往中自动识别（她提到的人浮现为可攻略对象）             */
/* ------------------------------------------------------------------ */

export interface CastMentionHit extends CastOriginInput {
  /** 在统计窗口内被提及的次数（用户与她的消息分别计数之和） */
  count: number;
}

/** 确定性扫描：统计「她身边的人」在最近消息里被提及的次数（不依赖模型，纯文本匹配）。
 *  - 只统计长度 ≥2 的名字，避免单字误命中；
 *  - 同时匹配用户消息与她自己的消息（她提到室友也算）。 */
export function detectCastMentions(
  companionId: number,
  opts: { lookbackMessages?: number; minCount?: number } = {}
): CastMentionHit[] {
  const lookback = Math.max(1, Math.trunc(opts.lookbackMessages ?? CAST_MENTION_LOOKBACK));
  const minCount = Math.max(1, Math.trunc(opts.minCount ?? CAST_MENTION_THRESHOLD));
  const cast = withCompanion(companionId, () => getCast());
  if (!cast.length) return [];

  // 注意：本函数是「跨伴侣/显式 id」场景（可能在无 ALS 上下文的调用点执行），
  // 故用 dbAll + 显式 companion_id 参数，而不是 cAll（约定：c* 系列依赖 cId() 上下文）。
  const rows = dbAll<{ role: string; content: string }>(
    `SELECT role, content FROM messages WHERE companion_id = ? ORDER BY id DESC LIMIT ?`,
    companionId,
    lookback
  );
  const haystack = rows.map((r) => String(r.content || '')).join('\n');
  if (!haystack) return [];

  const out: CastMentionHit[] = [];
  for (const m of cast) {
    const name = String(m.name || '').trim();
    if (name.length < 2) continue;
    let count = 0;
    let idx = haystack.indexOf(name);
    while (idx !== -1) {
      count++;
      idx = haystack.indexOf(name, idx + name.length);
    }
    if (count >= minCount) out.push({ name, role: String(m.role || '朋友'), note: String(m.note || ''), count });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** 是否已经在 companions 里存在同名角色（候选或伴侣都算，避免重复浮现） */
function companionNameExists(name: string): boolean {
  const row = dbGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM companions WHERE lower(replace(name,' ','')) = lower(replace(?,' ','')) AND status != 'closed'`,
    String(name).trim()
  );
  return Number(row?.c ?? 0) > 0;
}

/** 自动识别：把「被反复提及、且尚未成为候选/伴侣」的她身边的人升格为候选人。
 *  返回新生成的候选人 id（created）与被跳过的人名（skipped）。 */
export async function autoDiscoverFromMentions(
  companionId: number,
  opts: {
    lookbackMessages?: number;
    minCount?: number;
    ownerName?: string;
    maxCreate?: number;
    forceTemplate?: boolean;
  } = {}
): Promise<{ created: number[]; skipped: string[] }> {
  const hits = detectCastMentions(companionId, opts);
  const created: number[] = [];
  const skipped: string[] = [];
  const maxCreate = Math.max(1, Math.trunc(opts.maxCreate ?? 3)); // 单次最多浮现 3 名，避免刷屏（不限制总量）
  for (const hit of hits) {
    if (created.length >= maxCreate) break;
    if (companionNameExists(hit.name)) {
      skipped.push(hit.name);
      continue;
    }
    const r = await generateCandidateFromCast(companionId, hit, {
      kind: 'auto',
      ownerName: opts.ownerName,
      forceTemplate: opts.forceTemplate,
    });
    if (r.ok) created.push(Number(r.row.id));
    else skipped.push(hit.name);
  }
  return { created, skipped };
}

/** 自动识别的调度入口（供后台 tick 每伴侣调用）：
 *  - 节流：默认 6 小时最多扫一次（私有计数器键 `auto_discover_at#c{id}`）；
 *  - 只扫描、只在「她身边的人被反复提及且尚未成为候选」时新建候选；
 *  - 任何异常都不抛出（后台任务不能因识别失败而中断）。 */
export async function maybeAutoDiscover(
  companionId: number,
  opts: {
    minCount?: number;
    lookbackMessages?: number;
    intervalMs?: number;
    ownerName?: string;
    maxCreate?: number;
    now?: number;
  } = {}
): Promise<number[]> {
  try {
    const interval = Math.max(60_000, Math.trunc(opts.intervalMs ?? 6 * 3600_000));
    const now = opts.now ?? Date.now();
    const last = Number(withCompanion(companionId, () => getCounter(ck('auto_discover_at'))) || 0);
    if (last > 0 && now - last < interval) return [];
    withCompanion(companionId, () => setCounter(ck('auto_discover_at'), now));
    const r = await autoDiscoverFromMentions(companionId, {
      minCount: opts.minCount,
      lookbackMessages: opts.lookbackMessages,
      ownerName: opts.ownerName,
      maxCreate: opts.maxCreate,
      // 后台路径一律用模板兜底：避免后台静默调用模型（与 proactive 的节流初衷一致）
      forceTemplate: true,
    });
    return r.created;
  } catch {
    return [];
  }
}

/** 发现区是否已超过软上限（仅用于 UI 提示分页，**不阻塞**生成） */
export function pendingOverSoftLimit(): boolean {
  return countPendingCandidates() > PENDING_SOFT_LIMIT;
}
