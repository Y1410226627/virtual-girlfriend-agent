// 分析模型返回值的解析与归一化：把松散 JSON 收敛成 AnalysisResult，及转录/撤销等辅助工具
import { cAll, cGet } from './db';
import { clamp, truncate, round1 } from './utils';
import { getRelationshipState, agentName, userName, type AffectState } from './relationship';
import type { ConflictType, RepairQuality } from './conflict';
import type { AnalysisResult, AttachmentSignal, MemoryUpdate, PersonalitySignal, RelationshipDelta } from './types';

function emptyResult(): AnalysisResult {
  return {
    memory_updates: [],
    relationship_delta: {
      intimacy: 0,
      trust: 0,
      mood: getRelationshipState().mood,
      emotional_balance_delta: 0,
      unresolved_tension_delta: 0,
      repair_credit_delta: 0,
    },
    personality_signals: [],
    attachment_signals: { anxiety_delta: 0, avoidance_delta: 0, reasoning: '' },
    conflict_detected: false,
    conflict_type: 'none',
    repair_attempt: false,
    repair_quality: 'none',
    relationship_confirmation: false,
    next_check_in_minutes: 120,
    next_relationship_talk: false,
    reasoning: '',
  };
}

/* ------------------------------------------------------------------ */
/* 分析模型返回的原始 JSON：字段一律视为松散值，逐项做运行时归一化       */
/* ------------------------------------------------------------------ */
interface RawMemoryUpdate {
  type?: string;
  content?: string;
  importance?: number;
  emotion?: string | null;
  expires_at?: string | null;
  /** 事实键（P1-20）：同一事实的稳定标识，缺省时回退向量判重 */
  fact_key?: string;
}
interface RawPersonalitySignal {
  signal?: string;
  dimension?: string;
  direction?: string;
  strength?: number;
  context?: string;
  reasoning?: string;
  is_direct_feedback?: boolean;
}
interface RawMemoryCorrection {
  old_hint?: string;
  new_fact?: string;
  /** 被纠正旧记忆的事实键（P1-21）：有则优先按键精确命中 */
  old_fact_key?: string;
}
interface RawRelationshipDelta {
  intimacy?: number;
  trust?: number;
  mood?: string;
  emotional_balance_delta?: number;
  unresolved_tension_delta?: number;
  repair_credit_delta?: number;
}
interface RawAttachmentSignals {
  anxiety_delta?: number;
  avoidance_delta?: number;
  reasoning?: string;
  user_attachment_cues?: unknown[];
}
export interface RawLocationChange {
  new_location?: string;
  reason?: string;
}
export interface RawActivityChange {
  new_activity?: string;
  expected_end?: string;
}
export interface RawDailyEvent {
  type?: string;
  content?: string;
  impact?: string;
}
export interface RawSharedWorldUpdate {
  new_plan?: string;
  new_ritual?: string;
  new_place?: string;
  new_item?: string;
  new_memory?: string;
}
/** 分析模型输出的"此刻情绪"（P1-16，允许缺省） */
interface RawAffect {
  primary?: string;
  valence?: number;
  arousal?: number;
  cause?: string;
  confidence?: number;
  ttl_hours?: number;
}
/** 分析模型输出的完整 JSON（对应 prompts.ts 里 buildAnalysisMessages 的 schema） */
export interface RawAnalysis {
  memory_updates?: RawMemoryUpdate[];
  memory_corrections?: RawMemoryCorrection[];
  affect?: RawAffect;
  relationship_delta?: RawRelationshipDelta;
  personality_signals?: RawPersonalitySignal[];
  attachment_signals?: RawAttachmentSignals;
  conflict_detected?: unknown;
  conflict_type?: unknown;
  repair_attempt?: unknown;
  repair_quality?: unknown;
  relationship_confirmation?: unknown;
  scene?: unknown;
  scene_reason?: unknown;
  health_delta?: Record<string, unknown>;
  psychology_delta?: Record<string, unknown>;
  location_change?: RawLocationChange;
  activity_change?: RawActivityChange;
  daily_event?: RawDailyEvent;
  shared_world_update?: RawSharedWorldUpdate;
  profile_reveal?: unknown[];
  preference_reveal?: unknown[];
  cared_for_her?: unknown;
  intimacy_delta?: Record<string, number>;
  aftercare_needed?: unknown;
  aftercare_quality?: unknown;
  next_check_in_minutes?: unknown;
  next_relationship_talk?: unknown;
  reasoning?: unknown;
}
/** 依恋分析模型输出的 JSON（对应 buildAttachmentAnalysisMessages 的 schema） */
export interface RawAttachmentAnalysis {
  suggested_anxiety_delta?: unknown;
  suggested_avoidance_delta?: unknown;
  reasoning?: unknown;
  user_attachment_cues?: unknown[];
}

/** 从模型输出的松散值里挑一个枚举成员（不在白名单内则返回 fallback） */
export function pickEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

export function num(v: unknown, def = 0): number {
  // 空值（null/undefined/空串）必须回落到 def，绝不能让 Number('')===0 冒充真实值：
  // 否则模型返回 importance:'' 会被记录成 0（最不重要），strength:'' 会把性格权重归零。
  if (v === null || v === undefined) return def;
  if (typeof v === 'string' && v.trim() === '') return def;
  const n = Number(v);
  return isFinite(n) ? n : def;
}

/**
 * 严格布尔解析（P1-03）：只接受 true/false、"true"/"false"、1/0、"1"/"0"
 * （trim + 大小写不敏感）；其他一切（"yes"、空串、null、对象……）返回 def。
 * 修复 `!!"false" === true` 这类 JS 陷阱：模型把布尔字段写成字符串 "false" 时，
 * 原实现 `!!"false"` 会被误判为 true（例如把"没有冲突"记成"有冲突"）。
 */
export function parseBool(v: unknown, def = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : def;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return def;
}

/** 归一化后的记忆条目：在 MemoryUpdate 之上带 fact_key（P1-20） */
export interface NormalizedMemoryUpdate extends MemoryUpdate {
  fact_key?: string | null;
}
/** normalize 的返回类型：AnalysisResult + 记忆事实键 + 此刻情绪（analysis-apply 需要，不外扩 types.ts） */
export interface NormalizedAnalysis extends AnalysisResult {
  memory_updates: NormalizedMemoryUpdate[];
  affect?: AffectState | null;
}

/** 事实键归一化：非空字符串 trim 后限长 40 字（与 memory.ts 的 normalizeFactKey 规则一致） */
function normalizeFactKey(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, 40) : null;
}

/**
 * 归一化"此刻情绪"（P1-16）：confidence≥0.3 且 primary 非空才返回；否则 null（不写、不改动）。
 * ttl_hours 默认 4，clamp 1..48；expiresAt 由"当前时刻 + ttl"算出。
 */
export function normalizeAffect(raw: RawAffect | undefined | null): AffectState | null {
  if (!raw || typeof raw !== 'object') return null;
  const primary = typeof raw.primary === 'string' ? raw.primary.trim().slice(0, 8) : '';
  if (!primary) return null;
  const confidence = clamp(num(raw.confidence, 0.5), 0, 1);
  if (confidence < 0.3) return null;
  const ttl = clamp(num(raw.ttl_hours, 4), 1, 48);
  return {
    primary,
    valence: clamp(num(raw.valence, 0), -1, 1),
    arousal: clamp(num(raw.arousal, 0), 0, 1),
    cause: typeof raw.cause === 'string' ? raw.cause.trim().slice(0, 40) : '',
    confidence,
    expiresAt: new Date(Date.now() + ttl * 3600000).toISOString(),
  };
}

export function normalize(raw: RawAnalysis): NormalizedAnalysis {
  const base = emptyResult();
  if (!raw || typeof raw !== 'object') return base;

  const rd: RawRelationshipDelta = raw.relationship_delta || {};
  const delta: RelationshipDelta = {
    intimacy: clamp(num(rd.intimacy), -2, 2),
    trust: clamp(num(rd.trust), -2, 2),
    mood: typeof rd.mood === 'string' && rd.mood.trim() ? rd.mood.trim().slice(0, 12) : base.relationship_delta.mood,
    emotional_balance_delta: clamp(num(rd.emotional_balance_delta), -5, 5),
    unresolved_tension_delta: clamp(num(rd.unresolved_tension_delta), -20, 20),
    repair_credit_delta: clamp(num(rd.repair_credit_delta), -10, 10),
  };

  const memories: NormalizedMemoryUpdate[] = Array.isArray(raw.memory_updates)
    ? raw.memory_updates
        .filter((m) => m && typeof m.content === 'string' && m.content.trim().length > 1)
        .slice(0, 6)
        .map((m): NormalizedMemoryUpdate => {
          const item: NormalizedMemoryUpdate = {
            type: pickEnum<MemoryUpdate['type']>(
              m.type,
              ['semantic', 'episodic', 'emotional', 'relationship', 'attachment', 'personality'],
              'episodic'
            ),
            content: String(m.content).trim().slice(0, 500),
            importance: clamp(num(m.importance, 5), 0, 10),
            emotion: m.emotion ? String(m.emotion).slice(0, 12) : null,
            expires_at: m.expires_at || null,
          };
          const fk = normalizeFactKey(m.fact_key);
          if (fk) item.fact_key = fk;
          return item;
        })
    : [];

  const signals: PersonalitySignal[] = Array.isArray(raw.personality_signals)
    ? raw.personality_signals
        .filter((s) => s && s.dimension)
        // 方向白名单：模型用文字表达负向（negative/decrease/减少）时原来会被当成 '+'
        .map((s) => {
          const dRaw = String(s.direction ?? '').trim();
          let dir: '+' | '-' | null = null;
          if (/^(\+|pos|up|increase|增加|提升|正向)/i.test(dRaw)) dir = '+';
          else if (/^(-|neg|down|decrease|减少|降低|负向)/i.test(dRaw)) dir = '-';
          return { raw: s, dir };
        })
        // 方向不明就丢弃，别默认加成
        .filter((x): x is { raw: RawPersonalitySignal; dir: '+' | '-' } => x.dir === '+' || x.dir === '-')
        .slice(0, 8)
        .map((x): PersonalitySignal => ({
          signal: String(x.raw.signal || '').slice(0, 200),
          dimension: String(x.raw.dimension),
          direction: x.dir,
          strength: clamp(num(x.raw.strength, 0.5), 0, 1),
          context: String(x.raw.context || '未知情境').slice(0, 120),
          reasoning: x.raw.reasoning ? String(x.raw.reasoning).slice(0, 300) : undefined,
          is_direct_feedback: parseBool(x.raw.is_direct_feedback),
        }))
    : [];

  const as: RawAttachmentSignals = raw.attachment_signals || {};
  const attachment: AttachmentSignal = {
    anxiety_delta: clamp(num(as.anxiety_delta), -2, 2),
    avoidance_delta: clamp(num(as.avoidance_delta), -2, 2),
    reasoning: String(as.reasoning || '').slice(0, 500),
    user_attachment_cues: Array.isArray(as.user_attachment_cues) ? as.user_attachment_cues.slice(0, 6).map(String) : [],
  };

  const conflictType: ConflictType = pickEnum<ConflictType>(raw.conflict_type, ['minor', 'major', 'boundary'], 'none');
  const repairQuality: RepairQuality = pickEnum<RepairQuality>(
    raw.repair_quality,
    ['sincere', 'sweet', 'avoidant', 'none'],
    'none'
  );

  return {
    memory_updates: memories,
    relationship_delta: delta,
    personality_signals: signals,
    attachment_signals: attachment,
    affect: normalizeAffect(raw.affect),
    conflict_detected: parseBool(raw.conflict_detected),
    conflict_type: conflictType,
    repair_attempt: parseBool(raw.repair_attempt),
    repair_quality: repairQuality,
    relationship_confirmation: parseBool(raw.relationship_confirmation),
    next_check_in_minutes: clamp(
      raw.next_check_in_minutes === null || raw.next_check_in_minutes === undefined || raw.next_check_in_minutes === ''
        ? 120
        : num(raw.next_check_in_minutes, 120),
      5,
      360
    ),
    next_relationship_talk: parseBool(raw.next_relationship_talk),
    scene: ['online', 'offline'].includes(String(raw.scene)) ? String(raw.scene) : 'keep',
    scene_reason: String(raw.scene_reason || '').slice(0, 200),
    reasoning: String(raw.reasoning || '').slice(0, 800),
  };
}

/** 解析"记忆纠正"：只保留字段完整、语义有效的项，最多 2 条（字段缺失即视为无纠正） */
export function parseMemoryCorrections(
  raw: RawAnalysis
): { old_hint: string; new_fact: string; old_fact_key: string | null }[] {
  const list = Array.isArray(raw?.memory_corrections) ? raw.memory_corrections : [];
  return list
    .filter((c) => c && typeof c.new_fact === 'string' && c.new_fact.trim().length > 1)
    .slice(0, 2)
    .map((c) => ({
      old_hint: typeof c.old_hint === 'string' ? c.old_hint.trim().slice(0, 300) : '',
      new_fact: String(c.new_fact).trim().slice(0, 500),
      old_fact_key: normalizeFactKey(c.old_fact_key),
    }));
}

/** 把一轮对话的上下文整理成文字（供分析使用）
 *  excludeIds（P1-12）：排除当前回合的消息 id，避免与显式传入的 userMessage/assistantMessage 重复
 *  （消息先落库，transcript 默认会带上当前回合 → 当前回合权重被放大）。可选，向后兼容。 */
export function transcript(limit = 10, excludeIds: number[] = []): string {
  const ids = (excludeIds || []).filter((x) => Number.isFinite(x) && x > 0);
  const ph = ids.map(() => '?').join(',');
  const where = ids.length ? `AND id NOT IN (${ph})` : '';
  const rows = cAll<{ role: string; content: string }>(
    `SELECT role, content FROM messages WHERE companion_id = ? ${where} ORDER BY id DESC LIMIT ?`,
    ...ids,
    limit
  ).reverse();
  const her = agentName();
  const him = userName();
  return rows
    .map((r) => `${r.role === 'user' ? him : her}：${truncate(r.content, 300)}`)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* 撤销支持：记录/回滚一轮对话造成的影响                                */
/* ------------------------------------------------------------------ */
export function snapshotForUndo() {
  const s = getRelationshipState();
  return {
    intimacy: round1(s.intimacy),
    trust: round1(s.trust),
    balance: round1(s.emotional_balance),
    tension: round1(s.unresolved_tension),
    repair: round1(s.repair_credit),
    mood: s.mood,
    stage: s.stage,
  };
}

export function maxId(table: string): number {
  const row = cGet<{ m: number | null }>(`SELECT MAX(id) AS m FROM ${table} WHERE companion_id = ?`);
  return Number(row?.m || 0);
}