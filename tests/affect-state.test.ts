// P1-16 此刻情绪（ad-hoc affect）回归：与长期指标分家、带时效。
//  - normalizeAffect：数值 clamp、字符串限长、confidence/primary 门槛
//  - 写入 → 读取（含 clamp）→ 过期即忽略
//  - 回复 prompt 的【此刻情绪】块：有数据时包含、过期/无数据时不包含
// 隐私：使用独立临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-affect-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const relMod = await import('../src/lib/relationship.ts');
const parseMod = await import('../src/lib/analysis-parse.ts');
const promptsMod = await import('../src/lib/prompts.ts');

dbMod.getDb();

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

test('P1-16 normalizeAffect：数值 clamp、字符串限长、阈值门槛', () => {
  const a = parseMod.normalizeAffect({
    primary: '  开心  ',
    valence: 5,
    arousal: -3,
    cause: 'x'.repeat(100),
    confidence: 0.9,
    ttl_hours: 999,
  });
  assert.ok(a, 'confidence≥0.3 且 primary 非空 → 应返回');
  assert.equal(a!.primary, '开心', 'primary 应 trim 且 ≤8 字');
  assert.equal(a!.valence, 1, 'valence 应 clamp 到 1');
  assert.equal(a!.arousal, 0, 'arousal 应 clamp 到 0');
  assert.equal(a!.cause.length, 40, 'cause 应限长 40 字');

  assert.equal(parseMod.normalizeAffect({ primary: '开心', confidence: 0.1 }), null, 'confidence<0.3 应丢弃');
  assert.equal(parseMod.normalizeAffect({ primary: '   ', confidence: 1 }), null, 'primary 为空应丢弃');
  assert.equal(parseMod.normalizeAffect(undefined), null, '缺省应返回 null');
});

test('P1-16 写入 → 读取：越界值在读取时被 clamp', () => {
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  relMod.saveAffectState({ primary: '开心', valence: 2, arousal: -1, cause: '他记得我的喜好', confidence: 0.8, expiresAt });

  const got = relMod.getAffectState();
  assert.ok(got, '未过期应能读到');
  assert.equal(got!.primary, '开心');
  assert.equal(got!.valence, 1, 'valence 读取时 clamp 到 1');
  assert.equal(got!.arousal, 0, 'arousal 读取时 clamp 到 0');
  assert.equal(got!.cause, '他记得我的喜好');
});

test('P1-16 过期即忽略（getAffectState 返回 null）', () => {
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  relMod.saveAffectState({ primary: '低落', valence: -0.5, arousal: 0.2, cause: '', confidence: 0.9, expiresAt });

  assert.equal(relMod.getAffectState(), null, '已过期 → null');
  // 确定性验证：把 now 传成过期之后即可稳定判过期
  assert.equal(relMod.getAffectState(new Date(expiresAt).getTime() + 1), null);
});

test('P1-16 回复 prompt：【此刻情绪】块有数据时包含', () => {
  const expiresAt = new Date(Date.now() + 2 * 3600000).toISOString();
  relMod.saveAffectState({ primary: '雀跃', valence: 0.8, arousal: 0.7, cause: '他今天对我特别好', confidence: 0.9, expiresAt });

  const block = promptsMod.affectPromptBlock('平静');
  assert.ok(block.includes('你此刻的情绪主要是「雀跃」'), '应包含此刻情绪');
  assert.ok(block.includes('他今天对我特别好'), '应包含原因');
  assert.ok(block.includes('只是背景') && block.includes('不是此刻情绪'), '应说明长期数值只是背景');
  assert.ok(!block.includes('此刻没有独立于长期状态的情绪'), '有数据时不应显示"无情绪"回退文案');
});

test('P1-16 回复 prompt：【此刻情绪】块过期/无数据时不包含', () => {
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  relMod.saveAffectState({ primary: '雀跃', valence: 0.8, arousal: 0.7, cause: '过期了', confidence: 0.9, expiresAt });

  const block = promptsMod.affectPromptBlock('平静');
  assert.ok(!block.includes('你此刻的情绪主要是「'), '过期 → 不应包含此刻情绪');
  assert.ok(block.includes('此刻没有独立于长期状态的情绪'), '过期 → 回退到长期 mood 描述');
});