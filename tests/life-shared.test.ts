// 共享世界回归：计划稳定 id 寻址（P1-10）+ 亲密偏好门槛（P1-9）
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-lifeshared-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const lifeMod = await import('../src/lib/life.ts');

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

function setPlans(plans: unknown[]): void {
  dbMod.dbRun(
    'UPDATE shared_world SET shared_plans_json = ?, updated_at = ? WHERE user_id = ?',
    JSON.stringify(plans),
    new Date().toISOString(),
    dbMod.DEFAULT_USER_ID
  );
}

/* ------------------------------------------------------------------ */
/* P1-10：计划按稳定 id 寻址                                             */
/* ------------------------------------------------------------------ */

test('P1-10 新计划带稳定 id；按 id 完成不受下标位移影响', () => {
  lifeMod.ensureLife();
  lifeMod.addSharedPlan('一起看那部电影');
  lifeMod.addSharedPlan('周末去逛书店');
  const plans = lifeMod.getSharedWorld().plans;
  assert.equal(plans.length, 2);
  assert.ok(plans[0]!.id && plans[1]!.id, '新条目应带稳定 id');
  assert.notEqual(plans[0]!.id, plans[1]!.id);
  const secondId = plans[1]!.id!;

  // 模拟"打开页面瞬间前面被新增一条"造成下标位移
  setPlans([
    { id: 'external-new', content: '临时新增的一条', status: 'planning', created_at: new Date().toISOString() },
    ...plans,
  ]);

  // 按第二条的 id 完成 → 必须命中"周末去逛书店"，而不是位移后下标对应的"一起看那部电影"
  lifeMod.completePlan(secondId);
  const after1 = lifeMod.getSharedWorld().plans;
  const target = after1.find((p) => p.content === '周末去逛书店');
  const wrong = after1.find((p) => p.content === '一起看那部电影');
  assert.equal(target!.status, 'done', '按 id 应命中第二条计划');
  assert.notEqual(wrong!.status, 'done', '不应误改其它计划');
});

test('P1-10 老数据（无 id）仍按下标兜底，行为不劣化', () => {
  lifeMod.ensureLife();
  setPlans([
    { content: '旧计划A', status: 'planning' },
    { content: '旧计划B', status: 'planning' },
  ]);
  lifeMod.completePlan(1);
  const after1 = lifeMod.getSharedWorld().plans;
  assert.equal(after1.find((p) => p.content === '旧计划B')!.status, 'done', '无 id 时按下标寻址');
  assert.notEqual(after1.find((p) => p.content === '旧计划A')!.status, 'done');
});

/* ------------------------------------------------------------------ */
/* P1-9：亲密偏好门槛                                                   */
/* ------------------------------------------------------------------ */

test('P1-9 偏好门槛：NULL/空 → 默认 2；阶段 0/1 不暴露，阶段 2+ 才暴露', () => {
  lifeMod.ensureLife();
  dbMod.dbRun('DELETE FROM intimacy_preferences WHERE user_id = ?', dbMod.DEFAULT_USER_ID);

  const ins = (type: string, content: string, stage: number) =>
    dbMod.dbRun(
      "INSERT INTO intimacy_preferences (user_id, preference_type, content, reveal_status, reveal_stage, created_at) VALUES (?, ?, ?, 'hidden', ?, ?)",
      dbMod.DEFAULT_USER_ID,
      type,
      content,
      stage,
      new Date().toISOString()
    );
  ins('p2', '阶段2的偏好内容H2', 2);
  ins('p0', '阶段0的偏好内容H0', 0);
  const setStage = (s: number) =>
    dbMod.dbRun('UPDATE relationship_state SET stage = ? WHERE user_id = ?', s, dbMod.DEFAULT_USER_ID);

  // 门槛取值：NULL/空 → 迁移默认 2；0 仍为 0（不会被当成未设置）
  assert.equal(lifeMod.preferenceRevealStage({ reveal_stage: null }), 2);
  assert.equal(lifeMod.preferenceRevealStage({ reveal_stage: undefined }), 2);
  assert.equal(lifeMod.preferenceRevealStage({ reveal_stage: '' }), 2);
  assert.equal(lifeMod.preferenceRevealStage({ reveal_stage: 0 }), 0);

  const statusOf = (type: string) =>
    lifeMod.listPreferences(true).find((p) => p.preference_type === type)!.reveal_status;

  // 阶段 0：门槛 0 可揭露，门槛 2 不揭露；门槛 2 的内容不进 prompt
  setStage(0);
  lifeMod.revealPreferences(['p2', 'p0']);
  assert.equal(statusOf('p0'), 'revealed', '门槛 0 在阶段 0 即可揭露');
  assert.equal(statusOf('p2'), 'hidden', '门槛 2 在阶段 0 不应揭露');
  assert.ok(!lifeMod.preferencePromptBlock().includes('阶段2的偏好内容H2'), '阶段 0 不应注入门槛 2 的偏好');

  // 阶段 1：门槛 2 仍不揭露
  setStage(1);
  lifeMod.revealPreferences(['p2']);
  assert.equal(statusOf('p2'), 'hidden', '阶段 1 仍不应揭露门槛 2');
  assert.ok(!lifeMod.preferencePromptBlock().includes('阶段2的偏好内容H2'), '阶段 1 不应注入门槛 2 的偏好');

  // 阶段 2：门槛 2 才揭露
  setStage(2);
  lifeMod.revealPreferences(['p2']);
  assert.equal(statusOf('p2'), 'revealed', '阶段 2 才揭露门槛 2');
  assert.ok(lifeMod.preferencePromptBlock().includes('阶段2的偏好内容H2'), '阶段 2 应注入已揭露偏好');
});