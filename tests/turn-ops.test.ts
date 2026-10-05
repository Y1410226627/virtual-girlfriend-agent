// 操作账本精确回滚回归（P0-09）：
//  - rollbackOperationsForGeneration / messageActions.deleteMessageById 走账本，按 turn/generation 精确反向
//  - 人格按轮次精确删除（不误伤后续成长）、记忆按轮删除、shared_world JSON 恢复、余额恢复、关系数值差值扣回
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-turn-ops-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const turnOpsMod = await import('../src/lib/turnOps.ts');
const maMod = await import('../src/lib/messageActions.ts');

dbMod.getDb(); // 触发建库（迁移 + 种子）

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

/* ---------------- 构造工具 ---------------- */
const now = () => new Date().toISOString();
let seq = 0;

function insertMessage(role: string, content: string): number {
  return dbMod.dbRun(
    'INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    1,
    role,
    content,
    now()
  ).lastInsertRowid;
}
function insertTurn(userMessageId: number): number {
  seq += 1;
  return dbMod.dbRun(
    "INSERT INTO conversation_turns (user_id, sequence, user_message_id, status, created_at) VALUES (?, ?, ?, 'done', ?)",
    1,
    seq,
    userMessageId,
    now()
  ).lastInsertRowid;
}
function insertGen(turnId: number, assistantMessageId: number): number {
  return dbMod.dbRun(
    "INSERT INTO message_generations (user_id, turn_id, generation_no, assistant_message_id, status, created_at) VALUES (?, ?, 1, ?, 'active', ?)",
    1,
    turnId,
    assistantMessageId,
    now()
  ).lastInsertRowid;
}
interface RecOpts {
  turnId?: number | null;
  genId?: number | null;
  type: string;
  table: string;
  targetId?: number | null;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
}
function rec(o: RecOpts): number {
  const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  return dbMod.dbRun(
    `INSERT INTO turn_operations (user_id, turn_id, generation_id, operation_type, target_table, target_id, before_json, after_json, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    1,
    o.turnId ?? null,
    o.genId ?? null,
    o.type,
    o.table,
    o.targetId ?? null,
    j(o.before),
    j(o.after),
    j(o.meta),
    now()
  ).lastInsertRowid;
}
function count(sql: string, ...params: unknown[]): number {
  return Number(dbMod.dbGet<{ c: number }>(sql, ...params)?.c ?? 0);
}

/* ---------------- 人格：按 turn 精确删除，不误伤后续轮次 ---------------- */
test('P0-09 人格：删 turn A 不得把 52 回退成 51/50', () => {
  dbMod.dbRun("UPDATE personality_state SET value = 52 WHERE user_id = ? AND dimension = 'warmth'", 1);
  const logA = dbMod.dbRun(
    "INSERT INTO personality_logs (user_id, message_id, dimension, old_value, new_value, delta, created_at) VALUES (1, NULL, 'warmth', 50, 51, 1, ?)",
    now()
  ).lastInsertRowid;
  const logB = dbMod.dbRun(
    "INSERT INTO personality_logs (user_id, message_id, dimension, old_value, new_value, delta, created_at) VALUES (1, NULL, 'warmth', 51, 52, 1, ?)",
    now()
  ).lastInsertRowid;

  const uA = insertMessage('user', 'turn A 用户');
  const aA = insertMessage('assistant', 'turn A 回复');
  const uB = insertMessage('user', 'turn B 用户');
  const aB = insertMessage('assistant', 'turn B 回复');
  const turnA = insertTurn(uA);
  const genA = insertGen(turnA, aA);
  const turnB = insertTurn(uB);
  const genB = insertGen(turnB, aB);

  rec({ turnId: turnA, genId: genA, type: 'personality_log.create', table: 'personality_logs', targetId: logA, meta: { dimension: 'warmth', old_value: 50, new_value: 51 } });
  rec({ turnId: turnB, genId: genB, type: 'personality_log.create', table: 'personality_logs', targetId: logB, meta: { dimension: 'warmth', old_value: 51, new_value: 52 } });

  const rep = maMod.deleteMessageById(uA, true);
  assert.equal(rep.ok, true, rep.error || '删除应成功');
  assert.ok(rep.notes.some((n) => n.includes('账本')), '应走账本精确反向');

  const val = Number(dbMod.dbGet<{ value: number }>("SELECT value FROM personality_state WHERE user_id = 1 AND dimension = 'warmth'")?.value);
  assert.equal(val, 52, '当前值 52 不是 A 的调整结果，不得回退');
  assert.equal(count('SELECT COUNT(*) AS c FROM personality_logs WHERE id = ?', logA), 0, 'A 的日志应删除');
  assert.equal(count('SELECT COUNT(*) AS c FROM personality_logs WHERE id = ?', logB), 1, 'B 的日志应保留');
});

/* ---------------- 记忆：按 generation 精确删除（含向量） ---------------- */
test('P0-09 记忆：删 assistant 消息 → 该 generation 新建的记忆与向量一并删除', () => {
  const uC = insertMessage('user', 'turn C 用户');
  const aC = insertMessage('assistant', 'turn C 回复');
  const turnC = insertTurn(uC);
  const genC = insertGen(turnC, aC);

  const memId = dbMod.dbRun(
    "INSERT INTO memories (user_id, type, content, source_message_id, created_at, status, access_count) VALUES (1, 'semantic', '她记得的事', ?, ?, 'active', 0)",
    aC,
    now()
  ).lastInsertRowid;
  dbMod.dbRun(
    "INSERT INTO memory_embeddings (memory_id, model, dim, vector, created_at) VALUES (?, 'test', 2, '[0.1,0.2]', ?)",
    memId,
    now()
  );
  rec({ turnId: turnC, genId: genC, type: 'memory.create', table: 'memories', targetId: memId, after: { type: 'semantic', content: '她记得的事' } });

  const rep = maMod.deleteMessageById(aC, true);
  assert.equal(rep.ok, true, rep.error || '删除应成功');
  assert.equal(count('SELECT COUNT(*) AS c FROM memories WHERE id = ?', memId), 0, '记忆应被精确删除');
  assert.equal(count('SELECT COUNT(*) AS c FROM memory_embeddings WHERE memory_id = ?', memId), 0, '向量应一并删除');
});

/* ---------------- shared_world：JSON 恢复 ---------------- */
test('P0-09 共享世界：删消息恢复 before 快照', () => {
  dbMod.dbRun(
    "INSERT OR IGNORE INTO shared_world (user_id, shared_places_json, shared_plans_json, shared_rituals_json, shared_items_json, updated_at) VALUES (1, '[]', '[]', '[]', '[]', ?)",
    now()
  );
  const emptyBefore = {
    shared_places_json: '[]',
    shared_plans_json: '[]',
    shared_rituals_json: '[]',
    shared_items_json: '[]',
    cast_json: null as string | null,
  };
  // 模拟这一轮写入了一条计划
  dbMod.dbRun("UPDATE shared_world SET shared_plans_json = ? WHERE user_id = 1", JSON.stringify([{ content: '一起去看海', status: 'planning' }]));

  const uD = insertMessage('user', 'turn D 用户');
  const aD = insertMessage('assistant', 'turn D 回复');
  const turnD = insertTurn(uD);
  const genD = insertGen(turnD, aD);
  rec({
    turnId: turnD,
    genId: genD,
    type: 'shared_world.update',
    table: 'shared_world',
    targetId: null,
    before: emptyBefore,
    after: { shared_plans_json: JSON.stringify([{ content: '一起去看海', status: 'planning' }]) },
  });

  const rep = maMod.deleteMessageById(uD, true);
  assert.equal(rep.ok, true, rep.error || '删除应成功');
  const plans = dbMod.dbGet<{ shared_plans_json: string }>('SELECT shared_plans_json FROM shared_world WHERE user_id = 1');
  assert.equal(plans?.shared_plans_json, '[]', 'shared_world 应恢复到 before 快照');
});

/* ---------------- 情感余额：流水删除 + 余额减回 ---------------- */
test('P0-09 情感余额：删消息 → 流水删除且余额减回（clamp）', () => {
  dbMod.dbRun('UPDATE relationship_state SET emotional_balance = 10 WHERE user_id = 1');
  const bankId = dbMod.dbRun(
    "INSERT INTO emotional_bank (user_id, message_id, delta, kind, balance_after, created_at) VALUES (1, NULL, 5, 'deposit', 10, ?)",
    now()
  ).lastInsertRowid;

  const uE = insertMessage('user', 'turn E 用户');
  const aE = insertMessage('assistant', 'turn E 回复');
  const turnE = insertTurn(uE);
  const genE = insertGen(turnE, aE);
  rec({ turnId: turnE, genId: genE, type: 'emotional_bank.create', table: 'emotional_bank', targetId: bankId, after: { delta: 5, balance_after: 10 } });

  const rep = maMod.deleteMessageById(uE, true);
  assert.equal(rep.ok, true, rep.error || '删除应成功');
  assert.equal(count('SELECT COUNT(*) AS c FROM emotional_bank WHERE id = ?', bankId), 0, '流水应删除');
  const bal = Number(dbMod.dbGet<{ emotional_balance: number }>('SELECT emotional_balance FROM relationship_state WHERE user_id = 1')?.emotional_balance);
  assert.equal(bal, 5, '余额应减回（10 - 5 = 5）');
});

/* ---------------- 关系数值：非最新轮按差值扣回 ---------------- */
test('P0-09 关系数值：非最新轮按记录差值扣回（保留后续成长）', () => {
  dbMod.dbRun('UPDATE relationship_state SET intimacy = 52, trust = 0, unresolved_tension = 20, repair_credit = 0 WHERE user_id = 1');

  const uF = insertMessage('user', 'turn F 用户');
  const aF = insertMessage('assistant', 'turn F 回复');
  const uG = insertMessage('user', 'turn G 用户');
  const aG = insertMessage('assistant', 'turn G 回复');
  const turnF = insertTurn(uF);
  const genF = insertGen(turnF, aF);
  const turnG = insertTurn(uG);
  const genG = insertGen(turnG, aG);

  // turn F：50→51（tension 18→20）；turn G：51→52（tension 不变）
  rec({ turnId: turnF, genId: genF, type: 'relationship.delta', table: 'relationship_state', targetId: null, before: { intimacy: 50, trust: 0, balance: 0, tension: 18, repair: 0, mood: '好奇', stage: 0 }, after: { intimacy: 51, trust: 0, balance: 0, tension: 20, repair: 0, mood: '好奇', stage: 0 } });
  rec({ turnId: turnG, genId: genG, type: 'relationship.delta', table: 'relationship_state', targetId: null, before: { intimacy: 51, trust: 0, balance: 0, tension: 20, repair: 0, mood: '好奇', stage: 0 }, after: { intimacy: 52, trust: 0, balance: 0, tension: 20, repair: 0, mood: '好奇', stage: 0 } });

  const rep = maMod.deleteMessageById(uF, true);
  assert.equal(rep.ok, true, rep.error || '删除应成功');
  const st = dbMod.dbGet<{ intimacy: number; unresolved_tension: number }>('SELECT intimacy, unresolved_tension FROM relationship_state WHERE user_id = 1');
  assert.equal(Number(st?.intimacy), 51, '只扣回 F 的 +1，保留 G 的成长（52 - 1 = 51，不得变成 50/52）');
  assert.equal(Number(st?.unresolved_tension), 18, '张力同理扣回 F 的 +2（20 - 2 = 18）');
});

/* ---------------- rollbackOperationsForGeneration 直接调用 ---------------- */
test('P0-09 rollbackOperationsForGeneration：按 generation 精确反向并返回计数', () => {
  const uH = insertMessage('user', 'turn H 用户');
  const aH = insertMessage('assistant', 'turn H 回复');
  const turnH = insertTurn(uH);
  const genH = insertGen(turnH, aH);
  const memH = dbMod.dbRun(
    "INSERT INTO memories (user_id, type, content, created_at, status, access_count) VALUES (1, 'episodic', '一次性记忆', ?, 'active', 0)",
    now()
  ).lastInsertRowid;
  rec({ turnId: turnH, genId: genH, type: 'memory.create', table: 'memories', targetId: memH });

  const res = turnOpsMod.rollbackOperationsForGeneration(genH);
  assert.equal(res.rolledBack, 1, '应反向 1 条操作');
  assert.equal(count('SELECT COUNT(*) AS c FROM memories WHERE id = ?', memH), 0, '记忆应删除');
});