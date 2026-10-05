// 生活系统回归：生理期开关（P1-15）+ 生活线"第 N 天"按时间推导（P1-16）
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-lifearc-${process.pid}-${Date.now()}.db`);
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

/* ------------------------------------------------------------------ */
/* P1-15：重新开启生理期重置天数                                         */
/* ------------------------------------------------------------------ */

test('P1-15 重新开启生理期 → cycle_day 重置为 1；已开启时幂等', () => {
  lifeMod.ensureLife();
  lifeMod.setCycle(true, 28);
  assert.equal(lifeMod.getHealth().cycle_day, 28);

  lifeMod.setCycleEnabled(false);
  assert.equal(lifeMod.getHealth().cycle_enabled, 0);
  assert.equal(lifeMod.getHealth().cycle_day, 28, '关闭时保留天数');

  lifeMod.setCycleEnabled(true);
  const h = lifeMod.getHealth();
  assert.equal(h.cycle_enabled, 1);
  assert.equal(h.cycle_day, 1, '重新开启应视为新周期，天数重置为 1');

  // 已开启状态下再次调用不应重置
  lifeMod.setCycle(true, 15);
  lifeMod.setCycleEnabled(true);
  assert.equal(lifeMod.getHealth().cycle_day, 15, '已开启时再次调用不应重置天数');
});

/* ------------------------------------------------------------------ */
/* P1-16：生活线第 N 天按时间推导                                        */
/* ------------------------------------------------------------------ */

test('P1-16 生活线"第 N 天"按 started_at 时间推导，不依赖 progress', () => {
  const now = Date.now();
  const mk = (startedAt: string, plannedDays: number) => ({ started_at: startedAt, planned_days: plannedDays });

  assert.equal(lifeMod.lifeArcDay(mk(new Date(now - 1000).toISOString(), 5), now), 1, '刚启动 → 第 1 天');
  // 启动已满 2 天（进入第 3 天）→ 第 3 天
  assert.equal(lifeMod.lifeArcDay(mk(new Date(now - (2 * 86400000 + 3600000)).toISOString(), 5), now), 3);
  assert.equal(lifeMod.lifeArcDay(mk(new Date(now - 10 * 86400000).toISOString(), 5), now), 5, '不超过 planned_days');
  assert.equal(lifeMod.lifeArcDay({ started_at: 'not-a-date', planned_days: 5 }, now), 1, '非法时间兜底为第 1 天');
});