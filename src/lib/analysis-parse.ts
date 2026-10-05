// 分析模型返回值的解析与归一化：把松散 JSON 收敛成 AnalysisResult，及转录/撤销等辅助工具
import { dbAll, dbGet, DEFAULT_USER_ID } from './db';
import { clamp, truncate, round1 } from './utils';
import { getRelationshipState, agentName, userName } from './relationship';
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
/** 分析模型输出的完整 JSON（对应 prompts.ts 里 buildAnalysisMessages 的 schema） */
export interface RawAnalysis {
  memory_updates?: RawMemoryUpdate[];
  memory_corrections?: RawMemoryCorrection[];
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
  const n = Number(v);
  return isFinite(n) ? n : def;
}

export function normalize(raw: RawAnalysis): AnalysisResult {
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

  const memories: MemoryUpdate[] = Array.isArray(raw.memory_updates)
    ? raw.memory_updates
        .filter((m) => m && typeof m.content === 'string' && m.content.trim().length > 1)
        .slice(0, 6)
        .map((m) => ({
          type: pickEnum<MemoryUpdate['type']>(
            m.type,
            ['semantic', 'episodic', 'emotional', 'relationship', 'attachment', 'personality'],
            'episodic'
          ),
          content: String(m.content).trim().slice(0, 500),
          importance: clamp(num(m.importance, 5), 0, 10),
          emotion: m.emotion ? String(m.emotion).slice(0, 12) : null,
          expires_at: m.expires_at || null,
        }))
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
          is_direct_feedback: !!x.raw.is_direct_feedback,
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
    conflict_detected: !!raw.conflict_detected,
    conflict_type: conflictType,
    repair_attempt: !!raw.repair_attempt,
    repair_quality: repairQuality,
    relationship_confirmation: !!raw.relationship_confirmation,
    next_check_in_minutes: clamp(
      raw.next_check_in_minutes === null || raw.next_check_in_minutes === undefined || raw.next_check_in_minutes === ''
        ? 120
        : num(raw.next_check_in_minutes, 120),
      5,
      360
    ),
    next_relationship_talk: !!raw.next_relationship_talk,
    scene: ['online', 'offline'].includes(String(raw.scene)) ? String(raw.scene) : 'keep',
    scene_reason: String(raw.scene_reason || '').slice(0, 200),
    reasoning: String(raw.reasoning || '').slice(0, 800),
  };
}

/** 解析"记忆纠正"：只保留字段完整、语义有效的项，最多 2 条（字段缺失即视为无纠正） */
export function parseMemoryCorrections(raw: RawAnalysis): { old_hint: string; new_fact: string }[] {
  const list = Array.isArray(raw?.memory_corrections) ? raw.memory_corrections : [];
  return list
    .filter((c) => c && typeof c.new_fact === 'string' && c.new_fact.trim().length > 1)
    .slice(0, 2)
    .map((c) => ({
      old_hint: typeof c.old_hint === 'string' ? c.old_hint.trim().slice(0, 300) : '',
      new_fact: String(c.new_fact).trim().slice(0, 500),
    }));
}

/** 把一轮对话的上下文整理成文字（供分析使用） */
export function transcript(limit = 10): string {
  const rows = dbAll<{ role: string; content: string }>(
    'SELECT role, content FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    DEFAULT_USER_ID,
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
  const row = dbGet<{ m: number | null }>(`SELECT MAX(id) AS m FROM ${table} WHERE user_id = ?`, DEFAULT_USER_ID);
  return Number(row?.m || 0);
}