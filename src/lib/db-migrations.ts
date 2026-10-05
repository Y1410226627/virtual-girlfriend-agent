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
];
