// 事后关怀原子性回归（P1-49）：多表写入中途失败必须整体回滚
// 隐私：使用独立临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-aftercare-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const lifeMod = await import('../src/lib/life.ts');
const intimacyMod = await import('../src/lib/intimacy.ts');
const relMod = await import('../src/lib/relationship.ts');

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

const U = dbMod.DEFAULT_USER_ID;
const bankCount = () => Number(dbMod.dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM emotional_bank WHERE user_id = ?', U)?.c ?? 0);
const aftercareCount = () => Number(dbMod.dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM intimacy_aftercare WHERE user_id = ?', U)?.c ?? 0);

test('P1-49 startAftercare 写入失败 → 亲密/心理/关系/银行/流水一并回滚', () => {
  lifeMod.ensureLife();

  const sBefore = intimacyMod.getIntimacy();
  const pBefore = lifeMod.getPsychology();
  const rBefore = relMod.getRelationshipState();
  const bankBefore = bankCount();
  const acBefore = aftercareCount();

  const dbi = dbMod.getDb();
  const realPrepare = dbi.prepare.bind(dbi);
  dbi.prepare = ((sql: string, options?: Parameters<typeof dbi.prepare>[1]) => {
    if (String(sql).includes('INSERT INTO intimacy_aftercare')) {
      throw new Error('注入失败：模拟事后关怀流水写入失败');
    }
    return realPrepare(sql, options);
  }) as typeof dbi.prepare;

  assert.throws(() => intimacyMod.startAftercare('ignored'), /注入失败/);
  dbi.prepare = realPrepare;

  const sAfter = intimacyMod.getIntimacy();
  const pAfter = lifeMod.getPsychology();
  const rAfter = relMod.getRelationshipState();

  assert.equal(sAfter.sexual_satisfaction, sBefore.sexual_satisfaction, '亲密状态应回滚');
  assert.equal(sAfter.libido, sBefore.libido, '性欲应回滚');
  assert.equal(sAfter.aftercare_until, sBefore.aftercare_until, '事后状态时间应回滚');
  assert.equal(pAfter.security, pBefore.security, '安全感应回滚');
  assert.equal(rAfter.unresolved_tension, rBefore.unresolved_tension, '未解决张力应回滚');
  assert.equal(bankCount(), bankBefore, '情感银行不应多记流水');
  assert.equal(aftercareCount(), acBefore, '事后关怀流水不应只写一半');
});

test('P1-49 成功路径：各表一致落库', () => {
  const bankBefore = bankCount();
  const acBefore = aftercareCount();
  const r = intimacyMod.startAftercare('good');
  assert.ok(r && r.minutes > 0, '成功后应返回事后状态');
  assert.ok(intimacyMod.inAftercare(), '应进入事后关怀状态');
  assert.equal(bankCount(), bankBefore + 1, '成功应记一条银行流水');
  assert.equal(aftercareCount(), acBefore + 1, '成功应记一条事后关怀流水');
});