// 揭露门槛回归：档案三态（auto/revealed/hidden）+ 模型越权保护 + 亲密偏好门槛（P1-36/37/38）
// 隐私：使用独立临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-reveal-${process.pid}-${Date.now()}.db`);
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
const setStage = (s: number) => dbMod.dbRun('UPDATE relationship_state SET stage = ? WHERE user_id = ?', s, U);
const rawReveal = (): Record<string, unknown> =>
  JSON.parse((dbMod.dbGet<{ reveal_status: string }>('SELECT reveal_status FROM agent_profile WHERE user_id = ?', U)?.reveal_status) || '{}') as Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* 旧 boolean 数据兼容                                                  */
/* ------------------------------------------------------------------ */

test('P1-37 旧数据兼容：true→revealed，false/缺失→auto', () => {
  lifeMod.ensureLife();
  dbMod.dbRun('UPDATE agent_profile SET reveal_status = ? WHERE user_id = ?', '{"hometown":true,"fears":false}', U);
  const seed = lifeMod.getProfileSeed();
  assert.equal(seed.reveal.hometown, 'revealed');
  assert.equal(seed.reveal.fears, 'auto');

  setStage(0);
  assert.equal(lifeMod.isFieldRevealed('hometown'), true, '显式 revealed 恒为真');
  assert.equal(lifeMod.isFieldRevealed('fears'), false, 'auto 且阶段不足 → 未揭露');
  setStage(3);
  assert.equal(lifeMod.isFieldRevealed('fears'), true, '进入门槛 3 后 auto 自动揭露');
});

/* ------------------------------------------------------------------ */
/* hidden 永不自动揭露                                                  */
/* ------------------------------------------------------------------ */

test('P1-36 hidden：阶段再高也不自动揭露，且不进 prompt', () => {
  lifeMod.ensureLife();
  dbMod.dbRun('UPDATE agent_profile SET reveal_status = ? WHERE user_id = ?', '{}', U);
  lifeMod.setProfileField('secrets', '一个只属于我的秘密');
  lifeMod.hideProfileField('secrets');

  assert.equal(lifeMod.getProfileSeed().reveal.secrets, 'hidden', 'hide 应写 hidden 而不是删除');
  setStage(4);
  assert.equal(lifeMod.isFieldRevealed('secrets'), false, 'hidden 即便到承诺期也不揭露');
  assert.ok(!lifeMod.profilePromptBlock().includes('一个只属于我的秘密'), 'hidden 的内容不应注入 prompt');
});

/* ------------------------------------------------------------------ */
/* 模型越权保护                                                         */
/* ------------------------------------------------------------------ */

test('P1-36 模型越权：阶段未达门限时 revealProfileFields 被忽略', () => {
  lifeMod.ensureLife();
  dbMod.dbRun('UPDATE agent_profile SET reveal_status = ? WHERE user_id = ?', '{}', U);
  lifeMod.setProfileField('secrets', '越权测试秘密');
  setStage(0);
  lifeMod.revealProfileFields(['secrets']);
  assert.equal(lifeMod.isFieldRevealed('secrets'), false, '阶段 0 不应揭露 secrets');
  assert.equal(rawReveal().secrets, undefined, '被拦截时不应写入 reveal_status（保持 auto）');

  // 到门槛后才允许
  setStage(4);
  lifeMod.revealProfileFields(['secrets']);
  assert.equal(lifeMod.getProfileSeed().reveal.secrets, 'revealed');
  assert.equal(lifeMod.isFieldRevealed('secrets'), true);
});

test('P1-37 revealed 恒为真：显式揭露后回退阶段仍算已说', () => {
  lifeMod.ensureLife();
  dbMod.dbRun('UPDATE agent_profile SET reveal_status = ? WHERE user_id = ?', '{}', U);
  setStage(3);
  lifeMod.revealProfileFields(['fears']);
  assert.equal(lifeMod.getProfileSeed().reveal.fears, 'revealed');
  setStage(0);
  assert.equal(lifeMod.isFieldRevealed('fears'), true, 'revealed 不随阶段回退而失效');
});

/* ------------------------------------------------------------------ */
/* P1-38 亲密偏好越权                                                    */
/* ------------------------------------------------------------------ */

test('P1-38 addPreference：未达门槛时 revealed 被忽略（落 hidden）', () => {
  lifeMod.ensureLife();
  dbMod.dbRun('DELETE FROM intimacy_preferences WHERE user_id = ?', U);
  const statusOf = (type: string) =>
    dbMod.dbGet<{ reveal_status: string }>('SELECT reveal_status FROM intimacy_preferences WHERE user_id = ? AND preference_type = ?', U, type)
      ?.reveal_status;

  setStage(0);
  intimacyMod.addPreference({ type: 'low', content: '低阶段也不该提前揭露的偏好', revealed: true });
  assert.equal(statusOf('low'), 'hidden', '阶段 0 即便请求 revealed 也应落 hidden');

  setStage(2);
  intimacyMod.addPreference({ type: 'ok', content: '阶段到了可以揭露', revealed: true });
  assert.equal(statusOf('ok'), 'revealed', '阶段 2 达到门槛才允许揭露');

  intimacyMod.addPreference({ type: 'never', content: '没要求揭露', revealed: false });
  assert.equal(statusOf('never'), 'hidden');
});