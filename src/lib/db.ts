// SQLite 数据库层：全部表结构迁移 + 单例连接 + 设置读写
// 使用 Node 24 内置的 node:sqlite，零原生依赖，开箱即跑。
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './utils';
import { MIGRATIONS } from './db-migrations';
import { cId, PRIMARY_COMPANION_ID } from './companion-context';

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

/* ------------------------------------------------------------------ */
/* 预编译语句缓存：同一条 SQL 复用同一个 statement，避免每次查询都 prepare */
/* 仅覆盖 dbAll/dbGet/dbRun；DDL / 迁移仍直接用 db.prepare，不进缓存。   */
/* key = SQL 串；LRU 上限 200 条，超出淘汰最久未用的一条。               */
/* ------------------------------------------------------------------ */
const STATEMENT_CACHE_LIMIT = 200;
const stmtCache = new Map<string, StatementSync>();

function prepareCached(db: DatabaseSync, sql: string): StatementSync {
  const cached = stmtCache.get(sql);
  if (cached) {
    // 命中后移到队尾（Map 保持插入顺序，队首即最久未用）
    stmtCache.delete(sql);
    stmtCache.set(sql, cached);
    return cached;
  }
  const stmt = db.prepare(sql);
  if (stmtCache.size >= STATEMENT_CACHE_LIMIT) {
    const oldest = stmtCache.keys().next().value;
    if (oldest !== undefined) stmtCache.delete(oldest);
  }
  stmtCache.set(sql, stmt);
  return stmt;
}

function createDb(): DatabaseSync {
  // 新连接：清掉可能残留的旧语句缓存（旧 connection 的 statement 不可复用）
  stmtCache.clear();
  const file = resolveDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // 用足本机资源：WAL + 内存缓存 + mmap（你的机器内存大，这些几乎不影响内存占用但明显更快）
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA cache_size = -64000;'); // 约 64MB 页缓存
  db.exec('PRAGMA mmap_size = 268435456;'); // 256MB mmap
  db.exec('PRAGMA temp_store = MEMORY;');
  // 写-写竞争时等待锁释放（默认 0 会立即抛 SQLITE_BUSY 不重试）。
  // 本应用有 scheduler / proactive / analysisQueue / life-sim 多个后台任务共用同一连接，
  // 给 5 秒重试窗口，避免偶发并发写直接失败。
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  seed(db);
  return db;
}

function migrate(db: DatabaseSync) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);'
  );
  // 加载期校验：迁移版本必须严格递增，否则迁移顺序/已应用集合会错乱（不改历史条目，只做校验）
  for (let i = 1; i < MIGRATIONS.length; i++) {
    const prev = MIGRATIONS[i - 1]!;
    const cur = MIGRATIONS[i]!;
    if (cur.version <= prev.version) {
      throw new Error(
        `迁移版本号必须严格递增：v${prev.version}（${prev.name}）之后出现 v${cur.version}（${cur.name}）`
      );
    }
  }
  const applied = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as AnyRow[]).map((r) => Number(r.version))
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    try {
      // BEGIN 放进 try：开事务本身失败时也要走统一的错误路径，不能让它裸抛。
      // 用 BEGIN IMMEDIATE 先取写锁：`next build` 的 page-data collection 会并发起多个 worker，
      // 各自打开同一库并跑 migrate()。延迟事务在 WAL 下“读后升级写锁”会报 BUSY_SNAPSHOT
      // （表现为 "database is locked"，busy_timeout 不重试）；且并发窗口会让同一迁移被执行两次
      // （表现为 "duplicate column name"）。先取写锁即把并发迁移串行化。
      db.exec('BEGIN IMMEDIATE');
      // 拿到写锁后重新确认：并发场景下别的进程可能刚应用了这条迁移 → 直接提交并跳过（幂等）。
      if (db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(m.version)) {
        db.exec('COMMIT');
        continue;
      }
      // 迁移容错：对 "ALTER TABLE x DROP COLUMN y" 先查列是否存在，不存在就跳过
      // （SQLite 不支持 DROP COLUMN IF EXISTS；历史分叉/手工改库导致列缺失时，原来会直接崩在启动阶段）
      // 正则只匹配到列名为止（用前瞻断言语句终结符），因此列存在时原样返回、SQL 语义零改动；
      // 列名与终结符之间允许空白、注释、行尾或分号（含多行注释），避免"夹了注释就静默失效"。
      const cols = new Map<string, Set<string>>();
      let guarded = m.sql.replace(
        /ALTER TABLE\s+(\w+)\s+DROP COLUMN\s+(\w+)(?=(?:\s|--[^\n]*)*;)/gi,
        (stmt, table, col) => {
          if (!cols.has(table)) {
            const rows = db.prepare(`PRAGMA table_info(${table})`).all() as AnyRow[];
            cols.set(table, new Set(rows.map((r) => String(r.name))));
          }
          return cols.get(table)!.has(col)
            ? stmt
            : `-- skipped (column ${table}.${col} not present)`;
        }
      );
      // 裸 DROP TABLE（无 IF EXISTS）容错：缺表时报错会卡在启动阶段；补成 IF EXISTS。
      // 表存在时二者语义完全一致，仅对"对象缺失"更宽容，不改变正常路径行为。
      guarded = guarded.replace(/\bDROP\s+TABLE\s+(?!IF\s+EXISTS\b)(\w+)/gi, (_stmt, name) => `DROP TABLE IF EXISTS ${name}`);
      db.exec(guarded);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        nowIso()
      );
      db.exec('COMMIT');
    } catch (e) {
      // ROLLBACK 自身也可能抛（例如 BEGIN 就没成功、当前无活动事务）→ 吞掉它，保留原始错误
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 无活动事务时忽略，避免掩盖下面的原始错误 */
      }
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
  // 主女友档案（companion_id = PRIMARY_COMPANION_ID = 1）：全新库与老库升级都落到主女友。
  // age 取常量 24（>=18，满足 DB 层 CHECK(age>=18) 红线）；is_primary=1 标记「既有那份数据」。
  db.prepare(
    `INSERT OR IGNORE INTO companions
     (id, user_id, name, age, gender, status, is_primary, is_discovered, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'female', 'girlfriend', 1, 1, ?, ?)`
  ).run(PRIMARY_COMPANION_ID, DEFAULT_USER_ID, '她', 24, now, now);
  db.prepare(
    'INSERT OR IGNORE INTO personas (id, user_id, agent_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(1, DEFAULT_USER_ID, null, now, now);
  // 主键已由 user_id 改为 companion_id（见 v14 重建）→ 这里必须显式写 companion_id，
  // 否则 INSERT OR IGNORE 在重新 seed（每次进程启动 / wipe 后）时会因主键不冲突而插入重复行。
  db.prepare(
    `INSERT OR IGNORE INTO relationship_state
     (companion_id, user_id, intimacy, trust, mood, stage, stage_entered_at, stage_cap_since, pending_stage_confirm,
      pending_relationship_talk, conflict_state, last_conflict_at, nickname, anniversary,
      last_interaction_at, streak_days, emotional_balance, repair_credit, unresolved_tension, updated_at)
     VALUES (?, ?, 0, 0, '好奇', 0, ?, NULL, 0, 0, 'none', NULL, NULL, NULL, NULL, 0, 0, 0, 0, ?)`
  ).run(PRIMARY_COMPANION_ID, DEFAULT_USER_ID, now, now);
  db.prepare(
    'INSERT OR IGNORE INTO attachment_state (companion_id, user_id, anxiety, avoidance, style, updated_at) VALUES (?, ?, 30, 30, ?, ?)'
  ).run(PRIMARY_COMPANION_ID, DEFAULT_USER_ID, 'secure', now);

  const dims = ['warmth', 'playfulness', 'romance', 'directness', 'independence', 'emotional_intensity'];
  const insDim = db.prepare(
    `INSERT OR IGNORE INTO personality_state (companion_id, user_id, dimension, value, solidified, last_adjusted_turn, updated_at)
     VALUES (?, ?, ?, 50, 0, 0, ?)`
  );
  for (const d of dims) insDim.run(PRIMARY_COMPANION_ID, DEFAULT_USER_ID, d, now);

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

/**
 * 参数规整（有意设计，不是掩盖传参遗漏）：
 * node:sqlite 不接受 undefined / boolean，这里把 undefined 显式规整为 SQL NULL、boolean 规整为 0/1，
 * 让调用方可以自然地传值而不必处处判空/转换。因此"传 undefined"会落库为 NULL 是预期行为，
 * 而非把遗漏的参数悄悄掩盖——需要"保持原值"的语义请在业务层处理。
 */
function normalize(args: unknown[]): SqlValue[] {
  return args.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v as SqlValue;
  });
}

export function dbAll<T = AnyRow>(sql: string, ...params: unknown[]): T[] {
  const stmt = prepareCached(getDb(), sql);
  return stmt.all(...normalize(params)) as T[];
}

export function dbGet<T = AnyRow>(sql: string, ...params: unknown[]): T | undefined {
  const stmt = prepareCached(getDb(), sql);
  return stmt.get(...normalize(params)) as T | undefined;
}

export function dbRun(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
  const stmt = prepareCached(getDb(), sql);
  const r = stmt.run(...normalize(params));
  return {
    changes: Number(r.changes),
    lastInsertRowid: Number(r.lastInsertRowid),
  };
}

/* ------------------------------------------------------------------ */
/* 伴侣作用域存取器（cAll / cGet / cRun）                               */
/* ------------------------------------------------------------------ */
/**
 * 约定：伴侣域 SQL 把 `companion_id = ?` 写在 WHERE / 列清单的**最前**，
 * 由 cAll/cGet/cRun 自动把当前 cId() 注入为首个占位符参数。
 *
 * 例：
 *   cAll('SELECT * FROM messages WHERE companion_id = ? AND role = ? ORDER BY id', 'assistant')
 *   实际执行 dbAll('…', cId(), 'assistant')
 *
 * 说明：dbAll/dbGet/dbRun 的签名与语义保持不变（旧调用点零改动即落在主女友作用域）；
 * 这里只做「补一个前置参数」的薄封装，不改写 SQL，安全可审计、不破坏预编译缓存。
 */
export function cAll<T = AnyRow>(sql: string, ...params: unknown[]): T[] {
  return dbAll<T>(sql, cId(), ...params);
}

export function cGet<T = AnyRow>(sql: string, ...params: unknown[]): T | undefined {
  return dbGet<T>(sql, cId(), ...params);
}

export function cRun(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
  return dbRun(sql, cId(), ...params);
}

/**
 * 事务（可重入）：最外层用 BEGIN/COMMIT/ROLLBACK；
 * 嵌套调用用 SAVEPOINT/RELEASE/ROLLBACK TO，内层回滚不影响外层已完成的写入。
 * 签名与行为对外保持不变（同步函数）。
 */
let txDepth = 0;

export function tx<T>(fn: () => T): T {
  const db = getDb();
  const outer = txDepth === 0;
  const sp = `sp_${txDepth}`; // 内层保存点名，按深度唯一（严格嵌套保证不重名）
  if (outer) db.exec('BEGIN');
  else db.exec(`SAVEPOINT ${sp}`);
  txDepth++;
  let ok = false;
  try {
    const out = fn();
    ok = true;
    return out;
  } finally {
    txDepth--;
    if (ok) {
      if (outer) db.exec('COMMIT');
      else db.exec(`RELEASE ${sp}`);
    } else {
      // 回滚失败不应掩盖 fn 抛出的原始错误
      try {
        if (outer) db.exec('ROLLBACK');
        else db.exec(`ROLLBACK TO ${sp}`);
      } catch {
        /* 保留原始错误 */
      }
      if (!outer) {
        // ROLLBACK TO 之后保存点仍在栈上，必须 RELEASE，否则污染后续保存点
        try {
          db.exec(`RELEASE ${sp}`);
        } catch {
          /* 保留原始错误 */
        }
      }
    }
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
  // 短 Key（≤8 位）整体遮蔽，不露尾 4 位：位数越短，露出的尾 4 位越接近完整凭据。
  // 空值仍返回 ''（"未设置"由调用方用"是否存在该值"表达，不改协议）。
  if (v.length <= 8) return '••••••';
  return `••••••••${v.slice(-4)}`;
}

export function looksLikeMask(value: unknown): boolean {
  // 只认"以 ≥4 个连续圆点开头"的掩码（maskSecret 生成的一定满足）。
  // 正常 API Key 不会以 4 个以上圆点开头，故收严后不会把真 Key 误判成掩码而丢弃。
  return typeof value === 'string' && /^•{4,}/.test(value);
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
  if (!row) return 0;
  const n = Number(row.value);
  // 非数字（脏数据/手工改库）返回 0：否则 NaN 会让 `NaN % 20 === 0` 恒为 false，
  // 使依赖"每 N 轮触发一次"的遗忘清理/依恋分析窗口永久不触发
  return Number.isFinite(n) ? n : 0;
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
    'life_arcs',
    'agent_diaries',
    'intimacy_aftercare',
    'intimacy_preferences',
    'world_weekly_snapshots',
    'model_profiles',
    // v12 回合/生成/操作/分析任务账本（清零后由正常写作流程重建）
    'conversation_turns',
    'message_generations',
    'analysis_jobs',
    'turn_operations',
    // v13 伴侣域 / 群聊 / 活动新表（清空后由 seed() 重播主伴侣 companions id=1）
    'companions',
    'companion_relations',
    'companion_events',
    'groups',
    'group_members',
    'group_messages',
    'group_runs',
    'activities',
    'activity_participants',
    'activity_schedule_items',
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
      // 重置"已播种"标记：清空数据后，她应该回到出厂偏好（否则会零偏好且不再播种）。
      // T02 收尾：播种标记已按伴侣私有命名空间（'prefs_seeded' / 'prefs_seeded#c{id}'），两种都要清。
      db.exec("DELETE FROM settings WHERE key = 'prefs_seeded' OR key LIKE 'prefs_seeded#%';");
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