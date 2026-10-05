// 分析管线回归：
//  - P1-03 parseBool：字符串 "false" 必须解析为 false（不再被 !! 误判成 true）
//  - P1-12 transcript 排除当前回合消息 id，避免当前回合权重被放大
//  - P0-07 应用阶段原子化：中途抛错 → 关系 / 银行 / 冲突零写入
//  - P1-01/P1-02 同轮冲突+修复：张力/修复信用只算一次、冲突能被立即结清
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-analysis-parse-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const parseMod = await import('../src/lib/analysis-parse.ts');
const relMod = await import('../src/lib/relationship.ts');
const analysisMod = await import('../src/lib/analysis.ts');

dbMod.getDb(); // 触发建库（迁移 + 种子）

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

function insertMessage(role: string, content: string): number {
  return dbMod.dbRun(
    'INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    1,
    role,
    content,
    new Date().toISOString()
  ).lastInsertRowid;
}

/* ---------------- P1-03 parseBool ---------------- */
test('P1-03 parseBool：只认 true/false/"true"/"false"/1/0，"false" 必须为 false', () => {
  const { parseBool } = parseMod;
  // 正例
  assert.equal(parseBool(true), true);
  assert.equal(parseBool('true'), true);
  assert.equal(parseBool('TRUE'), true);
  assert.equal(parseBool(' true '), true);
  assert.equal(parseBool(1), true);
  assert.equal(parseBool('1'), true);
  // 反例（核心 Bug：!!"false" === true）
  assert.equal(parseBool('false'), false);
  assert.equal(parseBool('FALSE'), false);
  assert.equal(parseBool(' false '), false);
  assert.equal(parseBool(false), false);
  assert.equal(parseBool(0), false);
  assert.equal(parseBool('0'), false);
  // 其他一切回落到默认值
  assert.equal(parseBool('yes'), false);
  assert.equal(parseBool(''), false);
  assert.equal(parseBool(null), false);
  assert.equal(parseBool(undefined), false);
  assert.equal(parseBool({}), false);
  assert.equal(parseBool([]), false);
  assert.equal(parseBool(2), false);
  assert.equal(parseBool('yes', true), true, '非法值应回落到传入的默认值');
});

test('P1-03 normalize：模型把布尔字段写成字符串 "false" 时不再被当成 true', () => {
  const result = parseMod.normalize({
    conflict_detected: 'false',
    repair_attempt: 'false',
    relationship_confirmation: 'false',
    next_relationship_talk: 'false',
  });
  assert.equal(result.conflict_detected, false);
  assert.equal(result.repair_attempt, false);
  assert.equal(result.relationship_confirmation, false);
  assert.equal(result.next_relationship_talk, false);

  const result2 = parseMod.normalize({
    conflict_detected: 'true',
    repair_attempt: 1,
    relationship_confirmation: 'true',
    next_relationship_talk: 0,
  });
  assert.equal(result2.conflict_detected, true);
  assert.equal(result2.repair_attempt, true);
  assert.equal(result2.relationship_confirmation, true);
  assert.equal(result2.next_relationship_talk, false);
});

/* ---------------- P1-12 transcript 排除当前回合 ---------------- */
test('P1-12 transcript：excludeIds 排除当前回合消息，其余调用点默认行为不变', () => {
  const m1 = insertMessage('user', '第一句');
  const a1 = insertMessage('assistant', '第一句回复');
  const m2 = insertMessage('user', '当前这句');
  const a2 = insertMessage('assistant', '当前回复');

  const withCurrent = parseMod.transcript(10);
  assert.ok(withCurrent.includes('当前这句'), '默认（不排除）应包含当前回合');

  const excluded = parseMod.transcript(10, [m2, a2]);
  assert.ok(excluded.includes('第一句'), '应保留历史消息');
  assert.ok(!excluded.includes('当前这句'), '应排除当前用户消息');
  assert.ok(!excluded.includes('当前回复'), '应排除当前回复');
  // 兼容：可选参数缺省 / 空数组时行为与老签名一致
  assert.equal(parseMod.transcript(10, []), withCurrent);
  void m1;
  void a1;
});

/* ---------------- P0-07 应用阶段原子化 ---------------- */
test('P0-07 应用阶段中途抛错：关系 / 银行 / 冲突零写入', () => {
  // 必须在本文件对 emotional_bank 的首次写入之前注入（该 SQL 尚未进入语句缓存）
  const dbi = dbMod.getDb();
  const realPrepare = dbi.prepare.bind(dbi);

  // 准备干净的起点
  dbMod.dbRun('UPDATE relationship_state SET unresolved_tension = 0, emotional_balance = 0, repair_credit = 0, conflict_state = ? WHERE user_id = ?', 'none', 1);
  const before = parseMod.snapshotForUndo();
  const conflictsBefore = Number(dbMod.dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM conflict_logs')?.c ?? 0);
  const bankBefore = Number(dbMod.dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM emotional_bank')?.c ?? 0);

  dbi.prepare = ((sql: string, options?: Parameters<typeof dbi.prepare>[1]) => {
    if (String(sql).includes('INSERT INTO emotional_bank')) {
      throw new Error('注入失败：模拟应用阶段写入失败');
    }
    return realPrepare(sql, options);
  }) as typeof dbi.prepare;

  const raw = {
    conflict_detected: true,
    conflict_type: 'major',
    relationship_delta: { unresolved_tension_delta: 0, emotional_balance_delta: 0 },
    reasoning: '注入测试',
  };
  const result = parseMod.normalize(raw);
  const outcome = {
    ok: false,
    applied: { memories: 0, personalitySignals: 0, conflict: false, repaired: false, stageChanged: false, attachmentAnalyzed: false },
  };

  assert.throws(() => {
    analysisMod.applyAnalysisResult(raw, result, {
      turn: 1,
      custom: false,
      userMessage: 'x',
      userMessageId: null,
      assistantMessageId: null,
      turnId: null,
      generationId: null,
      before,
      attShouldRun: false,
      attRaw: null,
    }, outcome);
  }, /注入失败/);

  dbi.prepare = realPrepare;

  const afterState = relMod.getRelationshipState();
  assert.equal(Number(afterState.unresolved_tension), Number(before.tension), '冲突张力必须一并回滚');
  assert.equal(Number(afterState.emotional_balance), Number(before.balance), '情感余额必须一并回滚');
  assert.equal(
    Number(dbMod.dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM conflict_logs')?.c ?? 0),
    conflictsBefore,
    '冲突日志不能只写一半'
  );
  assert.equal(
    Number(dbMod.dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM emotional_bank')?.c ?? 0),
    bankBefore,
    '银行流水不能只写一半'
  );
});

/* ---------------- P1-01 + P1-02 冲突 / 修复 ---------------- */
test('P1-01/P1-02 同轮冲突+修复：张力与修复信用各只算一次，冲突被立即结清', () => {
  dbMod.dbRun('UPDATE relationship_state SET unresolved_tension = 0, repair_credit = 0, conflict_state = ? WHERE user_id = ?', 'none', 1);
  dbMod.dbRun("DELETE FROM conflict_logs WHERE user_id = ?", 1);
  const before = parseMod.snapshotForUndo();
  assert.equal(Number(before.tension), 0);

  // 模型既报了冲突又报了修复，并额外给出张力 +10、修复信用 +5（必须被代码路径置零）
  const raw = {
    conflict_detected: true,
    conflict_type: 'major',
    repair_attempt: true,
    repair_quality: 'sincere',
    relationship_delta: { unresolved_tension_delta: 10, repair_credit_delta: 5 },
    reasoning: '你刚才让我不舒服，不过你解释完我好多了',
  };
  const result = parseMod.normalize(raw);
  const outcome = {
    ok: false,
    applied: { memories: 0, personalitySignals: 0, conflict: false, repaired: false, stageChanged: false, attachmentAnalyzed: false },
  };

  analysisMod.applyAnalysisResult(raw, result, {
    turn: 2,
    custom: false,
    userMessage: '你刚才让我不舒服，不过你解释完我好多了',
    userMessageId: null,
    assistantMessageId: null,
    turnId: null,
    generationId: null,
    before,
    attShouldRun: false,
    attRaw: null,
  }, outcome);

  assert.equal(outcome.applied.conflict, true, '应记录冲突');
  assert.equal(outcome.applied.repaired, true, '同轮也应记录修复');

  const state = relMod.getRelationshipState();
  // major 冲突 +12，sincere 修复降 80% → 12 * 0.2 = 2.4（绝不出现 12 + 10 的重复计算）
  assert.equal(Math.round(Number(state.unresolved_tension) * 10) / 10, 2.4, '冲突张力只涨一次（+12 后被修复降到 2.4）');
  // 修复信用只由 registerRepair 的 sincere +10 提供（模型的 +5 已被置零）
  assert.equal(Number(state.repair_credit), 10, '修复信用只算一次（10，而非 15）');

  const cf = dbMod.dbGet<{ status: string }>('SELECT status FROM conflict_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1', 1);
  assert.ok(cf, '应存在一条冲突记录');
  assert.equal(cf!.status, 'repaired', '同轮"先冲突后修复"应立即把冲突标记为已修复');
});