// 回合引擎回归：会话串行锁 / turn-generation 生命周期与 supersede / 版本校验 / 重启恢复 / 首次见面判定
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
// 网络无关：分析任务均走"校验不通过 → cancelled"路径，不会调用 LLM。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-turn-engine-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const turnMod = await import('../src/lib/turn.ts');
const engineMod = await import('../src/lib/engine.ts');
const queueMod = await import('../src/lib/analysisQueue.ts');
const { truncateMiddle } = await import('../src/lib/utils.ts');

dbMod.getDb(); // 触发建库（迁移 + 种子）

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

function insertMessage(role: string, content: string): number {
  return dbMod.dbRun(
    'INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    1,
    role,
    content,
    new Date().toISOString()
  ).lastInsertRowid;
}

function count(table: string): number {
  return Number(dbMod.dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)?.c ?? 0);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* P0-01 会话串行锁                                                      */
/* ------------------------------------------------------------------ */
test('P0-01 会话锁：并发的两个请求按顺序执行（非拒绝），且异常不阻塞后续', async () => {
  const order: string[] = [];
  const p1 = turnMod.withConversationLock(1, async () => {
    order.push('a-start');
    await delay(25);
    order.push('a-end');
  });
  const p2 = turnMod.withConversationLock(1, async () => {
    order.push('b-start');
    order.push('b-end');
  });
  assert.equal(turnMod.conversationBusy(1), true, '排队/执行中应视为忙碌');
  await Promise.all([p1, p2]);
  await delay(0); // 让队尾清理微任务跑完
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'], '必须严格串行');
  assert.equal(turnMod.conversationBusy(1), false, '结束后应释放');

  // 前一棒抛错不应中断后一棒
  const p3 = turnMod.withConversationLock(1, async () => {
    throw new Error('故意失败');
  });
  await assert.rejects(p3, /故意失败/);
  const ok = await turnMod.withConversationLock(1, async () => 'next');
  assert.equal(ok, 'next');
});

/* ------------------------------------------------------------------ */
/* P0-03/P0-04/P0-05 生命周期与 supersede                                */
/* ------------------------------------------------------------------ */
test('turn/generation 生命周期：同一 turn 两次生成、turn 仅一条、turn_count 不增', () => {
  const turnsBefore = count('conversation_turns');
  const genBefore = count('message_generations');
  const uid = insertMessage('user', '第一次问');
  const turn = turnMod.createTurn(uid);

  const g1 = turnMod.beginGeneration(turn.id);
  assert.equal(g1.generation_no, 1);
  assert.equal(turnMod.currentGenerationForTurn(turn.id)?.id, g1.id, 'beginGeneration 应置为当前');
  const aid1 = insertMessage('assistant', '第一次答');
  assert.equal(turnMod.completeGeneration(g1.id, aid1), true, '仍是当前生成时应完成');
  assert.equal(turnMod.getTurnById(turn.id)?.status, 'completed');
  assert.equal(turnMod.isGenerationCurrent(g1.id), true, '完成后仍应是当前有效生成');

  // 重新生成：取代旧生成、建新生成；不新建 turn
  turnMod.supersedeGeneration(g1.id);
  assert.equal(turnMod.isGenerationCurrent(g1.id), false, '被取代后不再是当前有效生成');
  const g2 = turnMod.beginGeneration(turn.id);
  assert.equal(g2.generation_no, 2, 'generation_no 递增');
  assert.equal(turnMod.currentGenerationForTurn(turn.id)?.id, g2.id);
  assert.equal(turnMod.generationByAssistantMessageId(aid1)?.id, g1.id, '可按 assistant 消息定位生成');

  assert.equal(count('conversation_turns'), turnsBefore + 1, '同一用户消息只有一个 turn');
  assert.equal(count('message_generations'), genBefore + 2, '两次生成两条记录');
  assert.equal(dbMod.getCounter('turn_count'), 0, '未 commitTurn 就不得增加 turn_count');
  assert.equal(turnMod.getTurnByUserMessageId(uid)?.id, turn.id, '可按用户消息反查 turn');
});

/* ------------------------------------------------------------------ */
/* P0-06 版本校验：被 supersede 的任务不得产生分析副作用                   */
/* ------------------------------------------------------------------ */
test('分析任务版本校验：generation 被取代后 drain 结果为 cancelled，且无分析副作用', async () => {
  const uid = insertMessage('user', '原问题');
  const turn = turnMod.createTurn(uid);
  const gA = turnMod.beginGeneration(turn.id);
  const aidA = insertMessage('assistant', '原回复');
  assert.equal(turnMod.completeGeneration(gA.id, aidA), true);

  const effectsBefore = count('turn_effects');
  const turnsBefore = count('conversation_turns');
  const memBefore = count('memories');

  // 为 generation A 入队（入队会异步踢 drain，但 drain 会先让出一次微任务）
  const { promise, jobId } = queueMod.enqueueAnalysis({
    turnId: turn.id,
    generationId: gA.id,
    userMessageId: uid,
    assistantMessageId: aidA,
  });
  // 同步 supersede A 并建 B —— 先于 drain 领取任务
  turnMod.supersedeGeneration(gA.id);
  const gB = turnMod.beginGeneration(turn.id);
  assert.equal(turnMod.isGenerationCurrent(gB.id), true);

  await queueMod.drainAnalysisQueue();
  const out = await promise;
  assert.equal(out.ok, false, '被取代的任务不得成功执行');

  const row = dbMod.dbGet<{ status: string }>('SELECT status FROM analysis_jobs WHERE id = ?', jobId);
  assert.equal(row?.status, 'cancelled', '任务应被标记为 cancelled');

  assert.equal(count('turn_effects'), effectsBefore, 'cancelled 任务不得写入分析副作用');
  assert.equal(count('memories'), memBefore, 'cancelled 任务不得新增记忆');
  assert.equal(count('conversation_turns'), turnsBefore, '不得多建 turn');
});

/* ------------------------------------------------------------------ */
/* P0-06 启动恢复：遗留 running 改回 pending 并被处理                     */
/* ------------------------------------------------------------------ */
test('重启恢复：遗留 running（超过 30 分钟）改回 pending 并被处理', async () => {
  const now = Date.now();
  const old = new Date(now - 40 * 60 * 1000).toISOString();
  const { lastInsertRowid: jobId } = dbMod.dbRun(
    `INSERT INTO analysis_jobs
       (user_id, turn_id, generation_id, user_message_id, assistant_message_id, status, attempts, started_at, created_at)
     VALUES (?, NULL, NULL, NULL, NULL, 'running', 0, ?, ?)`,
    1,
    old,
    old
  );

  const recovered = queueMod.recoverStaleAnalysisJobs(now);
  assert.ok(recovered >= 1, '遗留 running 应被恢复');
  assert.equal(
    dbMod.dbGet<{ status: string }>('SELECT status FROM analysis_jobs WHERE id = ?', jobId)?.status,
    'pending',
    '恢复后应为 pending'
  );

  await queueMod.drainAnalysisQueue();
  // 无 assistant 消息 → 校验不通过 → cancelled（被"处理"到终态，未触发网络）
  assert.equal(
    dbMod.dbGet<{ status: string }>('SELECT status FROM analysis_jobs WHERE id = ?', jobId)?.status,
    'cancelled',
    '恢复后的任务应被处理到终态'
  );
});

/* ------------------------------------------------------------------ */
/* P0-06 队列状态形状                                                    */
/* ------------------------------------------------------------------ */
test('analysisQueueStatus 字段形状保持：pending/running/busy/lastMs/lastFinishedAt/last', () => {
  const st = queueMod.analysisQueueStatus();
  for (const k of ['pending', 'running', 'busy', 'lastMs', 'lastFinishedAt', 'last']) {
    assert.ok(k in st, `缺少字段 ${k}`);
  }
  assert.equal(typeof st.pending, 'number');
  assert.equal(typeof st.running, 'boolean');
  assert.equal(st.busy, st.running || st.pending > 0, 'busy = running || pending>0');
});

/* ------------------------------------------------------------------ */
/* P1-19 首次见面判定基于持久计数                                        */
/* ------------------------------------------------------------------ */
test('P1-19 首次见面：消息 >2 条但 turn_count=0 仍判定首次；turn_count>0 后为否', () => {
  dbMod.setCounter('turn_count', 0);
  for (let i = 0; i < 4; i++) insertMessage(i % 2 === 0 ? 'user' : 'assistant', `历史消息 ${i}`);
  assert.ok(count('messages') > 2, '前置：消息数已超过 2');
  assert.equal(engineMod.isFirstMeeting(), true, '不得再按 messageCount<=2 判定');

  dbMod.bumpCounter('turn_count');
  assert.equal(engineMod.isFirstMeeting(), false, '已成功完成过一轮后不再是首次');
  dbMod.setCounter('turn_count', 0);
});

/* ------------------------------------------------------------------ */
/* P1-10 长消息头尾保留                                                  */
/* ------------------------------------------------------------------ */
test('P1-10 truncateMiddle：头尾保留、总长不越界、极端短文本安全', () => {
  const long = 'A'.repeat(500) + 'MIDDLE' + 'B'.repeat(500);
  const out = truncateMiddle(long, 100);
  assert.ok(out.length <= 100, '结果长度不得超过 max（含省略号）');
  assert.ok(out.includes('…'));
  assert.ok(out.startsWith('AAA'), '应保留头部');
  assert.ok(out.endsWith('BBB'), '应保留尾部');
  assert.ok(!out.includes('MIDDLE'), '中间应被省略');

  assert.equal(truncateMiddle('短', 100), '短', '不超过 max 时原样返回');
  assert.equal(truncateMiddle('', 100), '');
  assert.equal(truncateMiddle('abcdef', 1), '…');
  assert.ok(truncateMiddle('abcdef', 2).length <= 2);
  assert.ok(truncateMiddle('abcdef', 3).length <= 3);
});