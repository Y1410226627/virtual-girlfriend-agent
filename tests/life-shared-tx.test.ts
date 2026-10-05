// 共享世界事务化回归（P1-33）：读 JSON → 改 JSON → 写回 必须同一事务，失败整体回滚
// 隐私：使用独立临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-sharedtx-${process.pid}-${Date.now()}.db`);
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

test('P1-33 新增计划：日志写入失败 → 计划整体回滚，不留半条', () => {
  lifeMod.ensureLife();
  assert.equal(lifeMod.getSharedWorld().plans.length, 0);

  const dbi = dbMod.getDb();
  const realPrepare = dbi.prepare.bind(dbi);
  dbi.prepare = ((sql: string, options?: Parameters<typeof dbi.prepare>[1]) => {
    if (String(sql).includes('INSERT INTO life_state_logs')) {
      throw new Error('注入失败：模拟日志写入失败');
    }
    return realPrepare(sql, options);
  }) as typeof dbi.prepare;

  assert.throws(() => lifeMod.addSharedPlan('注入测试计划'), /注入失败/);
  dbi.prepare = realPrepare;

  assert.equal(lifeMod.getSharedWorld().plans.length, 0, '失败必须整体回滚，计划不应落库');
});

test('P1-33 正常路径：新增去重 + 完成状态切回滚一致', () => {
  lifeMod.addSharedPlan('一起看那部电影');
  lifeMod.addSharedPlan('一起看那部电影'); // 重复 → 去重
  const plans = lifeMod.getSharedWorld().plans;
  assert.equal(plans.length, 1, '相同内容应去重');

  const id = plans[0]!.id!;
  lifeMod.completePlan(id);
  assert.equal(lifeMod.getSharedWorld().plans[0]!.status, 'done');
  lifeMod.completePlan(id);
  assert.equal(lifeMod.getSharedWorld().plans[0]!.status, 'planning');
});