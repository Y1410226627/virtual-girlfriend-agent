// 自定义模式冻结回归（P1-05，"模式 B"）：自动数值漂移全部冻结，记忆/日记/叙事不受影响
// 隐私：使用独立临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-custom-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const lifeMod = await import('../src/lib/life.ts');
const intimacyMod = await import('../src/lib/intimacy.ts');

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

const U = dbMod.DEFAULT_USER_ID;

function rewind(hours: number): void {
  dbMod.dbRun(
    'UPDATE agent_health SET updated_at = ? WHERE user_id = ?',
    new Date(Date.now() - hours * 3600000).toISOString(),
    U
  );
  dbMod.dbRun(
    'UPDATE intimacy_state SET updated_at = ? WHERE user_id = ?',
    new Date(Date.now() - hours * 3600000).toISOString(),
    U
  );
}

test('P1-05 自定义模式开启：生活/心理/互动/亲密漂移全部冻结', () => {
  lifeMod.ensureLife();
  dbMod.setSetting('custom_mode', '1');
  dbMod.dbRun('UPDATE agent_health SET energy = 55 WHERE user_id = ?', U);
  rewind(24);

  const hBefore = lifeMod.getHealth();
  const pBefore = lifeMod.getPsychology();
  const intBefore = intimacyMod.getIntimacy();

  const r = lifeMod.advanceLife();
  assert.equal(r.steps, 0, '自定义模式应冻结生活推进');

  lifeMod.applyLifeDeltas({ health: { energy: -40 }, psychology: { stress: 40, loneliness: 40 } });
  lifeMod.applyInteractionEffects({ caredForHer: true });
  intimacyMod.advanceIntimacy();

  const hAfter = lifeMod.getHealth();
  const pAfter = lifeMod.getPsychology();
  const intAfter = intimacyMod.getIntimacy();
  assert.equal(hAfter.energy, hBefore.energy, '精力不应漂移');
  assert.equal(hAfter.updated_at, hBefore.updated_at, '健康 updated_at 不应推进');
  assert.equal(pAfter.stress, pBefore.stress, '压力不应漂移');
  assert.equal(pAfter.loneliness, pBefore.loneliness, '孤独不应漂移');
  assert.equal(intAfter.libido, intBefore.libido, '亲密数值不应漂移');
});

test('P1-05 关闭自定义模式：生活推进恢复正常', () => {
  lifeMod.ensureLife();
  dbMod.setSetting('custom_mode', '0');
  dbMod.dbRun('UPDATE agent_health SET energy = 55 WHERE user_id = ?', U);
  rewind(24);

  const before = lifeMod.getHealth();
  const r = lifeMod.advanceLife();
  assert.ok(r.steps > 0, '关闭后应正常推进');
  assert.notEqual(lifeMod.getHealth().updated_at, before.updated_at, '关闭后 updated_at 应推进');
});