// SQLite 数据库层：全部表结构迁移 + 单例连接 + 设置读写
// 使用 Node 24 内置的 node:sqlite，零原生依赖，开箱即跑。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './utils';

export const DEFAULT_USER_ID = 1;

type AnyRow = Record<string, any>;

/* ------------------------------------------------------------------ */
/* 迁移定义（每次结构变化追加一条，不要修改历史条目）                    */
/* ------------------------------------------------------------------ */
interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
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

UPDATE intimacy_content_level SET age_confirmed = 0;
UPDATE settings SET value = 'false', updated_at = datetime('now') WHERE key = 'age_confirmed';
`,
  },
  {
    version: 8,
    name: 'remove_intimacy_safety_controls',
    sql: `
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
];

/* ------------------------------------------------------------------ */
/* 连接单例                                                            */
/* ------------------------------------------------------------------ */
declare global {
  // eslint-disable-next-line no-var
  var __gfDb: DatabaseSync | undefined;
}

function resolveDbPath(): string {
  const p = process.env.DB_PATH || 'data/girlfriend.db';
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function createDb(): DatabaseSync {
  const file = resolveDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // 用足本机资源：WAL + 内存缓存 + mmap（你的机器内存大，这些几乎不影响内存占用但明显更快）
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA cache_size = -64000;'); // 约 64MB 页缓存
  db.exec('PRAGMA mmap_size = 268435456;'); // 256MB mmap
  db.exec('PRAGMA temp_store = MEMORY;');
  migrate(db);
  seed(db);
  return db;
}

function migrate(db: DatabaseSync) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);'
  );
  const applied = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as AnyRow[]).map((r) => Number(r.version))
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      // 迁移容错：对 "ALTER TABLE x DROP COLUMN y" 先查列是否存在，不存在就跳过
      // （SQLite 不支持 DROP COLUMN IF EXISTS；历史分叉/手工改库导致列缺失时，原来会直接崩在启动阶段）
      const cols = new Map<string, Set<string>>();
      const guarded = m.sql.replace(/ALTER TABLE\s+(\w+)\s+DROP COLUMN\s+(\w+)\s*;/gi, (stmt, table, col) => {
        if (!cols.has(table)) {
          const rows = db.prepare(`PRAGMA table_info(${table})`).all() as AnyRow[];
          cols.set(table, new Set(rows.map((r) => String(r.name))));
        }
        return cols.get(table)!.has(col) ? stmt : `-- skipped (column ${table}.${col} not present)`;
      });
      db.exec(guarded);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        nowIso()
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export const DEFAULT_SETTINGS: Record<string, string> = {
  // 身份
  agent_name: '', // 空 = 尚未命名，由用户赋予或共同创造
  user_name: '',
  user_profile: '', // 用户自述画像（可编辑）
  agent_story: '', // 共同创造的她的故事
  // 性格开放度（0-1，越大越容易变化）
  personality_openness: '1',
  // 主动消息
  proactive_frequency: 'medium', // off | low | medium | high
  quiet_start: '23:00',
  quiet_end: '08:00',
  dnd: 'off',
  // 关系
  stage_dwell_days: '3',
  // 上下文
  context_size: '20',
  memory_top_k: '8',
  // 场景：auto=智能识别 / online=强制线上 / offline=强制线下
  scene_mode: 'auto',
  // 她的生活系统
  life_enabled: 'true',
  cycle_enabled: 'true',
  life_share_chance: '0.6',
  // 亲密系统
  intimacy_level: '0',
  // 模型
  llm_base_url: '',
  llm_api_key: '',
  llm_model: '',
  llm_analysis_model: '',
  embedding_model: '',
  embedding_base_url: '',
  embedding_api_key: '',
  // 注意：analysis_thinking 不在这里播种（否则 llmConfig 的"未设置→读环境变量"永远走不到）
};

function seed(db: DatabaseSync) {
  const now = nowIso();
  db.prepare('INSERT OR IGNORE INTO users (id, name, created_at) VALUES (?, ?, ?)').run(
    DEFAULT_USER_ID,
    '你',
    now
  );
  db.prepare(
    'INSERT OR IGNORE INTO personas (id, user_id, agent_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(1, DEFAULT_USER_ID, null, now, now);
  db.prepare(
    `INSERT OR IGNORE INTO relationship_state
     (user_id, intimacy, trust, mood, stage, stage_entered_at, stage_cap_since, pending_stage_confirm,
      pending_relationship_talk, conflict_state, last_conflict_at, nickname, anniversary,
      last_interaction_at, streak_days, emotional_balance, repair_credit, unresolved_tension, updated_at)
     VALUES (?, 0, 0, '好奇', 0, ?, NULL, 0, 0, 'none', NULL, NULL, NULL, NULL, 0, 0, 0, 0, ?)`
  ).run(DEFAULT_USER_ID, now, now);
  db.prepare(
    'INSERT OR IGNORE INTO attachment_state (user_id, anxiety, avoidance, style, updated_at) VALUES (?, 30, 30, ?, ?)'
  ).run(DEFAULT_USER_ID, 'secure', now);

  const dims = ['warmth', 'playfulness', 'romance', 'directness', 'independence', 'emotional_intensity'];
  const insDim = db.prepare(
    `INSERT OR IGNORE INTO personality_state (user_id, dimension, value, solidified, last_adjusted_turn, updated_at)
     VALUES (?, ?, 50, 0, 0, ?)`
  );
  for (const d of dims) insDim.run(DEFAULT_USER_ID, d, now);

  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v, now);
}

export function getDb(): DatabaseSync {
  if (!globalThis.__gfDb) {
    globalThis.__gfDb = createDb();
  }
  return globalThis.__gfDb;
}

/* ------------------------------------------------------------------ */
/* 查询辅助（统一处理 undefined / boolean 参数）                        */
/* ------------------------------------------------------------------ */
function normalize(args: any[]): any[] {
  return args.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
}

export function dbAll<T = AnyRow>(sql: string, ...params: any[]): T[] {
  const stmt = getDb().prepare(sql);
  return stmt.all(...(normalize(params) as any[])) as unknown as T[];
}

export function dbGet<T = AnyRow>(sql: string, ...params: any[]): T | undefined {
  const stmt = getDb().prepare(sql);
  return stmt.get(...(normalize(params) as any[])) as unknown as T | undefined;
}

export function dbRun(sql: string, ...params: any[]): { changes: number; lastInsertRowid: number } {
  const stmt = getDb().prepare(sql);
  const r = stmt.run(...(normalize(params) as any[]));
  return {
    changes: Number(r.changes),
    lastInsertRowid: Number(r.lastInsertRowid),
  };
}

export function tx<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */
export function getSetting(key: string): string | null {
  const row = dbGet<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  if (row) return row.value;
  return key in DEFAULT_SETTINGS ? DEFAULT_SETTINGS[key] : null;
}

/** 自定义模式：数值直控（关闭一切自动改写关系/性格/依恋/亲密数值的机制） */
export function customModeOn(): boolean {
  try {
    const v = getSetting('custom_mode');
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

export function setSetting(key: string, value: string): void {
  dbRun(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    String(value ?? ''),
    nowIso()
  );
}

export function getAllSettings(): Record<string, string> {
  const rows = dbAll<{ key: string; value: string }>('SELECT key, value FROM settings');
  const out: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/* ------------------------------------------------------------------ */
/* 敏感项掩码：读取给前端时只回传掩码，写入时忽略掩码值                  */
/* ------------------------------------------------------------------ */
export const SECRET_SETTING_KEYS = ['llm_api_key', 'embedding_api_key'];

export function maskSecret(value: string | null | undefined): string {
  const v = String(value || '');
  if (!v) return '';
  if (v.length <= 4) return '••••';
  return `••••••••${v.slice(-4)}`;
}

export function looksLikeMask(value: unknown): boolean {
  return typeof value === 'string' && value.includes('•');
}

/** 给前端展示用的设置副本（API Key 只回传掩码，明文不出后端） */
export function maskSettingsForClient(settings: Record<string, string>): Record<string, string> {
  const out = { ...settings };
  for (const k of SECRET_SETTING_KEYS) {
    if (out[k]) out[k] = maskSecret(out[k]);
  }
  return out;
}

export function numSetting(key: string, def: number): number {
  const v = getSetting(key);
  const n = Number(v);
  return isFinite(n) && v !== null && v !== '' ? n : def;
}

export function boolSetting(key: string, def: boolean): boolean {
  const v = getSetting(key);
  if (v === null || v === '') return def;
  return v === 'true' || v === '1' || v === 'on';
}

/* ------------------------------------------------------------------ */
/* 计数器                                                              */
/* ------------------------------------------------------------------ */
export function getCounter(key: string): number {
  const row = dbGet<{ value: number }>('SELECT value FROM counters WHERE key = ?', key);
  return row ? Number(row.value) : 0;
}

export function bumpCounter(key: string, by = 1): number {
  dbRun(
    `INSERT INTO counters (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
    key,
    by
  );
  return getCounter(key);
}

export function setCounter(key: string, value: number): void {
  dbRun(
    `INSERT INTO counters (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value
  );
}

/* ------------------------------------------------------------------ */
/* 模型配置（数据库设置优先，其次环境变量）                             */
/* ------------------------------------------------------------------ */
export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  analysisModel: string;
  embeddingModel: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  analysisThinking: boolean;
}

export function llmConfig(): LlmConfig {
  const baseUrl = (getSetting('llm_base_url') || process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = getSetting('llm_api_key') || process.env.LLM_API_KEY || '';
  const model = getSetting('llm_model') || process.env.LLM_MODEL || 'qwen3.8-27b';
  const analysisModel =
    getSetting('llm_analysis_model') || process.env.LLM_ANALYSIS_MODEL || model;
  const embeddingModel = getSetting('embedding_model') || process.env.EMBEDDING_MODEL || '';
  // 向量接口可以单独配置（换聊天模型时保持记忆向量一致）
  const embeddingBaseUrl = (getSetting('embedding_base_url') || baseUrl).replace(/\/+$/, '');
  const embeddingApiKey = getSetting('embedding_api_key') || apiKey;
  const thinkingRaw = getSetting('analysis_thinking');
  const analysisThinking =
    thinkingRaw === null || thinkingRaw === ''
      ? process.env.ANALYSIS_THINKING === 'true'
      : thinkingRaw === 'true';
  return {
    baseUrl,
    apiKey,
    model,
    analysisModel,
    embeddingModel,
    embeddingBaseUrl,
    embeddingApiKey,
    analysisThinking,
  };
}

/** 清空所有业务数据（保留设置），用于"清除数据" */
export function wipeAllData(keepSettings = true): void {
  const db = getDb();
  const tables = [
    'messages',
    'memories',
    'memory_embeddings',
    'relationship_logs',
    'emotional_bank',
    'daily_summaries',
    'events',
    'personality_signals',
    'personality_logs',
    'personality_snapshots',
    'attachment_signals',
    'attachment_logs',
    'conflict_logs',
    'proactive_messages',
    'turn_effects',
    'counters',
    'agent_daily_events',
    'life_state_logs',
    'ongoing_events',
    'intimacy_aftercare',
    'intimacy_preferences',
    'world_weekly_snapshots',
  ];
  db.exec('BEGIN');
  try {
    for (const t of tables) db.exec(`DELETE FROM ${t};`);
    db.exec('DELETE FROM relationship_state;');
    db.exec('DELETE FROM attachment_state;');
    db.exec('DELETE FROM personality_state;');
    db.exec('DELETE FROM personas;');
    for (const t of ['agent_profile', 'agent_health', 'agent_psychology', 'agent_location', 'agent_activity', 'shared_world', 'intimacy_state', 'intimacy_content_level']) {
      db.exec(`DELETE FROM ${t};`);
    }
    if (!keepSettings) {
      db.exec('DELETE FROM settings;');
    } else {
      // personas 已清空，settings 里那份"镜像名字/故事"也要同步清掉，避免双源分叉
      db.exec("DELETE FROM settings WHERE key IN ('agent_name', 'agent_story');");
      // 重置"已播种"标记：清空数据后，她应该回到出厂偏好（否则会零偏好且不再播种）
      db.exec("DELETE FROM settings WHERE key = 'prefs_seeded';");
    }
    // seed 放进同一个事务：中途失败就整体回滚，不会出现"库已清空但只重建了一半"
    seed(db);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (keepSettings) {
    setSetting('intimacy_level', '0');
  }
}