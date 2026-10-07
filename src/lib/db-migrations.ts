// 数据库迁移定义（追加式 SQL 数据，从 db.ts 拆出；执行逻辑仍在 db.ts）
/* ------------------------------------------------------------------ */
/* 迁移定义（每次结构变化追加一条，不要修改历史条目）                    */
/* ------------------------------------------------------------------ */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init_all_tables',
    sql: `
-- 用户
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '你',
  created_at TEXT NOT NULL
);

-- 她的"人设"（开放、可塑，可由用户赋予或共同创造）
CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  agent_name TEXT,
  age TEXT,
  occupation TEXT,
  self_story TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 消息
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  emotion TEXT,
  is_proactive INTEGER NOT NULL DEFAULT 0,
  read_at TEXT,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at);

-- 长期记忆
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 5,
  emotion TEXT,
  source_message_id INTEGER,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_user_type ON memories(user_id, type, status);

-- 记忆向量
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 关系状态
CREATE TABLE IF NOT EXISTS relationship_state (
  user_id INTEGER PRIMARY KEY,
  intimacy REAL NOT NULL DEFAULT 0,
  trust REAL NOT NULL DEFAULT 0,
  mood TEXT NOT NULL DEFAULT '平静',
  stage INTEGER NOT NULL DEFAULT 0,
  stage_entered_at TEXT,
  stage_cap_since TEXT,
  pending_stage_confirm INTEGER NOT NULL DEFAULT 0,
  pending_relationship_talk INTEGER NOT NULL DEFAULT 0,
  conflict_state TEXT NOT NULL DEFAULT 'none',
  last_conflict_at TEXT,
  nickname TEXT,
  anniversary TEXT,
  last_interaction_at TEXT,
  streak_days INTEGER NOT NULL DEFAULT 0,
  emotional_balance REAL NOT NULL DEFAULT 0,
  repair_credit REAL NOT NULL DEFAULT 0,
  unresolved_tension REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- 关系日志
CREATE TABLE IF NOT EXISTS relationship_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  stage_at_time INTEGER,
  created_at TEXT NOT NULL
);

-- 情感银行流水
CREATE TABLE IF NOT EXISTS emotional_bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message_id INTEGER,
  delta REAL NOT NULL,
  kind TEXT NOT NULL,
  behavior TEXT,
  reason TEXT,
  balance_after REAL NOT NULL,
  created_at TEXT NOT NULL
);

-- 每日摘要
CREATE TABLE IF NOT EXISTS daily_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  summary TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, date)
);

-- 事件 / 纪念日 / 未来计划
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  repeat_yearly INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'anniversary',
  description TEXT,
  created_at TEXT NOT NULL
);

-- 设置
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 性格状态（六个维度）
CREATE TABLE IF NOT EXISTS personality_state (
  user_id INTEGER NOT NULL,
  dimension TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 50,
  solidified INTEGER NOT NULL DEFAULT 0,
  last_adjusted_turn INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, dimension)
);

-- 性格信号（累积层）
CREATE TABLE IF NOT EXISTS personality_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message_id INTEGER,
  dimension TEXT NOT NULL,
  direction TEXT NOT NULL,
  strength REAL NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  context TEXT,
  reasoning TEXT,
  created_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_personality_signals ON personality_signals(user_id, dimension, direction, consumed);

-- 性格调整日志（确认层 / 固化层）
CREATE TABLE IF NOT EXISTS personality_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message_id INTEGER,
  dimension TEXT NOT NULL,
  old_value REAL NOT NULL,
  new_value REAL NOT NULL,
  delta REAL NOT NULL,
  signal_context TEXT,
  reasoning TEXT,
  stage_at_time INTEGER,
  attachment_at_time TEXT,
  layer TEXT NOT NULL DEFAULT 'confirm',
  created_at TEXT NOT NULL
);

-- 性格周快照（可回滚）
CREATE TABLE IF NOT EXISTS personality_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  week TEXT NOT NULL,
  values_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, week)
);

-- 依恋状态
CREATE TABLE IF NOT EXISTS attachment_state (
  user_id INTEGER PRIMARY KEY,
  anxiety REAL NOT NULL DEFAULT 30,
  avoidance REAL NOT NULL DEFAULT 30,
  style TEXT NOT NULL DEFAULT 'secure',
  updated_at TEXT NOT NULL
);

-- 依恋信号（需 3 次同向才生效）
CREATE TABLE IF NOT EXISTS attachment_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  axis TEXT NOT NULL,
  direction TEXT NOT NULL,
  delta REAL NOT NULL,
  reasoning TEXT,
  user_cues TEXT,
  applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 依恋变化日志
CREATE TABLE IF NOT EXISTS attachment_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  old_anxiety REAL NOT NULL,
  new_anxiety REAL NOT NULL,
  old_avoidance REAL NOT NULL,
  new_avoidance REAL NOT NULL,
  trigger TEXT,
  reasoning TEXT,
  created_at TEXT NOT NULL
);

-- 冲突记录
CREATE TABLE IF NOT EXISTS conflict_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  description TEXT,
  tension_at_start REAL,
  tension_after REAL,
  repair_quality TEXT,
  started_at TEXT NOT NULL,
  resolved_at TEXT
);

-- 主动消息记录
CREATE TABLE IF NOT EXISTS proactive_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  message_id INTEGER,
  created_at TEXT NOT NULL
);

-- 内部计数器
CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL DEFAULT 0
);
`,
  },
  {
    version: 2,
    name: 'turn_effects_and_message_attribution',
    sql: `
-- 每一轮"实际产生了什么影响"：删除消息时可以精确撤销
CREATE TABLE IF NOT EXISTS turn_effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message_id INTEGER,
  user_message_id INTEGER,
  intimacy_delta REAL NOT NULL DEFAULT 0,
  trust_delta REAL NOT NULL DEFAULT 0,
  balance_delta REAL NOT NULL DEFAULT 0,
  tension_delta REAL NOT NULL DEFAULT 0,
  repair_delta REAL NOT NULL DEFAULT 0,
  mood_before TEXT,
  mood_after TEXT,
  stage_before INTEGER,
  stage_after INTEGER,
  rel_log_from INTEGER,
  rel_log_to INTEGER,
  att_log_from INTEGER,
  att_log_to INTEGER,
  conflict_id INTEGER,
  created_at TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_turn_effects_msg ON turn_effects(user_id, message_id);
CREATE INDEX IF NOT EXISTS idx_turn_effects_user_msg ON turn_effects(user_id, user_message_id);

-- 让关系日志 / 依恋信号也能归因到具体消息
ALTER TABLE relationship_logs ADD COLUMN message_id INTEGER;
ALTER TABLE attachment_signals ADD COLUMN message_id INTEGER;
`,
  },
  {
    version: 3,
    name: 'model_profiles_and_scene',
    sql: `
-- 模型档案：用过的模型都留在这里，随时切换；按 sort_order 作为备用顺序
CREATE TABLE IF NOT EXISTS model_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  chat_model TEXT NOT NULL,
  analysis_model TEXT,
  embedding_base_url TEXT,
  embedding_api_key TEXT,
  embedding_model TEXT,
  note TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_profiles_user ON model_profiles(user_id, sort_order);

-- 当前场景：线上聊天 / 线下相处
ALTER TABLE relationship_state ADD COLUMN scene TEXT NOT NULL DEFAULT 'online';
ALTER TABLE relationship_state ADD COLUMN scene_reason TEXT;
ALTER TABLE relationship_state ADD COLUMN scene_updated_at TEXT;
`,
  },
  {
    version: 4,
    name: 'life_simulation_and_intimacy',
    sql: `
-- 她的个人信息（背景种子，逐步揭露）
CREATE TABLE IF NOT EXISTS agent_profile (
  user_id INTEGER PRIMARY KEY,
  name TEXT, nickname TEXT, age TEXT, birthday TEXT,
  hometown TEXT, city TEXT, family TEXT, education TEXT, job TEXT,
  hobbies TEXT, habits TEXT, catchphrases TEXT, fears TEXT, dreams TEXT, secrets TEXT,
  reveal_status TEXT,
  updated_at TEXT NOT NULL
);

-- 健康状态
CREATE TABLE IF NOT EXISTS agent_health (
  user_id INTEGER PRIMARY KEY,
  energy REAL NOT NULL DEFAULT 80,
  sleep_quality REAL NOT NULL DEFAULT 80,
  hunger REAL NOT NULL DEFAULT 70,
  illness TEXT NOT NULL DEFAULT 'none',
  illness_start TEXT,
  illness_duration_days REAL,
  illness_severity REAL NOT NULL DEFAULT 0,
  cared_count INTEGER NOT NULL DEFAULT 0,
  cycle_enabled INTEGER NOT NULL DEFAULT 1,
  cycle_day INTEGER NOT NULL DEFAULT 1,
  cycle_length INTEGER NOT NULL DEFAULT 28,
  exercise REAL NOT NULL DEFAULT 50,
  last_meal_at TEXT,
  last_sleep_at TEXT,
  woke_at TEXT,
  updated_at TEXT NOT NULL
);

-- 心理状态
CREATE TABLE IF NOT EXISTS agent_psychology (
  user_id INTEGER PRIMARY KEY,
  base_emotion TEXT NOT NULL DEFAULT '平静',
  stress REAL NOT NULL DEFAULT 20,
  loneliness REAL NOT NULL DEFAULT 20,
  missing_user REAL NOT NULL DEFAULT 30,
  security REAL NOT NULL DEFAULT 60,
  self_worth REAL NOT NULL DEFAULT 65,
  mental_energy REAL NOT NULL DEFAULT 70,
  updated_at TEXT NOT NULL
);

-- 位置
CREATE TABLE IF NOT EXISTS agent_location (
  user_id INTEGER PRIMARY KEY,
  current_location TEXT NOT NULL DEFAULT '家',
  location_type TEXT NOT NULL DEFAULT 'home',
  arrived_at TEXT,
  expected_leave_at TEXT,
  updated_at TEXT NOT NULL
);

-- 当前活动
CREATE TABLE IF NOT EXISTS agent_activity (
  user_id INTEGER PRIMARY KEY,
  current_activity TEXT NOT NULL DEFAULT '发呆',
  activity_type TEXT NOT NULL DEFAULT 'idle',
  started_at TEXT,
  expected_end_at TEXT,
  updated_at TEXT NOT NULL
);

-- 日常事件
CREATE TABLE IF NOT EXISTS agent_daily_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  content TEXT NOT NULL,
  impact_json TEXT,
  created_at TEXT NOT NULL
);

-- 共享世界
CREATE TABLE IF NOT EXISTS shared_world (
  user_id INTEGER PRIMARY KEY,
  shared_places_json TEXT,
  shared_plans_json TEXT,
  shared_rituals_json TEXT,
  shared_items_json TEXT,
  updated_at TEXT NOT NULL
);

-- 生活状态变化日志（连续性可查）
CREATE TABLE IF NOT EXISTS life_state_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

-- 亲密状态
CREATE TABLE IF NOT EXISTS intimacy_state (
  user_id INTEGER PRIMARY KEY,
  libido REAL NOT NULL DEFAULT 30,
  intimacy_need REAL NOT NULL DEFAULT 35,
  sexual_satisfaction REAL NOT NULL DEFAULT 50,
  sexual_stress REAL NOT NULL DEFAULT 20,
  aftercare_until TEXT,
  aftercare_state TEXT,
  last_intimacy_at TEXT,
  updated_at TEXT NOT NULL
);

-- 亲密偏好（逐步揭露） / 边界
CREATE TABLE IF NOT EXISTS intimacy_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  preference_type TEXT NOT NULL,
  content TEXT NOT NULL,
  reveal_status TEXT NOT NULL DEFAULT 'hidden',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intimacy_boundaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  boundary_type TEXT NOT NULL,
  content TEXT NOT NULL,
  is_hard_limit INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 同意记录 / 安全词 / 事后关怀
CREATE TABLE IF NOT EXISTS intimacy_consent_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  session_id TEXT,
  event TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intimacy_aftercare (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  session_id TEXT,
  aftercare_quality TEXT,
  user_response TEXT,
  agent_state TEXT,
  created_at TEXT NOT NULL
);

-- 内容分级
CREATE TABLE IF NOT EXISTS intimacy_content_level (
  user_id INTEGER PRIMARY KEY,
  level INTEGER NOT NULL DEFAULT 0,
  age_confirmed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 5,
    name: 'drop_boundaries_and_consent_logs',
    sql: `
-- safe: 功能已移除，两张表本机无业务数据，删除只为保持结构干净（历史迁移 v5，已执行）
-- 边界与同意日志功能已移除（两者本机数据量极小，删除只为保持结构干净）
DROP TABLE IF EXISTS intimacy_boundaries;
DROP TABLE IF EXISTS intimacy_consent_logs;
`,
  },
  {
    version: 6,
    name: 'restore_intimacy_boundaries_and_consent',
    sql: `
ALTER TABLE intimacy_state ADD COLUMN active_session_id TEXT;

CREATE TABLE IF NOT EXISTS intimacy_boundaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  boundary_type TEXT NOT NULL,
  content TEXT NOT NULL,
  is_hard_limit INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intimacy_consent_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  session_id TEXT,
  event TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intimacy_consent_user ON intimacy_consent_logs(user_id, created_at);
`,
  },
  {
    version: 7,
    name: 'world_snapshots_and_preference_reveal_gates',
    sql: `
ALTER TABLE intimacy_preferences ADD COLUMN reveal_stage INTEGER NOT NULL DEFAULT 2;

CREATE TABLE IF NOT EXISTS world_weekly_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  week TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, week)
);

-- safe: 重置年龄确认标记（v7 引入分级体系，历史的 age_confirmed 不再适用，统一清零让用户重新确认；已执行）
UPDATE intimacy_content_level SET age_confirmed = 0;
UPDATE settings SET value = 'false', updated_at = datetime('now') WHERE key = 'age_confirmed';
`,
  },
  {
    version: 8,
    name: 'remove_intimacy_safety_controls',
    sql: `
-- safe: v6 临时恢复的安全控制表/列在 v8 确认移除（功能下线，本机无业务数据保留价值；已执行）
DROP TABLE IF EXISTS intimacy_consent_logs;
DROP TABLE IF EXISTS intimacy_boundaries;
ALTER TABLE intimacy_state DROP COLUMN active_session_id;
ALTER TABLE intimacy_content_level DROP COLUMN age_confirmed;
DELETE FROM settings WHERE key IN ('safe_word', 'age_confirmed');
`,
  },
  {
    version: 9,
    name: 'ongoing_events',
    sql: `
-- 可控事件：她开始做某件事（睡觉/吃饭/洗澡…），用户可以控制它什么时候结束；到期她会主动来消息
CREATE TABLE IF NOT EXISTS ongoing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  activity TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'other',
  started_at TEXT NOT NULL,
  expected_end_at TEXT,
  duration_mode TEXT NOT NULL DEFAULT 'smart',
  notified_at TEXT,
  ended_at TEXT,
  end_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ongoing_events_user ON ongoing_events(user_id, ended_at);
`,
  },
  {
    version: 10,
    name: 'add_missing_indices',
    sql: `
-- 高频过滤/排序缺索引：补上（只加索引，不动数据）
CREATE INDEX IF NOT EXISTS idx_conflict_logs_user_status ON conflict_logs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_relationship_logs_user_time ON relationship_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_personality_logs_user_time ON personality_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attachment_logs_user_time ON attachment_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_proactive ON messages(user_id, is_proactive);
CREATE INDEX IF NOT EXISTS idx_memories_source_msg ON memories(source_message_id);
`,
  },
  {
    version: 11,
    name: 'cast_and_life_arc_and_diaries',
    sql: `
-- 具名社会关系（她身边的人）：存 JSON 数组 [{name, role, note}]
ALTER TABLE shared_world ADD COLUMN cast_json TEXT;

-- 跨天剧情线：她这几天正在忙的一件事
CREATE TABLE IF NOT EXISTS life_arcs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  progress INTEGER NOT NULL DEFAULT 0,
  planned_days INTEGER NOT NULL DEFAULT 5,
  meta_json TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_life_arcs_user_status ON life_arcs(user_id, status);

-- 她的日记：每天一条，第一人称
CREATE TABLE IF NOT EXISTS agent_diaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_diaries_user_date ON agent_diaries(user_id, date);
`,
  },
  {
    version: 12,
    name: 'turn_generation_ledger_and_durable_analysis_jobs',
    sql: `
-- 回合 / 生成 / 操作账本 / 持久化分析任务：把"这一轮到底发生了什么、属于哪次生成"变成可查询的事实源
-- （只加表、加列、加索引，不改动任何历史数据）

-- 一轮对话（一个用户消息 = 一个 turn；重新生成不新增 turn，只新增 generation）
CREATE TABLE IF NOT EXISTS conversation_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  user_message_id INTEGER,
  current_generation_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversation_turns_user ON conversation_turns(user_id, sequence);

-- 同一次用户消息下的各次生成（重新生成 = 新 generation，旧的标 superseded）
CREATE TABLE IF NOT EXISTS message_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  turn_id INTEGER NOT NULL,
  generation_no INTEGER NOT NULL,
  assistant_message_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_generations_turn ON message_generations(turn_id, generation_no);

-- 分析任务持久化：服务器重启后未完成的任务自动恢复，不再静默丢失
CREATE TABLE IF NOT EXISTS analysis_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  turn_id INTEGER,
  generation_id INTEGER,
  user_message_id INTEGER,
  assistant_message_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_status ON analysis_jobs(user_id, status, id);

-- 操作账本：每个真实状态变化的精确记录（删除/重新生成时按 operation 精确反向，不再靠推断）
CREATE TABLE IF NOT EXISTS turn_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  turn_id INTEGER,
  generation_id INTEGER,
  operation_type TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_id INTEGER,
  before_json TEXT,
  after_json TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_operations_gen ON turn_operations(generation_id);
CREATE INDEX IF NOT EXISTS idx_turn_operations_turn ON turn_operations(turn_id, id);

-- 场景可信度 / 来源 / 过期时间（场景不再"一次切换永久保持"）
ALTER TABLE relationship_state ADD COLUMN scene_confidence REAL;
ALTER TABLE relationship_state ADD COLUMN scene_source TEXT;
ALTER TABLE relationship_state ADD COLUMN scene_expires_at TEXT;

-- 记忆事实键（fact_key 主判 + 向量辅助判重的长期方案）
ALTER TABLE memories ADD COLUMN fact_key TEXT;

-- 人格/依恋调整的归因：这次调整实际来自哪些回合 / 哪些信号（避免"归到当前消息"）
ALTER TABLE personality_logs ADD COLUMN source_turns TEXT;
ALTER TABLE personality_logs ADD COLUMN contributing_signal_ids TEXT;
ALTER TABLE attachment_logs ADD COLUMN source_turns TEXT;

-- 此刻情绪（ad-hoc affect）：与长期指标分家，带时效（过期即忽略）
ALTER TABLE relationship_state ADD COLUMN affect_json TEXT;
`,
  },
  {
    version: 13,
    name: 'companion_isolation_columns_and_new_tables',
    sql: `
-- v13：引入伴侣隔离维度 companion_id
--   (1) 为既有"按伴侣隔离"的表补 companion_id 列（NOT NULL DEFAULT 1 → 既有行自动回填主女友）；
--   (2) 新建 10 张伴侣域 / 群聊 / 活动表（结构见架构 §2.3）；
--   (3) 补索引。
-- 本迁移为纯"加列 / 加表 / 加索引"，不含破坏性操作（故无需 -- safe:）。

-- ===== (1) B 类：24 张既有表加 companion_id（默认 1 = 主女友）=====
ALTER TABLE personas ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE messages ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE relationship_logs ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE emotional_bank ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE personality_signals ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE personality_logs ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE attachment_signals ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE attachment_logs ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE conflict_logs ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE proactive_messages ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE turn_effects ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_daily_events ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE life_state_logs ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE intimacy_preferences ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE intimacy_aftercare ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ongoing_events ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE life_arcs ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE conversation_turns ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE message_generations ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE analysis_jobs ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE turn_operations ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_diaries ADD COLUMN companion_id INTEGER NOT NULL DEFAULT 1;

-- ===== (2) 新建 10 张表 =====
-- 伴侣档案（角色卡 + 攻略状态机载体）；age 的 CHECK(age>=18) 是 18+ 硬红线
CREATE TABLE IF NOT EXISTS companions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  age INTEGER NOT NULL CHECK (age >= 18),
  gender TEXT NOT NULL DEFAULT 'female',
  identity TEXT,
  personality_tags TEXT,
  portrait_desc TEXT,
  avatar_url TEXT,
  intro TEXT,
  first_meet_scene TEXT,
  gen_seed TEXT,
  dedupe_hash TEXT,
  status TEXT NOT NULL DEFAULT 'stranger',
  attraction REAL NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  is_discovered INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  pursue_opt_in INTEGER NOT NULL DEFAULT 0,
  reject_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT,
  established_at TEXT,
  closed_at TEXT,
  last_active_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companions_dedupe ON companions(dedupe_hash) WHERE dedupe_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companions_user_status ON companions(user_id, status, is_discovered);

-- 伴侣间关系边（-100..100）
CREATE TABLE IF NOT EXISTS companion_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  a_id INTEGER NOT NULL,
  b_id INTEGER NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'neutral',
  last_event_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(a_id, b_id),
  CHECK (a_id < b_id),
  CHECK (value >= -100 AND value <= 100)
);
CREATE INDEX IF NOT EXISTS idx_companion_relations_a ON companion_relations(a_id);
CREATE INDEX IF NOT EXISTS idx_companion_relations_b ON companion_relations(b_id);

-- 伴侣事件日志（认识/攻略/被拒/晋升/关系变化/活动）
CREATE TABLE IF NOT EXISTS companion_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  companion_id INTEGER,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companion_events_c ON companion_events(companion_id, created_at);

-- 群聊
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  topic TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  companion_id INTEGER NOT NULL,
  joined_at TEXT NOT NULL,
  UNIQUE(group_id, companion_id)
);

CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  companion_id INTEGER,
  speaker_type TEXT NOT NULL,
  speaker_name TEXT,
  content TEXT NOT NULL,
  reaction TEXT,
  round INTEGER NOT NULL DEFAULT 0,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_messages_g ON group_messages(group_id, id);

-- 一次群聊/活动会话（轮数上限、中止、调度状态）
CREATE TABLE IF NOT EXISTS group_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  activity_id INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  round INTEGER NOT NULL DEFAULT 0,
  max_rounds INTEGER NOT NULL DEFAULT 12,
  last_speaker_id INTEGER,
  recent_speakers TEXT,
  spoke_counts TEXT,
  ended_reason TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

-- 活动（线上 / 线下）
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  group_id INTEGER,
  kind TEXT NOT NULL,
  template_key TEXT,
  title TEXT NOT NULL,
  scene TEXT NOT NULL DEFAULT 'online',
  scheduled_at TEXT,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  focus_companion_id INTEGER,
  summary TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_user ON activities(user_id, status);

CREATE TABLE IF NOT EXISTS activity_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL,
  companion_id INTEGER NOT NULL,
  joined_at TEXT NOT NULL,
  UNIQUE(activity_id, companion_id)
);

-- 线下「约会日程」条目
CREATE TABLE IF NOT EXISTS activity_schedule_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_schedule_a ON activity_schedule_items(activity_id, seq);
`,
  },
  {
    version: 14,
    name: 'companion_pk_rebuild_and_diary_index',
    sql: `
-- v14：把 14 张「主键或唯一约束」必须纳入 companion_id 的表做表重建（SQLite 无法修改主键）。
-- safe: 主键/唯一约束需纳入 companion_id，SQLite 无法修改主键 → 采用「新建→拷全列→DROP→改名」；
--       既有行 companion_id 一律回填 1（主女友），列与数据 1:1 完整保留，不丢任何字段；
--       全部语句写在同一个迁移事务内（BEGIN…COMMIT）→ 原子，任一步失败即整体回滚、版本不记录，
--       下次启动重跑，不会产生半成品。DROP TABLE 均为重建配方的一部分。
-- 另：agent_diaries（PK=id，无需重建）仅把唯一索引从 (user_id,date) 改为 (companion_id,date)。

-- ============ (1) relationship_state（含 v3 场景列 + v12 新列）============
DROP TABLE IF EXISTS relationship_state_new;
CREATE TABLE relationship_state_new (
  companion_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  intimacy REAL NOT NULL DEFAULT 0,
  trust REAL NOT NULL DEFAULT 0,
  mood TEXT NOT NULL DEFAULT '平静',
  stage INTEGER NOT NULL DEFAULT 0,
  stage_entered_at TEXT,
  stage_cap_since TEXT,
  pending_stage_confirm INTEGER NOT NULL DEFAULT 0,
  pending_relationship_talk INTEGER NOT NULL DEFAULT 0,
  conflict_state TEXT NOT NULL DEFAULT 'none',
  last_conflict_at TEXT,
  nickname TEXT,
  anniversary TEXT,
  last_interaction_at TEXT,
  streak_days INTEGER NOT NULL DEFAULT 0,
  emotional_balance REAL NOT NULL DEFAULT 0,
  repair_credit REAL NOT NULL DEFAULT 0,
  unresolved_tension REAL NOT NULL DEFAULT 0,
  scene TEXT NOT NULL DEFAULT 'online',
  scene_reason TEXT,
  scene_updated_at TEXT,
  scene_confidence REAL,
  scene_source TEXT,
  scene_expires_at TEXT,
  affect_json TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO relationship_state_new
  (companion_id, user_id, intimacy, trust, mood, stage, stage_entered_at, stage_cap_since,
   pending_stage_confirm, pending_relationship_talk, conflict_state, last_conflict_at, nickname,
   anniversary, last_interaction_at, streak_days, emotional_balance, repair_credit,
   unresolved_tension, scene, scene_reason, scene_updated_at, scene_confidence, scene_source,
   scene_expires_at, affect_json, updated_at)
  SELECT 1, user_id, intimacy, trust, mood, stage, stage_entered_at, stage_cap_since,
   pending_stage_confirm, pending_relationship_talk, conflict_state, last_conflict_at, nickname,
   anniversary, last_interaction_at, streak_days, emotional_balance, repair_credit,
   unresolved_tension, scene, scene_reason, scene_updated_at, scene_confidence, scene_source,
   scene_expires_at, affect_json, updated_at
  FROM relationship_state;
DROP TABLE relationship_state;
ALTER TABLE relationship_state_new RENAME TO relationship_state;

-- ============ (2) personality_state（PK 改 (companion_id, dimension)）============
DROP TABLE IF EXISTS personality_state_new;
CREATE TABLE personality_state_new (
  companion_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 1,
  dimension TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 50,
  solidified INTEGER NOT NULL DEFAULT 0,
  last_adjusted_turn INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (companion_id, dimension)
);
INSERT INTO personality_state_new (companion_id, user_id, dimension, value, solidified, last_adjusted_turn, updated_at)
  SELECT 1, user_id, dimension, value, solidified, last_adjusted_turn, updated_at FROM personality_state;
DROP TABLE personality_state;
ALTER TABLE personality_state_new RENAME TO personality_state;

-- ============ (3) attachment_state ============
DROP TABLE IF EXISTS attachment_state_new;
CREATE TABLE attachment_state_new (
  companion_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  anxiety REAL NOT NULL DEFAULT 30,
  avoidance REAL NOT NULL DEFAULT 30,
  style TEXT NOT NULL DEFAULT 'secure',
  updated_at TEXT NOT NULL
);
INSERT INTO attachment_state_new (companion_id, user_id, anxiety, avoidance, style, updated_at)
  SELECT 1, user_id, anxiety, avoidance, style, updated_at FROM attachment_state;
DROP TABLE attachment_state;
ALTER TABLE attachment_state_new RENAME TO attachment_state;

-- ============ (4) personality_snapshots（UNIQUE(companion_id, week)）============
DROP TABLE IF EXISTS personality_snapshots_new;
CREATE TABLE personality_snapshots_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  companion_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL DEFAULT 1,
  week TEXT NOT NULL,
  values_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(companion_id, week)
);
INSERT INTO personality_snapshots_new (id, companion_id, user_id, week, values_json, created_at)
  SELECT id, 1, user_id, week, values_json, created_at FROM personality_snapshots;
DROP TABLE personality_snapshots;
ALTER TABLE personality_snapshots_new RENAME TO personality_snapshots;

-- ============ (5) daily_summaries（UNIQUE(companion_id, date)）============
DROP TABLE IF EXISTS daily_summaries_new;
CREATE TABLE daily_summaries_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  companion_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL DEFAULT 1,
  date TEXT NOT NULL,
  summary TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(companion_id, date)
);
INSERT INTO daily_summaries_new (id, companion_id, user_id, date, summary, meta, created_at)
  SELECT id, 1, user_id, date, summary, meta, created_at FROM daily_summaries;
DROP TABLE daily_summaries;
ALTER TABLE daily_summaries_new RENAME TO daily_summaries;

-- ============ (6) agent_profile ============
DROP TABLE IF EXISTS agent_profile_new;
CREATE TABLE agent_profile_new (
  companion_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  name TEXT, nickname TEXT, age TEXT, birthday TEXT,
  hometown TEXT, city TEXT, family TEXT, education TEXT, job TEXT,
  hobbies TEXT, habits TEXT, catchphrases TEXT, fears TEXT, dreams TEXT, secrets TEXT,
  reveal_status TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO agent_profile_new
  (companion_id, user_id, name, nickname, age, birthday, hometown, city, family, education, job,
   hobbies, habits, catchphrases, fears, dreams, secrets, reveal_status, updated_at)
  SELECT 1, user_id, name, nickname, age, birthday, hometown, city, family, education, job,
   hobbies, habits, catchphrases, fears, dreams, secrets, reveal_status, updated_at
  FROM agent_profile;
DROP TABLE agent_profile;
ALTER TABLE agent_profile_new RENAME TO agent_profile;

-- ============ (7) agent_health ============
DROP TABLE IF EXISTS agent_health_new;
CREATE TABLE agent_health_new (
  companion_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  energy REAL NOT NULL DEFAULT 80,
  sleep_quality REAL NOT NULL DEFAULT 80,
  hunger REAL NOT NULL DEFAULT 70,
  illness TEXT NOT NULL DEFAULT 'none',
  illness_start TEXT,
  illness_duration_days REAL,
  illness_severity REAL NOT NULL DEFAULT 0,
  cared_count INTEGER NOT NULL DEFAULT 0,
  cycle_enabled INTEGER NOT NULL DEFAULT 1,
  cycle_day INTEGER NOT NULL DEFAULT 1,
  cycle_length INTEGER NOT NULL DEFAULT 28,
  exercise REAL NOT NULL DEFAULT 50,
  last_meal_at TEXT,
  last_sleep_at TEXT,
  woke_at TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO agent_health_new
  (companion_id, user_id, energy, sleep_quality, hunger, illness, illness_start, illness_duration_days,
   illness_severity, cared_count, cycle_enabled, cycle_day, cycle_length, exercise,
   last_meal_at, last_sleep_at, woke_at, updated_at)
  SELECT 1, user_id, energy, sleep_quality, hunger, illness, illness_start, illness_duration_days,
   illness_severity, cared_count, cycle_enabled, cycle_day, cycle_length, exercise,
   last_meal_at, last_sleep_at, woke_at, updated_at
  FROM agent_health;
DROP TABLE agent_health;
ALTER TABLE agent_health_new RENAME TO agent_health;

-- ============ (8) agent_psychology ============
DROP TABLE IF EXISTS agent_psychology_new;
CREATE TABLE agent_psychology_new (
  companion_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  base_emotion TEXT NOT NULL DEFAULT '平静',
  stress REAL NOT NULL DEFAULT 20,
  loneliness REAL NOT NULL DEFAULT 20,
  missing_user REAL NOT NULL DEFAULT 30,
  security REAL NOT NULL DEFAULT 60,
  self_worth REAL NOT NULL DEFAULT 65,
  mental_energy REAL NOT NULL DEFAULT 70,
  updated_at TEXT NOT NULL
);
INSERT INTO agent_psychology_new
  (companion_id, user_id, base_emotion, stress, loneliness, missing_user, security, self_worth, mental_energy, updated_at)
  SELECT 1, user_id, base_emotion, stress, loneliness, missing_user, security, self_worth, mental_energy, updated_at
  FROM agent_psychology;
DROP TABLE agent_psychology;
ALTER TABLE agent_psychology_new RENAME TO agent_psychology;

-- ============ (9) agent_location ============
DROP TABLE IF EXISTS agent_location_new;
CREATE TABLE agent_location_new (
  companion_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  current_location TEXT NOT NULL DEFAULT '家',
  location_type TEXT NOT NULL DEFAULT 'home',
  arrived_at TEXT,
  expected_leave_at TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO agent_location_new
  (companion_id, user_id, current_location, location_type, arrived_at, expected_leave_at, updated_at)
  SELECT 1, user_id, current_location, location_type, arrived_at, expected_leave_at, updated_at
  FROM agent_location;
DROP TABLE agent_location;
ALTER TABLE agent_location_new RENAME TO agent_location;

-- ============ (10) agent_activity ============
DROP TABLE IF EXISTS agent_activity_new;
CREATE TABLE agent_activity_new (
  companion_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  current_activity TEXT NOT NULL DEFAULT '发呆',
  activity_type TEXT NOT NULL DEFAULT 'idle',
  started_at TEXT,
  expected_end_at TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO agent_activity_new
  (companion_id, user_id, current_activity, activity_type, started_at, expected_end_at, updated_at)
  SELECT 1, user_id, current_activity, activity_type, started_at, expected_end_at, updated_at
  FROM agent_activity;
DROP TABLE agent_activity;
ALTER TABLE agent_activity_new RENAME TO agent_activity;

-- ============ (11) shared_world（含 v11 cast_json）============
DROP TABLE IF EXISTS shared_world_new;
CREATE TABLE shared_world_new (
  companion_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  shared_places_json TEXT,
  shared_plans_json TEXT,
  shared_rituals_json TEXT,
  shared_items_json TEXT,
  updated_at TEXT NOT NULL,
  cast_json TEXT
);
INSERT INTO shared_world_new
  (companion_id, user_id, shared_places_json, shared_plans_json, shared_rituals_json, shared_items_json, updated_at, cast_json)
  SELECT 1, user_id, shared_places_json, shared_plans_json, shared_rituals_json, shared_items_json, updated_at, cast_json
  FROM shared_world;
DROP TABLE shared_world;
ALTER TABLE shared_world_new RENAME TO shared_world;

-- ============ (12) intimacy_state ============
DROP TABLE IF EXISTS intimacy_state_new;
CREATE TABLE intimacy_state_new (
  companion_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  libido REAL NOT NULL DEFAULT 30,
  intimacy_need REAL NOT NULL DEFAULT 35,
  sexual_satisfaction REAL NOT NULL DEFAULT 50,
  sexual_stress REAL NOT NULL DEFAULT 20,
  aftercare_until TEXT,
  aftercare_state TEXT,
  last_intimacy_at TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO intimacy_state_new
  (companion_id, user_id, libido, intimacy_need, sexual_satisfaction, sexual_stress,
   aftercare_until, aftercare_state, last_intimacy_at, updated_at)
  SELECT 1, user_id, libido, intimacy_need, sexual_satisfaction, sexual_stress,
   aftercare_until, aftercare_state, last_intimacy_at, updated_at
  FROM intimacy_state;
DROP TABLE intimacy_state;
ALTER TABLE intimacy_state_new RENAME TO intimacy_state;

-- ============ (13) intimacy_content_level ============
DROP TABLE IF EXISTS intimacy_content_level_new;
CREATE TABLE intimacy_content_level_new (
  companion_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  level INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
INSERT INTO intimacy_content_level_new (companion_id, user_id, level, updated_at)
  SELECT 1, user_id, level, updated_at FROM intimacy_content_level;
DROP TABLE intimacy_content_level;
ALTER TABLE intimacy_content_level_new RENAME TO intimacy_content_level;

-- ============ (14) world_weekly_snapshots（UNIQUE(companion_id, week)）============
DROP TABLE IF EXISTS world_weekly_snapshots_new;
CREATE TABLE world_weekly_snapshots_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  companion_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL DEFAULT 1,
  week TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(companion_id, week)
);
INSERT INTO world_weekly_snapshots_new (id, companion_id, user_id, week, state_json, created_at)
  SELECT id, 1, user_id, week, state_json, created_at FROM world_weekly_snapshots;
DROP TABLE world_weekly_snapshots;
ALTER TABLE world_weekly_snapshots_new RENAME TO world_weekly_snapshots;

-- ============ agent_diaries：仅改唯一索引（PK=id，无需重建）============
DROP INDEX IF EXISTS idx_agent_diaries_user_date;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_diaries_companion_date ON agent_diaries(companion_id, date);
`,
  },
  {
    version: 15,
    name: 'companion_origin',
    sql: `
-- 候选人/伴侣的「来历」：谁介绍、在哪认识（用于通讯录展示与关系网初始化）。
--   origin_kind: 'cast'（她的室友/同事/朋友等身边人升格）| 'auto'（交往中被自动识别）| 'random'（陌生人）| NULL（主女友/老数据）
--   origin_companion_id: 通过哪位伴侣认识（cast/auto 时有值），晋升时据此建立初始伴侣关系边
ALTER TABLE companions ADD COLUMN origin_kind TEXT;
ALTER TABLE companions ADD COLUMN origin_companion_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_companions_origin ON companions(origin_kind, origin_companion_id);
`,
  },
];
