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

/* ------------------------------------------------------------------ */
/* 伴侣域 / 群聊 / 活动（v13 新表）——字段与 DDL 一一对应                 */
/* ------------------------------------------------------------------ */

/** companions 表：伴侣档案（角色卡 + 攻略状态机载体）。`age` 受 DB 层 CHECK(age>=18) 约束。 */
export interface CompanionRow {
  /** 即全库 companion_id（主女友恒为 1）。 */
  id: number;
  user_id: number;
  /** 通讯录显示名（她自命名后由 personas.agent_name 接管显示）。 */
  name: string;
  /** ★18+ 硬红线：DB 层 CHECK(age >= 18) 强制成年。 */
  age: number;
  gender: string;
  identity: string | null;
  /** JSON 数组字符串，如 ["文静","慢热","爱读书"]。 */
  personality_tags: string | null;
  portrait_desc: string | null;
  avatar_url: string | null;
  intro: string | null;
  first_meet_scene: string | null;
  gen_seed: string | null;
  /** name+identity+portrait_desc 归一化哈希（防重复）。 */
  dedupe_hash: string | null;
  /** stranger|acquaintance|ambiguous|pursuing|girlfriend|cold|rejected|closed */
  status: string;
  /** 攻略期专用「吸引力」指标（0-100），晋升后保留但不再驱动。 */
  attraction: number;
  /** 主女友=1（既有那份数据）。 */
  is_primary: number;
  /** 已进入通讯录=1。 */
  is_discovered: number;
  /** 待处理候选人=1（发现区）。 */
  pending: number;
  /** 用户已选「攻略」=1。 */
  pursue_opt_in: number;
  /** 累计拒绝次数（≥3 → closed）。 */
  reject_count: number;
  /** 表白被拒冷却截止（24h）。 */
  cooldown_until: string | null;
  /** 来历：'cast'（她的室友/同事/朋友等身边人升格）| 'auto'（交往中自动识别）| 'random'（陌生人）| null（主女友/老数据）。 */
  origin_kind: string | null;
  /** 通过哪位伴侣认识（cast/auto 时有值）；晋升时据此建立初始伴侣关系边。 */
  origin_companion_id: number | null;
  established_at: string | null;
  closed_at: string | null;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
}

/** companion_relations 表：伴侣间关系边（值域 -100..100）。 */
export interface CompanionRelationRow {
  id: number;
  user_id: number;
  /** 规范序：a_id < b_id。 */
  a_id: number;
  b_id: number;
  /** -100..100（<0 偏吃醋/竞争，>0 偏友好/联盟）。 */
  value: number;
  /** friendly|neutral|jealous|rival|ally */
  state: string;
  last_event_at: string | null;
  updated_at: string;
}

/** companion_events 表：伴侣事件日志。 */
export interface CompanionEventRow {
  id: number;
  user_id: number;
  /** 主角（成对事件可为空）。 */
  companion_id: number | null;
  /** meet|pursue|progress|promote|rejected|closed|relation_change|activity|discover */
  kind: string;
  summary: string;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  meta_json: string | null;
  created_at: string;
}

/** groups 表：群聊。 */
export interface GroupRow {
  id: number;
  user_id: number;
  name: string;
  topic: string | null;
  /** active|archived */
  status: string;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

/** group_members 表：群成员。 */
export interface GroupMemberRow {
  id: number;
  group_id: number;
  companion_id: number;
  joined_at: string;
}

/** group_messages 表：群消息。 */
export interface GroupMessageRow {
  id: number;
  group_id: number;
  /** NULL=用户/系统。 */
  companion_id: number | null;
  /** user|companion|system|reaction */
  speaker_type: string;
  speaker_name: string | null;
  /** reaction 时存 emoji。 */
  content: string;
  /** 非空 = 这是一条 reaction（替代发言）。 */
  reaction: string | null;
  round: number;
  meta: string | null;
  created_at: string;
}

/** group_runs 表：一次群聊/活动会话（轮数上限、中止、调度状态）。 */
export interface GroupRunRow {
  id: number;
  group_id: number;
  /** chat|activity_online|activity_offline */
  kind: string;
  activity_id: number | null;
  /** running|ended|cancelled */
  status: string;
  round: number;
  max_rounds: number;
  /** 上一次发言者（禁三连击/轮转依据）。 */
  last_speaker_id: number | null;
  /** JSON 数组：近 N 位发言者（轮转去重）。 */
  recent_speakers: string | null;
  /** JSON {companionId: 本 run 发言次数}。 */
  spoke_counts: string | null;
  ended_reason: string | null;
  started_at: string;
  ended_at: string | null;
}

/** activities 表：线上/线下活动。 */
export interface ActivityRow {
  id: number;
  user_id: number;
  group_id: number | null;
  /** online|offline */
  kind: string;
  /** movie|game|nighttalk|co_listen|outing|date */
  template_key: string | null;
  title: string;
  /** online|offline（线下活动=offline）。 */
  scene: string;
  scheduled_at: string | null;
  location: string | null;
  /** planned|ongoing|ended|cancelled */
  status: string;
  /** 线下「轮流聚焦」当前对象。 */
  focus_companion_id: number | null;
  summary: string | null;
  meta_json: string | null;
  created_at: string;
  updated_at: string;
}

/** activity_participants 表：活动参与者。 */
export interface ActivityParticipantRow {
  id: number;
  activity_id: number;
  companion_id: number;
  joined_at: string;
}

/** activity_schedule_items 表：线下「约会日程」条目。 */
export interface ActivityScheduleItemRow {
  id: number;
  activity_id: number;
  /** 见面→散步→咖啡→收尾。 */
  seq: number;
  title: string;
  /** pending|current|done */
  status: string;
  note: string | null;
  created_at: string;
}