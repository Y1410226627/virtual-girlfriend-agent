// P1-04 关怀去重回归：一次"被关心"只走 applyCareEvent 一个入口。
// 旧实现里 applyInteractionEffects({caredForHer:true}) 会再叠一次 security 加成，
// 导致同一轮 care 让 security 加两次。这里用数值对比锁住"只加一次"。
// 隐私：使用独立临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-care-dedup-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const lifeMod = await import('../src/lib/life.ts');

dbMod.getDb(); // 触发建库（迁移 + 种子）

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

const U = dbMod.DEFAULT_USER_ID;

function setSecurity(v: number): void {
  dbMod.dbRun('UPDATE agent_psychology SET security = ? WHERE user_id = ?', v, U);
}

test('P1-04 同一轮"被关心"：security 只加一次（双路径不叠加）', () => {
  lifeMod.ensureLife();
  dbMod.setSetting('custom_mode', '0'); // 关闭自定义模式，允许自动数值

  // A) 单一入口：仅 applyCareEvent
  setSecurity(50);
  const beforeA = Number(lifeMod.getPsychology().security);
  lifeMod.applyCareEvent();
  const deltaA = Number(lifeMod.getPsychology().security) - beforeA;

  // B) 旧的双路径写法：applyCareEvent + applyInteractionEffects({caredForHer:true})
  setSecurity(50);
  const beforeB = Number(lifeMod.getPsychology().security);
  lifeMod.applyCareEvent();
  lifeMod.applyInteractionEffects({ caredForHer: true });
  const deltaB = Number(lifeMod.getPsychology().security) - beforeB;

  assert.equal(deltaA, 8, 'applyCareEvent 应使 security +8');
  assert.equal(deltaB, 8, 'applyInteractionEffects 不应再叠加一次 security（同一轮 care 只加一次）');
  assert.equal(deltaB, deltaA, '两条路径的 security 结果必须一致，不存在重复加成');
});

test('P1-04 applyCareEvent 合并了 caredForHer 的全部效果（孤独/想念下降）', () => {
  lifeMod.ensureLife();
  dbMod.setSetting('custom_mode', '0');
  dbMod.dbRun('UPDATE agent_psychology SET loneliness = 60, missing_user = 40 WHERE user_id = ?', U);

  const pBefore = lifeMod.getPsychology();
  lifeMod.applyCareEvent();
  const pAfter = lifeMod.getPsychology();

  assert.equal(Number(pAfter.loneliness), Number(pBefore.loneliness) - 12, '孤独应 -12');
  assert.equal(Number(pAfter.missing_user), Number(pBefore.missing_user) - 6, '想念应 -6');
});