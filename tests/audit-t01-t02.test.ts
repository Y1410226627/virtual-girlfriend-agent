// 独立对抗性校验（T01 迁移 / T02 隔离）：由 QA 独立设计，不复用 companion-isolation.test.ts 的用例。
//
// 覆盖：
//   A. 迁移正确性（全新库 14 条；旧库 v12→v14 逐表逐字段零回归；主键重建全列拷贝程序化比对）
//   B. 隔离正确性（UPDATE/DELETE 路径；事务边界注入；分析队列不跨伴侣）
//   C. 边界与回归（缺省=1；非法 id 回落；AsyncLocalStorage 跨 await/timer/Promise.all 语义）
//
// 隐私红线：所有 DB_PATH 指向 os.tmpdir() 下的临时库，绝不读写 data/ 与 .env.local。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const TMP = os.tmpdir();
const stamp = `${process.pid}-${Date.now()}`;
const freshDbPath = path.join(TMP, `gf-audit-fresh-${stamp}.db`);
const migDbPath = path.join(TMP, `gf-audit-migrate-${stamp}.db`);
const txDbPath = path.join(TMP, `gf-audit-tx-${stamp}.db`);
const isoDbPath = path.join(TMP, `gf-audit-iso-${stamp}.db`);

// 顶层先指到一个临时库（模块导入阶段不应触碰真实 data/）
process.env.DB_PATH = isoDbPath;

type Row = Record<string, unknown>;

const dbMod = await import('../src/lib/db.ts');
const ctx = await import('../src/lib/companion-context.ts');
const relMod = await import('../src/lib/relationship.ts');
const memMod = await import('../src/lib/memory.ts');
const bankMod = await import('../src/lib/emotionalBank.ts');
const conflictMod = await import('../src/lib/conflict.ts');
const personMod = await import('../src/lib/personality.ts');
const personCore = await import('../src/lib/personality-core.ts');
const msgActions = await import('../src/lib/messageActions.ts');
const intimacyMod = await import('../src/lib/intimacy.ts');
const lifeCore = await import('../src/lib/life-core.ts');
const lifeEvents = await import('../src/lib/life-events.ts');
const { nowIso } = await import('../src/lib/utils.ts');
const { MIGRATIONS } = await import('../src/lib/db-migrations.ts');

const { withCompanion } = ctx;
const { dbRun, dbAll, dbGet, DEFAULT_USER_ID } = dbMod;

after(() => {
  for (const p of [freshDbPath, migDbPath, txDbPath, isoDbPath]) {
    const cur = globalThis.__gfDb;
    try {
      if (cur) cur.close();
    } catch {
      /* 已关闭 */
    }
    globalThis.__gfDb = undefined;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(p + suffix, { force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
/** 关闭当前单例连接并切换 DB_PATH（createDb 会清空语句缓存） */
function switchTo(p: string): void {
  const cur = globalThis.__gfDb;
  if (cur) {
    try {
      cur.close();
    } catch {
      /* ignore */
    }
  }
  globalThis.__gfDb = undefined;
  process.env.DB_PATH = p;
}

/** 读取某张表某伴侣的全部行（显式 companion_id，本身不受作用域影响） */
function rowsOf(comp: number, table: string, where = '', ...params: unknown[]): Row[] {
  const sql = `SELECT * FROM ${table} WHERE companion_id = ?${where ? ' AND ' + where : ''}`;
  return dbAll<Row>(sql, comp, ...params);
}

/** 规范化一行（键排序）→ 用于逐字段相等比较（顺序无关） */
function canonRow(r: Row): string {
  return JSON.stringify(
    Object.keys(r)
      .sort()
      .map((k) => [k, r[k] === undefined ? null : r[k]])
  );
}
function canonRows(rs: Row[]): string[] {
  return rs.map(canonRow).sort();
}
/** 只保留指定列后的规范化行（迁移后会多 companion_id，比较时排除） */
function canonSubset(r: Row, cols: string[]): string {
  return JSON.stringify(cols.map((c) => [c, r[c] === undefined ? null : r[c]]));
}
function canonRowsSubset(rs: Row[], cols: string[]): string[] {
  return rs.map((r) => canonSubset(r, cols)).sort();
}

const DIMS = ['warmth', 'playfulness', 'romance', 'directness', 'independence', 'emotional_intensity'];

/** 给 companion 2 播种全套独立状态（companions/personas/relation/attachment/personality + 生活/亲密） */
function seedC2(): void {
  const now = nowIso();
  dbRun(
    `INSERT OR IGNORE INTO companions (id, user_id, name, age, is_primary, status, created_at, updated_at)
     VALUES (2, ?, '二号', 25, 0, 'girlfriend', ?, ?)`,
    DEFAULT_USER_ID, now, now
  );
  dbRun(
    `INSERT OR IGNORE INTO personas (id, user_id, companion_id, agent_name, created_at, updated_at)
     VALUES (2, ?, 2, '二号', ?, ?)`,
    DEFAULT_USER_ID, now, now
  );
  dbRun(
    `INSERT OR IGNORE INTO relationship_state
       (companion_id, user_id, intimacy, trust, mood, stage, stage_entered_at, stage_cap_since,
        pending_stage_confirm, pending_relationship_talk, conflict_state, last_conflict_at, nickname,
        anniversary, last_interaction_at, streak_days, emotional_balance, repair_credit,
        unresolved_tension, updated_at)
     VALUES (2, ?, 0, 0, '好奇', 0, ?, NULL, 0, 0, 'none', NULL, NULL, NULL, NULL, 0, 0, 0, 0, ?)`,
    DEFAULT_USER_ID, now, now
  );
  dbRun(
    `INSERT OR IGNORE INTO attachment_state (companion_id, user_id, anxiety, avoidance, style, updated_at)
     VALUES (2, ?, 30, 30, 'secure', ?)`,
    DEFAULT_USER_ID, now
  );
  for (const d of DIMS) {
    dbRun(
      `INSERT OR IGNORE INTO personality_state (companion_id, user_id, dimension, value, solidified, last_adjusted_turn, updated_at)
       VALUES (2, ?, ?, 50, 0, 0, ?)`,
      DEFAULT_USER_ID, d, now
    );
  }
  // 生活/亲密状态行：用生产 ensure 函数在 c2 作用域幂等补种
  withCompanion(2, () => {
    lifeCore.ensureLife();
    intimacyMod.getIntimacy();
  });
}

/* ================================================================== */
/* A. 迁移正确性                                                        */
/* ================================================================== */

test('A1 全新库：schema_migrations 恰好 15 条、版本 1..15；companions id=1 满足红线', () => {
  switchTo(freshDbPath);
  dbMod.getDb();
  const versions = dbAll<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version').map((r) =>
    Number(r.version)
  );
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], '应恰好 15 条且严格递增');
  const c1 = dbGet<{ id: number; is_primary: number; age: number; status: string }>(
    'SELECT id, is_primary, age, status FROM companions WHERE id = 1'
  );
  assert.ok(c1, 'companions 应有 id=1 行');
  assert.equal(Number(c1!.is_primary), 1);
  assert.ok(Number(c1!.age) >= 18, `age 必须 >=18，实际 ${c1!.age}`);
  assert.equal(String(c1!.status), 'girlfriend');
});

/* ---------------------- 构造 v12 旧库（不经过 db.ts，纯 raw 连接） ---------------------- */
const V12_TABLES = [
  'messages', 'memories', 'personas', 'relationship_state', 'relationship_logs', 'emotional_bank', 'events',
  'personality_state', 'personality_signals', 'personality_logs', 'personality_snapshots', 'attachment_state',
  'attachment_signals', 'attachment_logs', 'conflict_logs', 'proactive_messages', 'turn_effects',
  'agent_daily_events', 'life_state_logs', 'intimacy_preferences', 'intimacy_aftercare', 'ongoing_events',
  'life_arcs', 'conversation_turns', 'message_generations', 'analysis_jobs', 'turn_operations', 'agent_diaries',
  'daily_summaries', 'world_weekly_snapshots', 'intimacy_content_level', 'intimacy_state', 'agent_profile',
  'agent_health', 'agent_psychology', 'agent_location', 'agent_activity', 'shared_world',
];

function buildV12(file: string): DatabaseSync {
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
  const raw = new DatabaseSync(file);
  raw.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);'
  );
  for (const m of MIGRATIONS) {
    if (m.version > 12) break;
    raw.exec(m.sql);
    raw.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      m.version,
      m.name,
      new Date().toISOString()
    );
  }
  return raw;
}

/** 在各表写入覆盖各类型/非默认值的代表数据（列清单严格按 v12 形态，不含 companion_id） */
function insertV12Data(raw: DatabaseSync): void {
  const S = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...p as never[]);
  const now = nowIso();
  S(`INSERT INTO messages (id,user_id,role,content,emotion,is_proactive,read_at,meta,created_at)
     VALUES (1,1,'user','旧用户消息','开心',0,NULL,'{"a":1}','2024-01-01T00:00:00.000Z')`);
  S(`INSERT INTO messages (id,user_id,role,content,created_at)
     VALUES (2,1,'assistant','旧她回复','2024-01-01T00:01:00.000Z')`);
  S(`INSERT INTO memories (id,user_id,type,content,importance,emotion,source_message_id,created_at,status,access_count,fact_key)
     VALUES (1,1,'fact','旧记忆内容',7,'平静',1,'2024-01-02T00:00:00.000Z','active',3,'fk-1')`);
  S(`INSERT INTO personas (id,user_id,agent_name,age,occupation,self_story,created_at,updated_at)
     VALUES (1,1,'旧她','24','设计师','旧故事',?,?)`, now, now);
  S(`INSERT INTO relationship_state
       (user_id,intimacy,trust,mood,stage,stage_entered_at,stage_cap_since,pending_stage_confirm,
        pending_relationship_talk,conflict_state,last_conflict_at,nickname,anniversary,last_interaction_at,
        streak_days,emotional_balance,repair_credit,unresolved_tension,scene,scene_reason,scene_updated_at,
        scene_confidence,scene_source,scene_expires_at,affect_json,updated_at)
     VALUES (1,42.5,61,'思念',2,'2024-01-01T00:00:00.000Z','2024-02-02T00:00:00.000Z',1,1,'tense',
        '2024-03-03T00:00:00.000Z','宝贝','2023-05-20','2024-04-04T00:00:00.000Z',9,12.5,33,44,
        'offline','雨','2024-05-05T00:00:00.000Z',0.8,'chat','2024-06-06T00:00:00.000Z','{"primary":"开心"}',
        '2024-07-07T00:00:00.000Z')`);
  S(`INSERT INTO relationship_logs (id,user_id,kind,summary,old_value,new_value,reason,stage_at_time,created_at,message_id)
     VALUES (1,1,'intimacy','旧关系日志','[1]','[2]','测试',2,'2024-01-03T00:00:00.000Z',1)`);
  S(`INSERT INTO emotional_bank (id,user_id,message_id,delta,kind,behavior,reason,balance_after,created_at)
     VALUES (1,1,1,5,'deposit','温暖','旧银行流水',5,'2024-01-04T00:00:00.000Z')`);
  S(`INSERT INTO events (id,user_id,title,event_date,repeat_yearly,kind,description,created_at)
     VALUES (1,1,'纪念日','2023-05-20',1,'anniversary','旧事件',?)`, now);
  for (let i = 0; i < DIMS.length; i++) {
    S(`INSERT INTO personality_state (user_id,dimension,value,solidified,last_adjusted_turn,updated_at)
       VALUES (1,?,?,?,?,?)`, DIMS[i], 40 + i, i, i, now);
  }
  S(`INSERT INTO personality_signals (id,user_id,message_id,dimension,direction,strength,weight,context,reasoning,created_at,consumed)
     VALUES (1,1,2,'warmth','+',0.7,1,'旧情境','旧推理',?,0)`, now);
  S(`INSERT INTO personality_logs (id,user_id,message_id,dimension,old_value,new_value,delta,signal_context,reasoning,stage_at_time,attachment_at_time,layer,source_turns,contributing_signal_ids,created_at)
     VALUES (1,1,2,'warmth',40,41,1,'旧情境','旧推理',2,'secure','confirm','[1]','[1]',?)`, now);
  S(`INSERT INTO personality_snapshots (id,user_id,week,values_json,created_at)
     VALUES (1,1,'2024-W01','{"warmth":41}',?)`, now);
  S(`INSERT INTO attachment_state (user_id,anxiety,avoidance,style,updated_at) VALUES (1,33,44,'anxious',?)`, now);
  S(`INSERT INTO attachment_signals (id,user_id,axis,direction,delta,reasoning,user_cues,applied,created_at,message_id)
     VALUES (1,1,'anxiety','+',1.5,'旧依恋推理','[cues]',0,?,2)`, now);
  S(`INSERT INTO attachment_logs (id,user_id,old_anxiety,new_anxiety,old_avoidance,new_avoidance,trigger,reasoning,source_turns,created_at)
     VALUES (1,1,30,33,30,44,'旧触发','旧推理','[1]',?)`, now);
  S(`INSERT INTO conflict_logs (id,user_id,type,status,description,tension_at_start,tension_after,repair_quality,started_at,resolved_at)
     VALUES (1,1,'major','open','旧冲突',10,20,'sincere','2024-01-05T00:00:00.000Z',NULL)`);
  S(`INSERT INTO proactive_messages (id,user_id,kind,content,message_id,created_at)
     VALUES (1,1,'care','旧主动消息',2,?)`, now);
  S(`INSERT INTO turn_effects (id,user_id,message_id,user_message_id,intimacy_delta,trust_delta,balance_delta,tension_delta,repair_delta,created_at)
     VALUES (1,1,2,1,3,2,5,0,0,?)`, now);
  S(`INSERT INTO agent_daily_events (id,user_id,event_type,content,impact_json,created_at)
     VALUES (1,1,'生活','旧日常事件','{"note":"x"}',?)`, now);
  S(`INSERT INTO life_state_logs (id,user_id,field,old_value,new_value,reason,created_at)
     VALUES (1,1,'energy','80','70','旧日志',?)`, now);
  S(`INSERT INTO intimacy_preferences (id,user_id,preference_type,content,reveal_status,reveal_stage,created_at)
     VALUES (1,1,'like','旧偏好','hidden',2,?)`, now);
  S(`INSERT INTO intimacy_aftercare (id,user_id,session_id,aftercare_quality,user_response,agent_state,created_at)
     VALUES (1,1,'s1','good','谢谢','依偎',?)`, now);
  S(`INSERT INTO ongoing_events (id,user_id,activity,event_type,started_at,expected_end_at,duration_mode,notified_at,ended_at,end_reason,created_at,updated_at)
     VALUES (1,1,'睡觉','sleep','2024-01-06T00:00:00.000Z','2024-01-06T08:00:00.000Z','smart',NULL,NULL,NULL,?,?)`, now, now);
  S(`INSERT INTO life_arcs (id,user_id,title,description,status,progress,planned_days,meta_json,started_at,updated_at)
     VALUES (1,1,'旧生活线','描述','active',30,5,'{"source":"llm"}',?,?)`, now, now);
  S(`INSERT INTO conversation_turns (id,user_id,sequence,user_message_id,current_generation_id,status,created_at,completed_at)
     VALUES (1,1,1,1,1,'completed',?,?)`, now, now);
  S(`INSERT INTO message_generations (id,user_id,turn_id,generation_no,assistant_message_id,status,created_at)
     VALUES (1,1,1,1,2,'active',?)`, now);
  S(`INSERT INTO analysis_jobs (id,user_id,turn_id,generation_id,user_message_id,assistant_message_id,status,attempts,next_retry_at,started_at,finished_at,error,created_at)
     VALUES (1,1,1,1,1,2,'done',0,NULL,NULL,?,NULL,?)`, now, now);
  S(`INSERT INTO turn_operations (id,user_id,turn_id,generation_id,operation_type,target_table,target_id,before_json,after_json,meta_json,created_at)
     VALUES (1,1,1,1,'update','relationship_state',1,'{"a":1}','{"a":2}','{}',?)`, now);
  S(`INSERT INTO agent_diaries (id,user_id,date,content,created_at,updated_at)
     VALUES (1,1,'2024-01-07','旧日记',?,?)`, now, now);
  S(`INSERT INTO daily_summaries (id,user_id,date,summary,meta,created_at)
     VALUES (1,1,'2024-01-07','旧摘要','{}',?)`, now);
  S(`INSERT INTO world_weekly_snapshots (id,user_id,week,state_json,created_at)
     VALUES (1,1,'2024-W01','{"x":1}',?)`, now);
  S(`INSERT INTO intimacy_content_level (user_id,level,updated_at) VALUES (1,2,?)`, now);
  S(`INSERT INTO intimacy_state (user_id,libido,intimacy_need,sexual_satisfaction,sexual_stress,aftercare_until,aftercare_state,last_intimacy_at,updated_at)
     VALUES (1,55,60,70,15,NULL,NULL,NULL,?)`, now);
  S(`INSERT INTO agent_profile (user_id,name,nickname,age,birthday,hometown,city,family,education,job,hobbies,habits,catchphrases,fears,dreams,secrets,reveal_status,updated_at)
     VALUES (1,'旧名','小名','24','2000-01-01','某市','某市','一家','大学','设计师','画画','早起','口头禅','怕黑','梦想','秘密','{}',?)`, now);
  S(`INSERT INTO agent_health (user_id,energy,sleep_quality,hunger,illness,illness_start,illness_duration_days,illness_severity,cared_count,cycle_enabled,cycle_day,cycle_length,exercise,last_meal_at,last_sleep_at,woke_at,updated_at)
     VALUES (1,72,66,55,'none',NULL,NULL,0,2,1,14,28,48,NULL,NULL,NULL,?)`, now);
  S(`INSERT INTO agent_psychology (user_id,base_emotion,stress,loneliness,missing_user,security,self_worth,mental_energy,updated_at)
     VALUES (1,'平静',22,31,42,63,68,71,?)`, now);
  S(`INSERT INTO agent_location (user_id,current_location,location_type,arrived_at,expected_leave_at,updated_at)
     VALUES (1,'公司','school',NULL,NULL,?)`, now);
  S(`INSERT INTO agent_activity (user_id,current_activity,activity_type,started_at,expected_end_at,updated_at)
     VALUES (1,'工作','class',NULL,NULL,?)`, now);
  S(`INSERT INTO shared_world (user_id,shared_places_json,shared_plans_json,shared_rituals_json,shared_items_json,updated_at,cast_json)
     VALUES (1,'["p"]','["pl"]','["r"]','["i"]',?,'[{"name":"小夏"}]')`, now);
}

test('A2 旧库(v12)升级到 v14：逐表行数不变 + 逐字段相等 + companion_id 全为 1', () => {
  const raw = buildV12(migDbPath);
  insertV12Data(raw);

  // 迁移前快照（含列清单）
  const preCols: Record<string, string[]> = {};
  const preRows: Record<string, Row[]> = {};
  for (const t of V12_TABLES) {
    preCols[t] = (raw.prepare(`PRAGMA table_info(${t})`).all() as Row[]).map((c) => String(c.name));
    preRows[t] = raw.prepare(`SELECT * FROM ${t}`).all() as Row[];
  }
  raw.close();

  // 走真实迁移路径：getDb() → migrate() 只补跑 v13/v14（schema_migrations 已记 1..12）
  switchTo(migDbPath);
  dbMod.getDb();

  for (const t of V12_TABLES) {
    const postRows = dbAll<Row>(`SELECT * FROM ${t}`);
    assert.equal(postRows.length, preRows[t]!.length, `${t} 行数必须不变（迁移零回归）`);
    // 逐字段相等（排除新增的 companion_id 列）
    assert.deepEqual(
      canonRowsSubset(postRows, preCols[t]!),
      canonRowsSubset(preRows[t]!, preCols[t]!),
      `${t} 的全部字段必须逐字节保留`
    );
    for (const r of postRows) {
      assert.equal(Number(r.companion_id), 1, `${t}.${String(r.id ?? '')} 新增列 companion_id 应回填 1`);
    }
  }
});

test('A3 主键重建全列拷贝：用 PRAGMA 程序化比对，无列丢失 / 无类型退化', () => {
  const C_TABLES = [
    'relationship_state', 'personality_state', 'attachment_state', 'personality_snapshots', 'daily_summaries',
    'agent_profile', 'agent_health', 'agent_psychology', 'agent_location', 'agent_activity', 'shared_world',
    'intimacy_state', 'intimacy_content_level', 'world_weekly_snapshots',
  ];
  // 复用 A2 已升级到 v14 的库；同时用一份 v13 前的库取旧列定义
  const raw = buildV12(migDbPath + '.ref');
  const old: Record<string, Map<string, string>> = {};
  for (const t of C_TABLES) {
    const info = raw.prepare(`PRAGMA table_info(${t})`).all() as Row[];
    old[t] = new Map(info.map((c) => [String(c.name), String(c.type)]));
  }
  raw.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(migDbPath + '.ref' + s, { force: true });

  for (const t of C_TABLES) {
    const post = dbAll<Row>(`PRAGMA table_info(${t})`);
    const postMap = new Map(post.map((c) => [String(c.name), String(c.type)]));
    assert.ok(postMap.has('companion_id'), `${t} 重建后应含 companion_id`);
    for (const [name, type] of old[t]!) {
      assert.ok(postMap.has(name), `${t} 重建丢列：${name}`);
      if (type && postMap.get(name)) {
        assert.equal(postMap.get(name), type, `${t}.${name} 类型退化：${type} → ${postMap.get(name)}`);
      }
    }
    assert.equal(postMap.size, old[t]!.size + 1, `${t} 重建后应恰好多出 companion_id 一列`);
  }

  // agent_diaries：唯一索引改为 (companion_id, date)，旧索引移除
  const idx = dbAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index'");
  const idxNames = idx.map((r) => String(r.name));
  assert.ok(idxNames.includes('idx_agent_diaries_companion_date'), '应存在 idx_agent_diaries_companion_date');
  assert.ok(!idxNames.includes('idx_agent_diaries_user_date'), '旧索引 idx_agent_diaries_user_date 应已移除');
});

test('A4 破坏性迁移片段必须带 -- safe: 标记（复刻 check-migrations 规则）', () => {
  const patterns = [
    /\bDROP\s+TABLE\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bALTER\s+TABLE\b[^\n]*\bDROP\s+COLUMN\b/i,
    /\bUPDATE\b[\s\S]*?\bSET\b(?:(?!\bWHERE\b)[\s\S])*?(?=;|\n\n|$)/i,
  ];
  const violations: string[] = [];
  for (const m of MIGRATIONS) {
    const destructive = patterns.some((re) => re.test(m.sql));
    if (destructive && !/--\s*safe\s*:/i.test(m.sql)) violations.push(`v${m.version} ${m.name}`);
  }
  assert.deepEqual(violations, [], `以下迁移含破坏性操作但缺少 -- safe: ${violations.join(', ')}`);
  // v14（主键重建）必然含 DROP TABLE，必须显式声明
  const v14 = MIGRATIONS.find((m) => m.version === 14)!;
  assert.ok(/--\s*safe\s*:/i.test(v14.sql), 'v14 主键重建必须带 -- safe: 说明');
});

/* ================================================================== */
/* B. 隔离正确性（对抗性）                                              */
/* ================================================================== */

test('B6 事务边界：c* 与 dbRun 混用的多语句在注入失败时整体回滚，且不波及另一伴侣', () => {
  switchTo(txDbPath);
  dbMod.getDb();
  seedC2();

  const c1relBefore = canonRows(rowsOf(1, 'relationship_state'));
  const c2relBefore = canonRows(rowsOf(2, 'relationship_state'));

  const dbi = dbMod.getDb();
  const realPrepare = dbi.prepare.bind(dbi);
  // 注入：写情感银行流水时抛错（该 SQL 此前未被 prepare，一定命中）
  dbi.prepare = ((sql: string, options?: Parameters<typeof dbi.prepare>[1]) => {
    if (String(sql).includes('INSERT INTO emotional_bank')) throw new Error('注入失败：银行记账写入失败');
    return realPrepare(sql, options);
  }) as typeof dbi.prepare;

  assert.throws(
    () => withCompanion(2, () => conflictMod.registerConflict('major', '注入测试冲突')),
    /注入失败/
  );
  dbi.prepare = realPrepare;

  assert.deepEqual(canonRows(rowsOf(2, 'conflict_logs')), [], 'c2 冲突登记应整体回滚（不留下半条）');
  assert.deepEqual(canonRows(rowsOf(2, 'relationship_state')), c2relBefore, 'c2 关系状态应一并回滚');
  assert.deepEqual(canonRows(rowsOf(1, 'relationship_state')), c1relBefore, 'c1 完全不受影响');
});

let isoReady = false;
function ensureIso(): void {
  if (isoReady) return;
  switchTo(isoDbPath);
  dbMod.getDb();
  seedC2();
  isoReady = true;
}

test('B5a 冲突 UPDATE 路径：c1 修复只关闭 c1 的未决冲突，c2 的冲突原样保留', () => {
  ensureIso();
  withCompanion(1, () => conflictMod.registerConflict('major', 'c1 冲突'));
  withCompanion(2, () => conflictMod.registerConflict('major', 'c2 冲突'));

  const c2Before = canonRows(rowsOf(2, 'conflict_logs'));
  const c2relBefore = canonRows(rowsOf(2, 'relationship_state'));

  withCompanion(1, () => conflictMod.registerRepair('sincere', 'c1 真诚道歉'));

  const c1Open = withCompanion(1, () => conflictMod.openConflictCount());
  assert.equal(c1Open, 0, 'c1 的未决冲突应被结清');
  assert.deepEqual(canonRows(rowsOf(2, 'conflict_logs')), c2Before, 'c2 的冲突行必须逐字段不变');
  assert.deepEqual(canonRows(rowsOf(2, 'relationship_state')), c2relBefore, 'c2 的关系状态必须不变');
  assert.equal(withCompanion(2, () => conflictMod.openConflictCount()), 1, 'c2 仍有 1 条未决冲突');
});

test('B5b 性格 UPDATE 路径：c2 的 unsolidify/manualAdjust 不修改 c1', () => {
  ensureIso();
  // 两侧都先置 solidified=1，制造可观测差异
  dbRun("UPDATE personality_state SET solidified = 1 WHERE companion_id = ? AND dimension = 'warmth'", 1);
  dbRun("UPDATE personality_state SET solidified = 1 WHERE companion_id = ? AND dimension = 'warmth'", 2);
  const c1Before = canonRows(rowsOf(1, 'personality_state'));

  withCompanion(2, () => {
    personCore.unsolidify('warmth');
    personMod.manualAdjust('warmth', 88, 'c2 调整');
  });

  assert.deepEqual(canonRows(rowsOf(1, 'personality_state')), c1Before, 'c1 的性格行必须逐字段不变');
  const c2w = rowsOf(2, 'personality_state', "dimension = 'warmth'")[0]!;
  assert.equal(Number(c2w.solidified), 0, 'c2 warmth 应已解除固化');
  assert.equal(Number(c2w.value), 88, 'c2 warmth 应被改为 88');
});

test('B5c 消息删除路径：c2 级联删除不动 c1 的消息与影响记录', () => {
  ensureIso();
  // 直接插入两条各归其主的消息 + 各自的 turn_effects
  const now = nowIso();
  const r1 = dbRun(
    'INSERT INTO messages (companion_id, user_id, role, content, created_at) VALUES (1, ?, ?, ?, ?)',
    DEFAULT_USER_ID, 'user', 'c1 待保留消息', now
  );
  const r2 = dbRun(
    'INSERT INTO messages (companion_id, user_id, role, content, created_at) VALUES (2, ?, ?, ?, ?)',
    DEFAULT_USER_ID, 'user', 'c2 待删除消息', now
  );
  dbRun(
    'INSERT INTO turn_effects (companion_id, user_id, message_id, created_at) VALUES (1, ?, ?, ?)',
    DEFAULT_USER_ID, Number(r1.lastInsertRowid), now
  );
  dbRun(
    'INSERT INTO turn_effects (companion_id, user_id, message_id, created_at) VALUES (2, ?, ?, ?)',
    DEFAULT_USER_ID, Number(r2.lastInsertRowid), now
  );
  const c1MsgBefore = canonRows(rowsOf(1, 'messages'));
  const c1EffBefore = canonRows(rowsOf(1, 'turn_effects'));
  const c1relBefore = canonRows(rowsOf(1, 'relationship_state'));

  // 在 c2 作用域里尝试删除 c1 的消息 → 应查无此消息（证明按伴侣隔离）
  const cross = withCompanion(2, () => msgActions.deleteMessageById(Number(r1.lastInsertRowid), false));
  assert.equal(cross.ok, false, 'c2 不应能删除 c1 的消息');
  assert.ok(cross.error, '应返回错误（消息不存在）');

  // 在 c2 作用域删除自己的消息（级联）
  const own = withCompanion(2, () => msgActions.deleteMessageById(Number(r2.lastInsertRowid), true));
  assert.equal(own.ok, true, 'c2 应能删除自己的消息');

  assert.deepEqual(canonRows(rowsOf(1, 'messages')), c1MsgBefore, 'c1 消息必须不变');
  assert.deepEqual(canonRows(rowsOf(1, 'turn_effects')), c1EffBefore, 'c1 的影响记录必须不变');
  assert.deepEqual(canonRows(rowsOf(1, 'relationship_state')), c1relBefore, 'c1 关系状态必须不变');
  assert.equal(rowsOf(2, 'messages').length, 0, 'c2 的消息应被删除');
});

test('B5d 亲密 UPDATE 路径：setLevel / logAftercareResponse 各归其主', () => {
  ensureIso();
  withCompanion(1, () => intimacyMod.setLevel(3));
  withCompanion(2, () => intimacyMod.setLevel(1));

  assert.equal(Number(rowsOf(1, 'intimacy_content_level')[0]!.level), 3, 'c1 分级应为 3');
  assert.equal(Number(rowsOf(2, 'intimacy_content_level')[0]!.level), 1, 'c2 分级应为 1（未被 c1 串扰）');

  // aftercare 响应按 (id, companion_id) 双重定位
  const now = nowIso();
  const a1 = dbRun(
    'INSERT INTO intimacy_aftercare (companion_id, user_id, aftercare_quality, created_at) VALUES (1, ?, ?, ?)',
    DEFAULT_USER_ID, 'good', now
  );
  const a2 = dbRun(
    'INSERT INTO intimacy_aftercare (companion_id, user_id, aftercare_quality, created_at) VALUES (2, ?, ?, ?)',
    DEFAULT_USER_ID, 'good', now
  );
  const cross = withCompanion(2, () => intimacyMod.logAftercareResponse(Number(a1.lastInsertRowid), 'c2 想回应 c1'));
  assert.equal(cross, false, 'c2 不应能回写 c1 的事后关怀行');
  const own = withCompanion(2, () => intimacyMod.logAftercareResponse(Number(a2.lastInsertRowid), 'c2 回应自己'));
  assert.equal(own, true, 'c2 应能回写自己的事后关怀行');
  const rowA1 = rowsOf(1, 'intimacy_aftercare')[0]!;
  assert.equal(rowA1.user_response, null, 'c1 的回应列必须保持 NULL');
});

test('B5e 生活事件结束路径：endOngoingEvent 只结束当前伴侣的事件', () => {
  ensureIso();
  const e1 = withCompanion(1, () => lifeEvents.registerOngoingEvent('睡觉'));
  const e2 = withCompanion(2, () => lifeEvents.registerOngoingEvent('吃饭'));
  assert.ok(e1 && e2, '两侧都应成功登记事件');

  const c2Before = canonRows(rowsOf(2, 'ongoing_events'));
  withCompanion(1, () => lifeEvents.endOngoingEvent('测试结束'));

  const c1Evt = rowsOf(1, 'ongoing_events')[0]!;
  assert.ok(c1Evt.ended_at, 'c1 的事件应已结束');
  assert.deepEqual(canonRows(rowsOf(2, 'ongoing_events')), c2Before, 'c2 的事件行必须逐字段不变');
  assert.equal(withCompanion(2, () => (lifeEvents.getActiveEvent() ? 1 : 0)), 1, 'c2 仍有进行中的事件');
});

test('B7 分析队列不跨伴侣：recoverStale 与 pending 计数按 companion_id 分区', async () => {
  ensureIso();
  // 先导入（触发模块初始化的 drain，让它先跑空一次，避免影响后插入的数据）
  const aq = await import('../src/lib/analysisQueue.ts');
  await new Promise((r) => setTimeout(r, 30));

  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 小时前 → 超过 30 分钟陈旧阈值
  const now = nowIso();
  dbRun(
    "INSERT INTO analysis_jobs (companion_id, user_id, status, attempts, started_at, created_at) VALUES (1, ?, 'running', 0, ?, ?)",
    DEFAULT_USER_ID, old, now
  );
  dbRun(
    "INSERT INTO analysis_jobs (companion_id, user_id, status, attempts, started_at, created_at) VALUES (2, ?, 'running', 0, ?, ?)",
    DEFAULT_USER_ID, old, now
  );

  const n1 = withCompanion(1, () => aq.recoverStaleAnalysisJobs());
  assert.equal(n1, 1, 'c1 应只回收自己的 1 条陈旧 running');
  assert.equal(rowsOf(1, 'analysis_jobs')[0]!.status, 'pending', 'c1 的任务应变回 pending');
  assert.equal(rowsOf(2, 'analysis_jobs')[0]!.status, 'running', 'c2 的任务必须保持 running（不被 c1 回收）');

  const n2 = withCompanion(2, () => aq.recoverStaleAnalysisJobs());
  assert.equal(n2, 1, 'c2 回收自己的 1 条');
  assert.equal(rowsOf(2, 'analysis_jobs')[0]!.status, 'pending', 'c2 的任务应变回 pending');

  assert.equal(withCompanion(1, () => aq.analysisQueueStatus().pending), 1, 'c1 pending = 1');
  assert.equal(withCompanion(2, () => aq.analysisQueueStatus().pending), 1, 'c2 pending = 1');
  assert.equal(rowsOf(1, 'analysis_jobs').length, 1, '队列未跨伴侣混入');
  assert.equal(rowsOf(2, 'analysis_jobs').length, 1, '队列未跨伴侣混入');
});

test('B-defect recentMessagesForSummary：多伴侣下 persona JOIN 不应导致消息重复（预期红）', () => {
  ensureIso();
  // 今天只给 c2 塞 1 条消息
  const today = String(dbGet<{ d: string }>("SELECT date('now','localtime') AS d")!.d);
  withCompanion(2, () => {
    const m = dbRun(
      `INSERT INTO messages (companion_id, user_id, role, content, created_at)
       VALUES (2, ?, 'user', 'c2 今天的唯一消息', ?)`,
      DEFAULT_USER_ID,
      new Date().toISOString()
    );
    void m;
  });
  const total = withCompanion(2, () => memMod.recentMessagesForSummary(today)).length;
  // 正确行为：1 条消息 → 1 行。memory.ts 的 `LEFT JOIN personas p ON p.user_id = m.user_id`
  // 在存在 2 个伴侣（user_id 均为 1）时会把每行放大成 2 行 → 长度=2 即缺陷。
  assert.equal(total, 1, `recentMessagesForSummary 应返回 1 行，实际 ${total} 行（persona 按 user_id 联结导致重复）`);
});

test('B5f 情感银行：c1 存入 / c2 取款，余额与流水各归其主', () => {
  ensureIso();
  const b1 = withCompanion(1, () => Number(relMod.getRelationshipState().emotional_balance));
  const b2 = withCompanion(2, () => Number(relMod.getRelationshipState().emotional_balance));

  withCompanion(1, () => bankMod.addBankEntry(7, 'warm', 'c1 加分'));
  withCompanion(2, () => bankMod.addBankEntry(-4, 'cold', 'c2 减分'));

  assert.equal(
    withCompanion(1, () => Number(relMod.getRelationshipState().emotional_balance)),
    b1 + 7,
    'c1 余额只含自己的记账（+7）'
  );
  assert.equal(
    withCompanion(2, () => Number(relMod.getRelationshipState().emotional_balance)),
    b2 - 4,
    'c2 余额只含自己的记账（-4）'
  );
  // c1 再记一笔，不得改动 c2 的流水条数（基准取 c2 自己记账之后的条数）
  const c2BankAfterOwn = rowsOf(2, 'emotional_bank').length;
  const c1BankAfterOwn = rowsOf(1, 'emotional_bank').length;
  withCompanion(1, () => bankMod.addBankEntry(1, 'warm', 'c1 再记一笔'));
  assert.equal(rowsOf(2, 'emotional_bank').length, c2BankAfterOwn, 'c2 的银行流水不应被 c1 的写入增加');
  assert.equal(rowsOf(1, 'emotional_bank').length, c1BankAfterOwn + 1, 'c1 自己的流水应 +1');
});

/* ================================================================== */
/* C. 边界与回归                                                        */
/* ================================================================== */

test('C9 缺省上下文 = companion 1；显式写入的 c2 数据在缺省作用域不可见', () => {
  ensureIso();
  assert.equal(ctx.cId(), ctx.PRIMARY_COMPANION_ID, '未包裹时 cId() 应为 1');
  const now = nowIso();
  withCompanion(2, () =>
    dbRun(
      'INSERT INTO messages (companion_id, user_id, role, content, created_at) VALUES (2, ?, ?, ?, ?)',
      DEFAULT_USER_ID, 'user', 'c2 专属暗号', now
    )
  );
  const visible = dbMod.cAll<{ content: string }>('SELECT content FROM messages WHERE companion_id = ?');
  assert.ok(!visible.some((r) => r.content === 'c2 专属暗号'), '缺省作用域（c1）不得看到 c2 的数据');
});

test('C10 withCompanion 非法值（0/-1/NaN/undefined/小数）一律回落 1', () => {
  const cases = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, null] as unknown as number[];
  for (const bad of cases) {
    const got = ctx.withCompanion(bad as number, () => ctx.cId());
    assert.equal(got, 1, `withCompanion(${String(bad)}) 应回落 1，实际 ${got}`);
  }
  // 正小数截断取整
  assert.equal(ctx.withCompanion(2.9 as number, () => ctx.cId()), 2, '正小数应截断为 2');
});

test('C11 AsyncLocalStorage 语义：跨 await / timer 保持；Promise.all 并发不串味', async () => {
  // 1) 跨 await 与 setTimeout 仍绑定
  await withCompanion(2, async () => {
    assert.equal(ctx.cId(), 2, 'async 入口');
    await Promise.resolve();
    assert.equal(ctx.cId(), 2, 'await 一个 tick 后仍为 2');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(ctx.cId(), 2, 'setTimeout 回调后仍为 2');
  });
  assert.equal(ctx.cId(), 1, '退出作用域后回落 1');

  // 2) 并发包裹两个不同 companion：各自 await 交错也不串味
  const seen: number[] = [];
  await Promise.all([
    withCompanion(1, async () => {
      await new Promise((r) => setTimeout(r, 8));
      seen.push(ctx.cId());
      await Promise.resolve();
      seen.push(ctx.cId());
    }),
    withCompanion(2, async () => {
      await new Promise((r) => setTimeout(r, 3));
      seen.push(ctx.cId());
      await Promise.resolve();
      seen.push(ctx.cId());
    }),
  ]);
  assert.deepEqual(seen.slice().sort(), [1, 1, 2, 2], '并发两个作用域各自读到的都是自己的 id');
});
