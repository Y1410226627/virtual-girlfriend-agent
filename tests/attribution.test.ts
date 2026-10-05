// P1-39/40 人格/依恋归因回归：
//  - 确认层写日志时记录 source_turns（被消费信号的 message_id → 回合）与 contributing_signal_ids
//  - 跨多轮积累触发的调整，删除其中一轮（走 turnOps 账本反向）不回退数值、不删日志
//  - 单一来源（唯一回合 == 被删回合）仍保持精确回滚
// 隐私：使用独立临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-attribution-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const personalityMod = await import('../src/lib/personality.ts');
const turnOpsMod = await import('../src/lib/turnOps.ts');

dbMod.getDb();

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

const U = dbMod.DEFAULT_USER_ID;
const now = () => new Date().toISOString();
let seq = 0;

function insertMessage(role: string, content: string): number {
  return dbMod.dbRun(
    'INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    U,
    role,
    content,
    now()
  ).lastInsertRowid;
}
function insertTurn(userMessageId: number): number {
  seq += 1;
  return dbMod.dbRun(
    "INSERT INTO conversation_turns (user_id, sequence, user_message_id, status, created_at) VALUES (?, ?, ?, 'done', ?)",
    U,
    seq,
    userMessageId,
    now()
  ).lastInsertRowid;
}
function insertGen(turnId: number, assistantMessageId: number): number {
  return dbMod.dbRun(
    "INSERT INTO message_generations (user_id, turn_id, generation_no, assistant_message_id, status, created_at) VALUES (?, ?, 1, ?, 'active', ?)",
    U,
    turnId,
    assistantMessageId,
    now()
  ).lastInsertRowid;
}
/** 一组同一维度 / 方向的信号（context 各不同 → 满足"情境多样"阈值） */
function sigs(dimension: string, contexts: string[]) {
  return contexts.map((context) => ({
    signal: `${dimension} 变化`,
    dimension,
    direction: '+' as const,
    strength: 0.8,
    context,
    is_direct_feedback: false,
  }));
}
function recordPersonalityOp(turnId: number, genId: number, logId: number, oldValue: number, newValue: number, dimension: string): void {
  dbMod.dbRun(
    `INSERT INTO turn_operations (user_id, turn_id, generation_id, operation_type, target_table, target_id, before_json, after_json, meta_json, created_at)
     VALUES (?, ?, ?, 'personality_log.create', 'personality_logs', ?, NULL, NULL, ?, ?)`,
    U,
    turnId,
    genId,
    logId,
    JSON.stringify({ dimension, old_value: oldValue, new_value: newValue }),
    now()
  );
}

test('P1-39 跨多轮累积：source_turns 记多元素；删除该轮不回退数值、不删日志', () => {
  dbMod.setSetting('custom_mode', '0');
  dbMod.setCounter('turn_count', 100);
  dbMod.dbRun(
    "UPDATE personality_state SET value = 50, last_adjusted_turn = 0, solidified = 0 WHERE user_id = ? AND dimension = 'warmth'",
    U
  );

  const u1 = insertMessage('user', 'u1');
  const a1 = insertMessage('assistant', 'a1');
  const u2 = insertMessage('user', 'u2');
  const a2 = insertMessage('assistant', 'a2');
  const u3 = insertMessage('user', 'u3');
  const a3 = insertMessage('assistant', 'a3');
  const t1 = insertTurn(u1);
  insertGen(t1, a1);
  const t2 = insertTurn(u2);
  insertGen(t2, a2);
  const t3 = insertTurn(u3);
  const g3 = insertGen(t3, a3);

  // 5 条同向信号，分布在 3 个回合（a1/a2/a3）上
  personalityMod.addSignals(sigs('warmth', ['一起做饭']), a1);
  personalityMod.addSignals(sigs('warmth', ['他记得我的喜好']), a2);
  personalityMod.addSignals(sigs('warmth', ['他主动来接我']), a3);
  personalityMod.addSignals(sigs('warmth', ['他替我披外套']), a1);
  personalityMod.addSignals(sigs('warmth', ['他记得我说过的话']), a2);

  personalityMod.runConfirmLayer(a3);

  const log = dbMod.dbGet<{
    id: number;
    old_value: number;
    new_value: number;
    source_turns: string | null;
    contributing_signal_ids: string | null;
  }>(
    "SELECT id, old_value, new_value, source_turns, contributing_signal_ids FROM personality_logs WHERE user_id = ? AND dimension = 'warmth' AND layer = 'confirm' ORDER BY id DESC LIMIT 1",
    U
  );
  assert.ok(log, '应产生一条 confirm 层调整日志');
  assert.deepEqual(JSON.parse(log!.source_turns!), [t1, t2, t3], 'source_turns 应记录全部来源回合（去重、升序）');
  assert.equal(JSON.parse(log!.contributing_signal_ids!).length, 5, 'contributing_signal_ids 应记录 5 条被消费信号');
  assert.equal(Number(log!.new_value), 51, 'warmth 应 +1');

  // 模拟分析阶段写入的操作账本（这条 op 属于 turn 3）
  recordPersonalityOp(t3, g3, log!.id, Number(log!.old_value), Number(log!.new_value), 'warmth');

  // 删除 turn 3（其 generation 的反向）
  const res = turnOpsMod.rollbackOperationsForGeneration(g3);
  assert.equal(res.rolledBack, 0, '多源累积的调整不应被反向');

  const val = Number(
    dbMod.dbGet<{ value: number }>("SELECT value FROM personality_state WHERE user_id = ? AND dimension = 'warmth'", U)?.value
  );
  assert.equal(val, 51, '属于多源累积 → 数值不得回退到 50');
  assert.ok(dbMod.dbGet('SELECT id FROM personality_logs WHERE id = ?', log!.id), '属于多源累积 → 日志不得删除');
});

test('P1-39 单一来源（唯一回合 == 被删回合）：仍按账本精确回滚', () => {
  dbMod.setSetting('custom_mode', '0');
  dbMod.setCounter('turn_count', 200);
  dbMod.dbRun(
    "UPDATE personality_state SET value = 50, last_adjusted_turn = 0, solidified = 0 WHERE user_id = ? AND dimension = 'playfulness'",
    U
  );

  const uX = insertMessage('user', 'uX');
  const aX = insertMessage('assistant', 'aX');
  const tX = insertTurn(uX);
  const gX = insertGen(tX, aX);

  // 5 条信号全部来自同一回合
  personalityMod.addSignals(sigs('playfulness', ['一起打游戏']), aX);
  personalityMod.addSignals(sigs('playfulness', ['一起看电影']), aX);
  personalityMod.addSignals(sigs('playfulness', ['他讲了个笑话']), aX);
  personalityMod.addSignals(sigs('playfulness', ['一起去散步']), aX);
  personalityMod.addSignals(sigs('playfulness', ['他逗我笑']), aX);

  personalityMod.runConfirmLayer(aX);

  const log = dbMod.dbGet<{ id: number; old_value: number; new_value: number; source_turns: string | null }>(
    "SELECT id, old_value, new_value, source_turns FROM personality_logs WHERE user_id = ? AND dimension = 'playfulness' AND layer = 'confirm' ORDER BY id DESC LIMIT 1",
    U
  );
  assert.ok(log, '应产生一条 confirm 层调整日志');
  assert.deepEqual(JSON.parse(log!.source_turns!), [tX], 'source_turns 应只含该回合');

  recordPersonalityOp(tX, gX, log!.id, Number(log!.old_value), Number(log!.new_value), 'playfulness');

  const res = turnOpsMod.rollbackOperationsForGeneration(gX);
  assert.equal(res.rolledBack, 1, '单一来源应正常反向');

  const val = Number(
    dbMod.dbGet<{ value: number }>("SELECT value FROM personality_state WHERE user_id = ? AND dimension = 'playfulness'", U)
      ?.value
  );
  assert.equal(val, 50, '单一来源 → 数值应精确回退');
  assert.equal(dbMod.dbGet('SELECT id FROM personality_logs WHERE id = ?', log!.id), undefined, '单一来源 → 日志应删除');
});