// 心动指数（doki）纯函数回归：单调性 / 边界 / 张力扣分 / 阶段上限
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDoki, DOKI_LEVELS } from '../src/lib/doki.ts';

const FULL = { intimacy: 100, trust: 100, emotional_balance: 100, repair_credit: 100, unresolved_tension: 0, stage: 4 };

test('doki：边界值', () => {
  const zero = computeDoki({ intimacy: 0, trust: 0, emotional_balance: -100, repair_credit: 0, unresolved_tension: 0, stage: 0 });
  assert.equal(zero.score, 0);
  assert.equal(zero.level, 1);
  assert.ok(zero.progress >= 0 && zero.progress <= 100);

  const full = computeDoki(FULL);
  assert.equal(full.score, 100);
  assert.equal(full.level, DOKI_LEVELS.length);
  assert.equal(full.title, '心安');
  assert.equal(full.stageCapped, false);
  assert.ok(full.progress > 0 && full.progress <= 100);
});

test('doki：空输入不崩（全部按 0 处理）', () => {
  const d = computeDoki({});
  assert.equal(d.level, 1);
  assert.ok(Number.isFinite(d.score));
  assert.ok(d.progress >= 0 && d.progress <= 100);
});

test('doki：单调性——数值升高，分数与等级不降（同阶段）', () => {
  const base = { stage: 4, intimacy: 0, trust: 0, emotional_balance: 0, repair_credit: 0, unresolved_tension: 0 };

  let prevScore = -1;
  let prevLevel = 0;
  for (let v = 0; v <= 100; v += 5) {
    const d = computeDoki({ ...base, intimacy: v });
    assert.ok(d.score >= prevScore, `亲密度 ${v} 时分数不应下降`);
    assert.ok(d.level >= prevLevel, `亲密度 ${v} 时等级不应下降`);
    prevScore = d.score;
    prevLevel = d.level;
  }

  for (const key of ['trust', 'repair_credit'] as const) {
    let ps = -1;
    for (let v = 0; v <= 100; v += 5) {
      const d = computeDoki({ ...base, [key]: v });
      assert.ok(d.score >= ps, `${key} ${v} 时分数不应下降`);
      ps = d.score;
    }
  }

  let pb = -1;
  for (let v = -100; v <= 100; v += 10) {
    const d = computeDoki({ ...base, emotional_balance: v });
    assert.ok(d.score >= pb, `情感余额 ${v} 时分数不应下降`);
    pb = d.score;
  }
});

test('doki：未解张力扣分（张力越高，分数越低、等级不升）', () => {
  const base = { stage: 4, intimacy: 80, trust: 80, emotional_balance: 60, repair_credit: 60 };
  const s0 = computeDoki({ ...base, unresolved_tension: 0 });
  const s50 = computeDoki({ ...base, unresolved_tension: 50 });
  const s100 = computeDoki({ ...base, unresolved_tension: 100 });
  assert.ok(s0.score > s50.score);
  assert.ok(s50.score > s100.score);
  assert.ok(s0.level >= s50.level);
  assert.match(computeDoki({ ...base, unresolved_tension: 80 }).note, /悬着|没说开/);
});

test('doki：阶段决定上限（初识期很心动也到不了高等级）', () => {
  const d0 = computeDoki({ ...FULL, stage: 0 });
  assert.ok(d0.level <= 2);
  assert.equal(d0.stageCapped, true);
  assert.equal(d0.progress, 100); // 已到当前阶段能到的心动上限
  const d4 = computeDoki({ ...FULL, stage: 4 });
  assert.ok(d4.level > d0.level);
});

test('doki：score / progress / level 始终落在合法区间', () => {
  for (const v of [0, 33, 66, 100]) {
    for (const t of [0, 50, 100]) {
      const d = computeDoki({
        intimacy: v,
        trust: v,
        emotional_balance: v - 50,
        repair_credit: v,
        unresolved_tension: t,
        stage: 2,
      });
      assert.ok(d.score >= 0 && d.score <= 100);
      assert.ok(d.progress >= 0 && d.progress <= 100);
      assert.ok(d.level >= 1 && d.level <= DOKI_LEVELS.length);
    }
  }
});