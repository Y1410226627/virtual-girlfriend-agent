// 关系引擎 + 情感银行核心路径回归
// 覆盖：applyRelationshipDelta 增减与钳制 / saveRelationshipState 读写往返 / 情感银行"账实一致"
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { clamp } from '../src/lib/utils.ts';

const DB = path.join(os.tmpdir(), `gf-test-relationship-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const relMod = await import('../src/lib/relationship.ts');
const bankMod = await import('../src/lib/emotionalBank.ts');

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

test('applyRelationshipDelta：trust 增减并钳制在 0-100', () => {
  relMod.saveRelationshipState({ ...relMod.getRelationshipState(), trust: 50 });
  assert.equal(relMod.applyRelationshipDelta({ trust: 30 }, '测试').trust, 80, '应正常累加');
  assert.equal(relMod.applyRelationshipDelta({ trust: 1000 }, '测试').trust, 100, '上限应钳到 100');
  assert.equal(relMod.applyRelationshipDelta({ trust: -1000 }, '测试').trust, 0, '下限应钳到 0');
});

test('applyRelationshipDelta：intimacy 受阶段区间约束（阶段 0 为 0-20）', () => {
  relMod.saveRelationshipState({ ...relMod.getRelationshipState(), stage: 0, intimacy: 10 });
  assert.equal(relMod.applyRelationshipDelta({ intimacy: 5 }, '测试').intimacy, 15);
  assert.equal(relMod.applyRelationshipDelta({ intimacy: 1000 }, '测试').intimacy, 20, '不应越过阶段上限');
  assert.equal(relMod.applyRelationshipDelta({ intimacy: -1000 }, '测试').intimacy, 0, '不应低于阶段下限');
});

test('saveRelationshipState：写入后读回一致（往返）', () => {
  const s = relMod.getRelationshipState();
  s.mood = '开心';
  s.nickname = '小猫';
  s.streak_days = 7;
  s.stage = 2;
  s.intimacy = 55;
  relMod.saveRelationshipState(s);

  const r = relMod.getRelationshipState();
  assert.equal(r.mood, '开心');
  assert.equal(r.nickname, '小猫');
  assert.equal(r.streak_days, 7);
  assert.equal(r.stage, 2);
  assert.equal(r.intimacy, 55);
});

test('addBankEntry：余额变化与流水记录一致（账实一致）', () => {
  const before = relMod.getRelationshipState().emotional_balance;

  const b1 = bankMod.addBankEntry(30, '贴心回复', '测试存款');
  assert.equal(b1, clamp(before + 30, -100, 100), '返回余额应为存款后余额');
  assert.equal(relMod.getRelationshipState().emotional_balance, b1, '关系表余额应同步更新');

  let latest = bankMod.listBankEntries(1)[0]!;
  assert.equal(latest.delta, 30);
  assert.equal(latest.kind, 'deposit');
  assert.equal(latest.balance_after, b1, '流水 balance_after 应与实际余额一致');

  const b2 = bankMod.addBankEntry(-10, '冷淡回复', '测试取款');
  assert.equal(b2, clamp(b1 - 10, -100, 100), '返回余额应为取款后余额');
  latest = bankMod.listBankEntries(1)[0]!;
  assert.equal(latest.delta, -10);
  assert.equal(latest.kind, 'withdrawal');
  assert.equal(latest.balance_after, b2, '流水 balance_after 应与实际余额一致');

  // 账实一致：本用例内余额只由 addBankEntry 改动，流水 delta 之和应等于当前余额
  const sum = dbMod.dbAll<{ s: number }>(
    'SELECT COALESCE(SUM(delta), 0) AS s FROM emotional_bank'
  )[0]!.s;
  assert.ok(
    Math.abs(sum - b2) < 1e-6,
    `流水 delta 之和 ${sum} 应等于当前余额 ${b2}`
  );
});