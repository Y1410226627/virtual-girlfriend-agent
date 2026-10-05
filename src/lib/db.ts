// SQLite 数据库层：全部表结构迁移 + 单例连接 + 设置读写
// 使用 Node 24 内置的 node:sqlite，零原生依赖，开箱即跑。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './utils';
import { MIGRATIONS } from './db-migrations';

export const DEFAULT_USER_ID = 1;

type AnyRow = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* 连接单例                                                            */
/* ------------------------------------------------------------------ */
declare global {
   
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
/** SQLite 可绑定的参数类型（node:sqlite 只接受这些） */
type SqlValue = string | number | bigint | null | Uint8Array;

function normalize(args: unknown[]): SqlValue[] {
  return args.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v as SqlValue;
  });
}

export function dbAll<T = AnyRow>(sql: string, ...params: unknown[]): T[] {
  const stmt = getDb().prepare(sql);
  return stmt.all(...normalize(params)) as unknown as T[];
}

export function dbGet<T = AnyRow>(sql: string, ...params: unknown[]): T | undefined {
  const stmt = getDb().prepare(sql);
  return stmt.get(...normalize(params)) as unknown as T | undefined;
}

export function dbRun(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
  const stmt = getDb().prepare(sql);
  const r = stmt.run(...normalize(params));
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
  return key in DEFAULT_SETTINGS ? DEFAULT_SETTINGS[key]! : null;
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