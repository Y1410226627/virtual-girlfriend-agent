// 原子性回归：① 冲突登记（关系状态 + 冲突日志 + 情感银行记账）② 性格快照回滚
// 两者都必须整体成功 / 整体失败，不允许出现"写了一半"。
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-atomic-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const relMod = await import('../src/lib/relationship.ts');
const personMod = await import('../src/lib/personality.ts');
const conflictMod = await import('../src/lib/conflict.ts');
const { round1 } = await import('../src/lib/utils.ts');

dbMod.getDb(); // 触发建库（迁移 + 种子）

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

test('P1-5 冲突登记：银行记账中途失败 → 关系状态 / 冲突日志 / 银行流水一并回滚', () => {
  const dbi = dbMod.getDb();
  const realPrepare = dbi.prepare.bind(dbi);
  // 只在"写情感银行流水"时注入失败（该 SQL 此时尚未进入语句缓存）
  dbi.prepare = ((sql: string, options?: Parameters<typeof dbi.prepare>[1]) => {
    if (String(sql).includes('INSERT INTO emotional_bank')) {
      throw new Error('注入失败：模拟银行记账写入失败');
    }
    return realPrepare(sql, options);
  }) as typeof dbi.prepare;

  const before = relMod.getRelationshipState();
  const conflictsBefore = Number(dbMod.dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM conflict_logs')?.c ?? 0);
  const bankBefore = Number(dbMod.dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM emotional_bank')?.c ?? 0);

  assert.throws(() => conflictMod.registerConflict('major', '注入测试冲突'), /注入失败/);
  dbi.prepare = realPrepare;

  const after = relMod.getRelationshipState();
  const conflictsAfter = Number(dbMod.dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM conflict_logs')?.c ?? 0);
  const bankAfter = Number(dbMod.dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM emotional_bank')?.c ?? 0);

  assert.equal(conflictsAfter, conflictsBefore, '冲突日志不能只写一半');
  assert.equal(bankAfter, bankBefore, '银行流水不能只写一半');
  assert.equal(after.unresolved_tension, before.unresolved_tension, '未解决张力必须一并回滚');
  assert.equal(after.emotional_balance, before.emotional_balance, '情感余额必须一并回滚');
  assert.equal(after.conflict_state, before.conflict_state, '冲突状态必须一并回滚');
});

test('P1-5 冲突登记成功路径：状态 / 日志 / 流水 / 余额一处不差，且只记一次账', () => {
  const before = relMod.getRelationshipState();
  const conflictsBefore = Number(dbMod.dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM conflict_logs')?.c ?? 0);
  const bankBefore = Number(dbMod.dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM emotional_bank')?.c ?? 0);

  conflictMod.registerConflict('major', '一致性测试冲突');

  const after = relMod.getRelationshipState();
  const conflictsAfter = Number(dbMod.dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM conflict_logs')?.c ?? 0);
  const bankAfter = Number(dbMod.dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM emotional_bank')?.c ?? 0);

  assert.equal(conflictsAfter, conflictsBefore + 1, '应新增一条冲突记录');
  assert.equal(bankAfter, bankBefore + 1, '一次冲突只应产生一条银行流水（不得重复记账）');
  assert.equal(round1(after.unresolved_tension), round1(before.unresolved_tension + 12), '张力应上升 12');

  const last = dbMod.dbGet<{ behavior: string; delta: number; balance_after: number }>(
    'SELECT behavior, delta, balance_after FROM emotional_bank ORDER BY id DESC LIMIT 1'
  );
  assert.ok(last, '应存在一条银行流水');
  assert.equal(last!.behavior, '冲突');
  assert.equal(last!.delta, -4, '严重冲突应取款 4');
  assert.equal(last!.balance_after, after.emotional_balance, '流水余额必须与关系状态余额一致');

  const cf = dbMod.dbGet<{ status: string; tension_at_start: number }>(
    'SELECT status, tension_at_start FROM conflict_logs ORDER BY id DESC LIMIT 1'
  );
  assert.ok(cf, '应存在一条冲突记录');
  assert.equal(cf!.status, 'open');
  assert.equal(cf!.tension_at_start, round1(before.unresolved_tension), '冲突记录的起始张力应为发生前的值');
});

test('P1-6 性格回滚：第 3 个维度写入失败 → 已回滚的维度整体撤销（不留半份）', () => {
  // 快照存"50"，随后把前两个维度改成 88：若回滚只跑了一半（无事务），前两个维度会停在 50（可观测）
  personMod.manualAdjust('warmth', 50, '测试准备');
  personMod.manualAdjust('playfulness', 50, '测试准备');
  personMod.saveWeeklySnapshot();
  const snap = dbMod.dbGet<{ id: number }>('SELECT id FROM personality_snapshots ORDER BY id DESC LIMIT 1');
  assert.ok(snap, '应存在一条快照');

  personMod.manualAdjust('warmth', 88, '测试改动');
  personMod.manualAdjust('playfulness', 88, '测试改动');
  const before = personMod.personalityMap();
  assert.equal(before.warmth, 88);
  assert.equal(before.playfulness, 88);

  const dbi = dbMod.getDb();
  const realPrepare = dbi.prepare.bind(dbi);
  // 让"回滚循环里的 UPDATE personality_state SET solidified"这条语句在第 3 次执行时抛错
  dbi.prepare = ((sql: string, options?: Parameters<typeof dbi.prepare>[1]) => {
    const stmt = realPrepare(sql, options);
    if (String(sql).includes('UPDATE personality_state SET solidified')) {
      let calls = 0;
      let fired = false;
      const origRun = stmt.run.bind(stmt) as (...a: unknown[]) => { changes: number; lastInsertRowid: number };
      (stmt as unknown as { run: (...a: unknown[]) => unknown }).run = (...a: unknown[]) => {
        calls++;
        if (calls === 3 && !fired) {
          fired = true;
          throw new Error('注入失败：回滚到第 3 个维度时失败');
        }
        return origRun(...a);
      };
    }
    return stmt;
  }) as typeof dbi.prepare;

  assert.throws(() => personMod.rollbackToSnapshot(snap!.id), /注入失败/);
  dbi.prepare = realPrepare;

  const after = personMod.personalityMap();
  assert.deepEqual(after, before, '回滚中途失败必须整体撤销，不能留下"一半维度已回滚"');
});

test('P1-6 快照回滚成功路径：全部维度恢复 + 固化状态 / 计时被重置', () => {
  personMod.manualAdjust('warmth', 50, '测试准备');
  personMod.manualAdjust('playfulness', 50, '测试准备');
  personMod.saveWeeklySnapshot();
  const snap = dbMod.dbGet<{ id: number; values_json: string }>(
    'SELECT id, values_json FROM personality_snapshots ORDER BY id DESC LIMIT 1'
  );
  assert.ok(snap, '应存在一条快照');
  const baseline = JSON.parse(snap!.values_json) as Record<string, number>;

  // 制造"回滚前"的脏状态：值改变 + 挂了半固化与计时
  personMod.manualAdjust('warmth', 90, '测试改动');
  dbMod.dbRun(
    'UPDATE personality_state SET solidified = 1, last_adjusted_turn = 7 WHERE user_id = ? AND dimension = ?',
    dbMod.DEFAULT_USER_ID,
    'warmth'
  );
  dbMod.setCounter('solidify_streak_warmth', 5);

  assert.equal(personMod.rollbackToSnapshot(snap!.id), true);

  const map = personMod.personalityMap();
  for (const [dim, v] of Object.entries(baseline)) {
    assert.equal(map[dim], v, `${dim} 应回滚到快照值 ${v}`);
  }
  const warmRow = personMod.getPersonalityRows().find((r) => r.dimension === 'warmth');
  assert.equal(Number(warmRow?.solidified), 0, '回滚应重置固化状态');
  assert.equal(Number(warmRow?.last_adjusted_turn), 0, '回滚应重置变化速率计时');
  assert.equal(dbMod.getCounter('solidify_streak_warmth'), 0, '回滚应重置固化计时');
});