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
import { dbGet, dbRun, llmConfig, DEFAULT_USER_ID } from './db';
import { nowIso } from './utils';
import { chatJson, type ChatMessage } from './llm';
import type { CompanionRow } from './types';

/** 发现区同时最多保留的待处理候选人数 */
export const MAX_PENDING_CANDIDATES = 3;
/** ★18+ 硬红线：任何伴侣角色的最小年龄（应用层 + DB 层双重拦截） */
export const AGE_MIN = 18;

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

/** 生成一名候选人并落库（pending=1、is_discovered=0）；返回结果对象（不抛错） */
export async function generateCandidate(opts: GenerateOptions = {}): Promise<GenerateResult> {
  if (countPendingCandidates() >= MAX_PENDING_CANDIDATES) {
    return { ok: false, code: 'PENDING_LIMIT', error: `待处理候选人已达上限（${MAX_PENDING_CANDIDATES}）` };
  }

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

  const now = opts.now ?? nowIso();
  const tags = Array.isArray(draft.personality_tags)
    ? draft.personality_tags.slice(0, 8).map((t) => String(t).slice(0, 12))
    : [];

  const res = dbRun(
    `INSERT INTO companions
       (user_id, name, age, gender, identity, personality_tags, portrait_desc, intro, first_meet_scene,
        gen_seed, dedupe_hash, status, attraction, is_primary, is_discovered, pending, pursue_opt_in,
        reject_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stranger', 0, 0, 0, 1, 0, 0, ?, ?)`,
    DEFAULT_USER_ID, // user_id（全局用户引用，恒为 1）
    name,
    age,
    'female',
    identity,
    JSON.stringify(tags),
    portrait,
    draft.intro ? String(draft.intro).slice(0, 400) : null,
    draft.first_meet_scene ? String(draft.first_meet_scene).slice(0, 120) : null,
    draft.gen_seed,
    hash,
    now,
    now
  );
  const id = Number(res.lastInsertRowid);
  const row = dbGet<CompanionRow>('SELECT * FROM companions WHERE id = ?', id);
  if (!row) return { ok: false, code: 'DB_ERROR', error: '候选人写入失败' };

  dbRun(
    `INSERT INTO companion_events (user_id, companion_id, kind, summary, new_value, created_at)
     VALUES (?, ?, 'discover', ?, ?, ?)`,
    DEFAULT_USER_ID,
    id,
    `发现一名潜在伴侣：${name}`,
    JSON.stringify({ name, identity, age }),
    now
  );

  return { ok: true, row, draft: { ...draft, name, age, identity, portrait_desc: portrait, personality_tags: tags }, source };
}
