// T02 收尾 · 后台任务按伴侣遍历（§3.8）+ analysisQueue 跨伴侣 drain。
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据。
//
// 覆盖：
//  A. 单伴侣零回归：只有主女友时，tick 仍完整推进 c1（与旧"只推进主女友"行为一致）
//  B. listAdvanceableCompanions：含 c1、按 id 升序、只含 girlfriend
//  C. tick 遍历：c1 与 c2 的生活/亲密推进都被执行（各自作用域内可见变化）
//  D. 单伴侣失败隔离：c2 推进抛错不影响 c1，且 tick 不 500
//  E. 节流仍生效：同一伴侣连续两次 tick 不重复触发受节流保护的任务
//  F. drain 跨伴侣：c1 与 c2 的任务都被处理，各落各伴侣（防串扰核心断言）
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-t02-background-fanout-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const ctxMod = await import('../src/lib/companion-context.ts');
const companionMod = await import('../src/lib/companion.ts');
const engineMod = await import('../src/lib/engine.ts');
const queueMod = await import('../src/lib/analysisQueue.ts');
const tickMod = await import('../src/app/api/tick/route.ts');

dbMod.getDb(); // 触发建库（迁移 + 种子：companion 1 = 主女友 girlfriend）

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

const { withCompanion } = ctxMod;
const { dbRun, dbGet, getCounter, DEFAULT_USER_ID } = dbMod;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ageIntimacy(id: number, hoursAgo: number): void {
  dbRun(
    'UPDATE intimacy_state SET updated_at = ? WHERE companion_id = ?',
    new Date(Date.now() - hoursAgo * 3600000).toISOString(),
    id
  );
}
function ageHealth(id: number, hoursAgo: number): void {
  dbRun(
    'UPDATE agent_health SET updated_at = ? WHERE companion_id = ?',
    new Date(Date.now() - hoursAgo * 3600000).toISOString(),
    id
  );
}
function intimacyUpdatedAt(id: number): string {
  return String(dbGet<{ updated_at: string }>('SELECT updated_at FROM intimacy_state WHERE companion_id = ?', id)?.updated_at ?? '');
}
function makeGirlfriend(name: string, age: number): number {
  const c = companionMod.createCompanion({ name, age });
  assert.ok(c.ok, `创建 ${name} 失败`);
  companionMod.promote(c.companion.id);
  assert.equal(companionMod.getCompanion(c.companion.id)?.status, 'girlfriend');
  return c.companion.id;
}

/* ================================================================== */
/* A. 单伴侣零回归（必须最先跑：此刻只有 c1 是 girlfriend）               */
/* ================================================================== */
test('A. 单伴侣零回归：只有 c1 时 tick 完整推进主女友', async () => {
  assert.deepEqual(companionMod.listAdvanceableCompanions(), [1], '此刻应只有主女友需要推进');

  ageIntimacy(1, 3);
  ageHealth(1, 3);
  const beforeIntimacy = intimacyUpdatedAt(1);
  const beforeHealth = String(dbGet<{ updated_at: string }>('SELECT updated_at FROM agent_health WHERE companion_id = 1')?.updated_at ?? '');

  const res = await tickMod.POST();
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);

  assert.notEqual(intimacyUpdatedAt(1), beforeIntimacy, 'c1 亲密应被推进（与旧行为一致）');
  const afterHealth = String(dbGet<{ updated_at: string }>('SELECT updated_at FROM agent_health WHERE companion_id = 1')?.updated_at ?? '');
  assert.notEqual(afterHealth, beforeHealth, 'c1 生活应被推进（与旧行为一致）');
});

/* ================================================================== */
/* B. 枚举：含 c1、升序、只含 girlfriend                                */
/* ================================================================== */
test('B. listAdvanceableCompanions：含 c1、按 id 升序、只含 girlfriend', () => {
  const c2 = makeGirlfriend('后台甲', 25);
  const stranger = companionMod.createCompanion({ name: '旁观乙', age: 26 }); // 默认 stranger
  assert.ok(stranger.ok);

  const ids = companionMod.listAdvanceableCompanions();
  assert.deepEqual(ids, [1, c2], '应含 c1 与女友 c2 且升序');
  assert.equal(ids[0], 1, 'c1 必须最先');
  assert.ok(!ids.includes(stranger.companion.id), '非 girlfriend 不应纳入推进');
});

/* ================================================================== */
/* C. tick 遍历：c1 与 c2 都被推进                                       */
/* ================================================================== */
test('C. tick 遍历：c1 与 c2 的生活/亲密推进都执行（各自作用域）', async () => {
  const c2 = makeGirlfriend('后台丙', 25);

  ageIntimacy(1, 3);
  ageIntimacy(c2, 3);
  const before1 = intimacyUpdatedAt(1);
  const before2 = intimacyUpdatedAt(c2);

  const res = await tickMod.POST();
  assert.equal(res.status, 200);

  assert.notEqual(intimacyUpdatedAt(1), before1, 'c1 的亲密应被推进');
  assert.notEqual(intimacyUpdatedAt(c2), before2, 'c2 的亲密应被推进（不再只服务主女友）');
});

/* ================================================================== */
/* D. 单伴侣失败隔离                                                     */
/* ================================================================== */
test('D. 单伴侣失败隔离：c2 推进抛错不影响 c1，且 tick 不 500', async () => {
  const c2 = makeGirlfriend('后台丁', 25);
  // 删掉 c2 的 relationship_state → advanceLife/advanceIntimacy 会抛 'relationship_state 未初始化'
  // （ensureLife 不会重建 relationship_state），从而只让 c2 这一支失败
  dbRun('DELETE FROM relationship_state WHERE companion_id = ?', c2);
  assert.equal(
    dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM relationship_state WHERE companion_id = ?', c2)?.c,
    0
  );

  ageIntimacy(1, 4);
  const before1 = intimacyUpdatedAt(1);

  const res = await tickMod.POST();
  assert.equal(res.status, 200, 'tick 不应因单伴侣失败而 500');
  const body = await res.json();
  assert.equal(body.ok, true, '整体仍应返回 ok');
  assert.notEqual(intimacyUpdatedAt(1), before1, 'c1 仍应完成推进（失败被隔离）');
});

/* ================================================================== */
/* E. 节流仍生效                                                         */
/* ================================================================== */
test('E. 节流仍生效：连续两次 tick 不重复触发受节流保护的任务', async () => {
  await tickMod.POST(); // 第一次：写入节流时间戳
  const arc1 = getCounter('life_arc_check_at'); // 主女友无后缀键
  const diary1 = getCounter('diary_check_at');
  assert.ok(arc1 > 0, 'life_arc_check_at 应已被写入');
  assert.ok(diary1 > 0, 'diary_check_at 应已被写入');

  await tickMod.POST(); // 第二次：节流窗口内应跳过，不改写时间戳
  assert.equal(getCounter('life_arc_check_at'), arc1, '第二次 tick 不应重复推进 life_arc');
  assert.equal(getCounter('diary_check_at'), diary1, '第二次 tick 不应重复推进 diary');
});

/* ================================================================== */
/* F. drain 跨伴侣（防串扰核心断言）                                     */
/* ================================================================== */
test('F. drain 跨伴侣：c1 与 c2 的任务都被处理，各落各伴侣', async () => {
  await sleep(60); // 等模块初始化时那次 drain 结束（避免 draining 早退）

  const c2 = makeGirlfriend('后台戊', 25);

  // 为 c1 / c2 各造一对消息（内容可区分；id 全局唯一 → 串扰时另一伴侣必然查不到）
  const u1 = withCompanion(1, () => engineMod.insertMessage('user', 'c1 的问题'));
  const a1 = withCompanion(1, () => engineMod.insertMessage('assistant', 'c1 的回复'));
  const u2 = withCompanion(c2, () => engineMod.insertMessage('user', 'c2 的问题'));
  const a2 = withCompanion(c2, () => engineMod.insertMessage('assistant', 'c2 的回复'));

  const now = new Date().toISOString();
  const ins = `INSERT INTO analysis_jobs
     (companion_id, user_id, turn_id, generation_id, user_message_id, assistant_message_id, status, attempts, created_at)
     VALUES (?, ?, NULL, NULL, ?, ?, 'pending', 0, ?)`;
  const j1 = Number(dbRun(ins, 1, DEFAULT_USER_ID, u1, a1, now).lastInsertRowid);
  const j2 = Number(dbRun(ins, c2, DEFAULT_USER_ID, u2, a2, now).lastInsertRowid);

  await queueMod.drainAnalysisQueue();

  const r1 = dbGet<{ status: string; attempts: number; error: string | null; companion_id: number }>(
    'SELECT status, attempts, error, companion_id FROM analysis_jobs WHERE id = ?',
    j1
  );
  const r2 = dbGet<{ status: string; attempts: number; error: string | null; companion_id: number }>(
    'SELECT status, attempts, error, companion_id FROM analysis_jobs WHERE id = ?',
    j2
  );

  // 若发生跨伴侣串扰：c2 的任务会在 c1 作用域下校验失败 → validateJob 找不到消息 → cancelled。
  assert.notEqual(String(r1?.status), 'cancelled', 'c1 任务不应被作废');
  assert.notEqual(String(r2?.status), 'cancelled', 'c2 任务不应被作废（串扰时会在 c1 作用域找不到消息）');
  assert.ok(!String(r2?.error ?? '').includes('已不存在'), 'c2 任务不应因"消息不存在"被取消（防串扰）');
  // 两条都应"进入 analyzeTurn"（无模型 → 失败重试 → attempts>=1、状态回 pending），证明校验通过
  assert.ok(Number(r1?.attempts ?? 0) >= 1, 'c1 任务应已进入分析（attempts>=1）');
  assert.ok(Number(r2?.attempts ?? 0) >= 1, 'c2 任务应已进入分析（attempts>=1）');
  // 归属未被改动
  assert.equal(Number(r1?.companion_id), 1);
  assert.equal(Number(r2?.companion_id), c2);
});

/* ================================================================== */
/* G. 跨伴侣恢复：recoverAllStale 覆盖所有伴侣，分区版仍按 cId            */
/* ================================================================== */
test('G. recoverAllStaleAnalysisJobs 跨伴侣恢复遗留 running', () => {
  const c2 = makeGirlfriend('后台己', 25);
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 小时前 → 超过 30 分钟陈旧阈值
  const now = new Date().toISOString();
  const ins = `INSERT INTO analysis_jobs
     (companion_id, user_id, status, attempts, started_at, created_at)
     VALUES (?, ?, 'running', 0, ?, ?)`;
  const j1 = Number(dbRun(ins, 1, DEFAULT_USER_ID, old, now).lastInsertRowid);
  const j2 = Number(dbRun(ins, c2, DEFAULT_USER_ID, old, now).lastInsertRowid);
  const statusOf = (id: number) =>
    String(dbGet<{ status: string }>('SELECT status FROM analysis_jobs WHERE id = ?', id)?.status ?? '');

  // 分区恢复：只回收 cId()=1 的陈旧任务
  const scoped = withCompanion(1, () => queueMod.recoverStaleAnalysisJobs());
  assert.equal(scoped, 1, '分区恢复只回收 c1 的 1 条');
  assert.equal(statusOf(j1), 'pending', 'c1 的陈旧 running 应回 pending');
  assert.equal(statusOf(j2), 'running', '分区恢复不得动 c2（按 companion_id 分区）');

  // 跨伴侣恢复：回收 c2 的遗留 running（§3.8 启动恢复）
  const all = queueMod.recoverAllStaleAnalysisJobs();
  assert.ok(all >= 1, '跨伴侣恢复应至少回收 c2 的 1 条');
  assert.equal(statusOf(j2), 'pending', '跨伴侣恢复应回收 c2 的陈旧 running');
});
