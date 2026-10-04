// 全局类型定义

export interface MessageRow {
  id: number;
  user_id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  emotion: string | null;
  is_proactive: number;
  read_at: string | null;
  meta: string | null;
  created_at: string;
}

export interface MemoryRow {
  id: number;
  user_id: number;
  type: string; // semantic | episodic | emotional | relationship | summary | personality | attachment
  content: string;
  importance: number;
  emotion: string | null;
  source_message_id: number | null;
  created_at: string;
  last_accessed_at: string | null;
  expires_at: string | null;
  status: string; // active | archived | superseded
  superseded_by: number | null;
  access_count: number;
  meta: string | null;
}

export interface RelationshipState {
  user_id: number;
  intimacy: number;
  trust: number;
  mood: string;
  stage: number;
  stage_entered_at: string | null;
  stage_cap_since: string | null;
  pending_stage_confirm: number;
  pending_relationship_talk: number;
  conflict_state: string;
  last_conflict_at: string | null;
  nickname: string | null;
  anniversary: string | null;
  last_interaction_at: string | null;
  streak_days: number;
  emotional_balance: number;
  repair_credit: number;
  unresolved_tension: number;
  /** 当前场景：online=隔着手机聊天 / offline=线下相处 */
  scene?: string;
  scene_reason?: string | null;
  scene_updated_at?: string | null;
  updated_at: string;
}

export interface PersonalityStateRow {
  user_id: number;
  dimension: string;
  value: number;
  solidified: number;
  last_adjusted_turn: number;
  updated_at: string;
}

export interface AttachmentState {
  user_id: number;
  anxiety: number;
  avoidance: number;
  style: string; // secure | anxious | avoidant | fearful
  updated_at: string;
}

export interface PersonalitySignal {
  signal: string;
  dimension: string;
  direction: '+' | '-';
  strength: number;
  context: string;
  reasoning?: string;
  is_direct_feedback?: boolean; // 用户明确反馈，权重 3
}

export interface AttachmentSignal {
  anxiety_delta: number;
  avoidance_delta: number;
  reasoning: string;
  user_attachment_cues?: string[];
}

export interface MemoryUpdate {
  type: 'semantic' | 'episodic' | 'emotional' | 'relationship' | 'attachment' | 'personality';
  content: string;
  importance: number;
  emotion?: string | null;
  expires_at?: string | null;
}

export interface RelationshipDelta {
  intimacy: number;
  trust: number;
  mood: string;
  emotional_balance_delta: number;
  unresolved_tension_delta: number;
  repair_credit_delta: number;
}

export interface AnalysisResult {
  memory_updates: MemoryUpdate[];
  relationship_delta: RelationshipDelta;
  personality_signals: PersonalitySignal[];
  attachment_signals: AttachmentSignal;
  conflict_detected: boolean;
  conflict_type: 'none' | 'minor' | 'major' | 'boundary';
  repair_attempt: boolean;
  repair_quality?: 'sincere' | 'sweet' | 'avoidant' | 'none';
  relationship_confirmation?: boolean; // 本轮是否发生了"关系确认"
  /** 场景判断：online / offline / keep */
  scene?: string;
  scene_reason?: string;
  next_check_in_minutes?: number;
  next_relationship_talk?: boolean;
  reasoning: string;
}

export const DIMENSIONS = [
  { key: 'warmth', label: '温柔/关怀', desc: '关心、安慰、体贴的频率和深度' },
  { key: 'playfulness', label: '俏皮/轻松', desc: '玩笑、调侃、轻松互动的倾向' },
  { key: 'romance', label: '浪漫表达', desc: '爱意表达、制造惊喜、甜言蜜语的频率' },
  { key: 'directness', label: '直接性', desc: '表达需求、不满、喜欢的直接程度' },
  { key: 'independence', label: '独立性', desc: '有自己的生活和兴趣，不围着对方转的程度' },
  { key: 'emotional_intensity', label: '情绪表达强度', desc: '情绪化表达的程度（平静克制 ↔ 外放浓烈）' },
] as const;

export type DimensionKey = (typeof DIMENSIONS)[number]['key'];

export const DIMENSION_ALIASES: Record<string, DimensionKey> = {
  warmth: 'warmth',
  温柔: 'warmth',
  温柔关怀: 'warmth',
  '温柔/关怀': 'warmth',
  playfulness: 'playfulness',
  俏皮: 'playfulness',
  '俏皮/轻松': 'playfulness',
  轻松: 'playfulness',
  romance: 'romance',
  浪漫: 'romance',
  浪漫表达: 'romance',
  directness: 'directness',
  直接性: 'directness',
  independence: 'independence',
  独立性: 'independence',
  emotional_intensity: 'emotional_intensity',
  情绪强度: 'emotional_intensity',
  情绪表达强度: 'emotional_intensity',
};

export const ATTACHMENT_STYLES: Record<string, string> = {
  secure: '安全型',
  anxious: '焦虑型',
  avoidant: '回避型',
  fearful: '混乱型',
};

export function attachmentStyleOf(anxiety: number, avoidance: number): string {
  const highA = anxiety >= 40;
  const highV = avoidance >= 40;
  if (!highA && !highV) return 'secure';
  if (highA && !highV) return 'anxious';
  if (!highA && highV) return 'avoidant';
  return 'fearful';
}