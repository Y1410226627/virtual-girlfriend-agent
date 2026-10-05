// 「她懂得分寸」回应率回归：
// - 纯函数 computeProactiveResponseRate（样本未成熟不计 / 全回 / 全不回 / 混合）；
// - 纯函数 adjustedGapHours / adjustedDailyBudget / shouldAddGentleContext（低率收敛、高率恢复、边界）；
// - 集成：构造 proactive + 后续 user 消息（12h 内/外）→ 样本、rate 与 counters 更新正确；
// - 仪式 / 纪念日不受温柔收敛影响（豁免分支）。
// 隐私：使用独立临时库（os.tmpdir），绝不触碰 data/ 下的真实数据。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { ProactiveState } from '../src/lib/proactive.ts';

const DB = path.join(os.tmpdir(), `gf-test-proactive-response-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const p = await import('../src/lib/proactive.ts');

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

const UID = dbMod.DEFAULT_USER_ID;

function approx(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) < eps, `期望约 ${expected}，实际 ${actual}`);
}

/* ------------------------------------------------------------------ */
/* 纯函数：computeProactiveResponseRate                                 */
/* ------------------------------------------------------------------ */
test('computeProactiveResponseRate：样本未成熟（未满 12h 且未回）不计入', () => {
  const r = p.computeProactiveResponseRate([{ proactiveId: 1, repliedWithinHours: null, sentHoursAgo: 2 }]);
  assert.deepEqual(r, { rate: 0, samples: 0, answered: 0 });

  // 已回=结论明确，即使发出还不到 12 小时也计入
  const r2 = p.computeProactiveResponseRate([{ proactiveId: 2, repliedWithinHours: 1, sentHoursAgo: 2 }]);
  assert.deepEqual(r2, { rate: 1, samples: 1, answered: 1 });
});

test('computeProactiveResponseRate：全回 → rate 1', () => {
  const r = p.computeProactiveResponseRate([
    { proactiveId: 1, repliedWithinHours: 1 },
    { proactiveId: 2, repliedWithinHours: 2 },
    { proactiveId: 3, repliedWithinHours: 3 },
  ]);
  assert.deepEqual(r, { rate: 1, samples: 3, answered: 3 });
});

test('computeProactiveResponseRate：全不回（已过窗口）→ rate 0', () => {
  const r = p.computeProactiveResponseRate([
    { proactiveId: 1, repliedWithinHours: null, sentHoursAgo: 20 },
    { proactiveId: 2, repliedWithinHours: null, sentHoursAgo: 30 },
    { proactiveId: 3, repliedWithinHours: null, sentHoursAgo: 40 },
  ]);
  assert.deepEqual(r, { rate: 0, samples: 3, answered: 0 });
});

test('computeProactiveResponseRate：混合（含超窗回复与未成熟样本）', () => {
  const r = p.computeProactiveResponseRate([
    { proactiveId: 1, repliedWithinHours: 2 }, // 已回 → answered
    { proactiveId: 2, repliedWithinHours: null, sentHoursAgo: 20 }, // 已过窗口未回 → 样本未答
    { proactiveId: 3, repliedWithinHours: 15 }, // 回复超过 12h → 不算 answered，但仍是样本
    { proactiveId: 4, repliedWithinHours: null, sentHoursAgo: 1 }, // 未成熟 → 不计样本
  ]);
  assert.equal(r.samples, 3);
  assert.equal(r.answered, 1);
  approx(r.rate, 1 / 3);
});

/* ------------------------------------------------------------------ */
/* 纯函数：adjustedGapHours / adjustedDailyBudget / shouldAddGentleContext */
/* ------------------------------------------------------------------ */
test('adjustedGapHours：样本不足 / 高率 / 中性边界 → 维持配置值', () => {
  assert.equal(p.adjustedGapHours(6, 0.1, 2), 6, '样本不足时中性');
  assert.equal(p.adjustedGapHours(6, 0.2, 3), 9, '低率 → 放宽 1.5 倍');
  assert.equal(p.adjustedGapHours(6, 0.3, 3), 6, '0.3 边界属中性');
  assert.equal(p.adjustedGapHours(6, 0.5, 3), 6, '0.3~0.6 中性');
  assert.equal(p.adjustedGapHours(6, 0.8, 3), 6, '高率 → 恢复正常');
});

test('adjustedDailyBudget：低率 -1（下限 1）、关闭态不反向开启', () => {
  assert.equal(p.adjustedDailyBudget(2, 0.2, 4), 1, '低率 → 额度 -1');
  assert.equal(p.adjustedDailyBudget(1, 0.2, 4), 1, '下限 1，绝不因低率完全停发');
  assert.equal(p.adjustedDailyBudget(0, 0.2, 4), 0, '主动消息已关闭时不反向开启');
  assert.equal(p.adjustedDailyBudget(3, 0.8, 4), 3, '高率 → 正常');
  assert.equal(p.adjustedDailyBudget(2, 0.1, 2), 2, '样本不足 → 中性');
});

test('shouldAddGentleContext：仅低率且样本足够时加轻语境', () => {
  assert.equal(p.shouldAddGentleContext(0.2, 4), true);
  assert.equal(p.shouldAddGentleContext(0.2, 2), false, '样本不足不加');
  assert.equal(p.shouldAddGentleContext(0.3, 4), false, '中性不加');
  assert.equal(p.shouldAddGentleContext(0.7, 4), false, '高率不加');
});

/* ------------------------------------------------------------------ */
/* 仪式 / 纪念日豁免                                                    */
/* ------------------------------------------------------------------ */
const DEFAULTS: ProactiveState = {
  now: new Date('2026-10-06T14:00:00'),
  force: false,
  stage: 3,
  unresolvedTension: 0,
  pendingStageConfirm: false,
  pendingRelationshipTalk: false,
  missingUser: 0,
  loneliness: 0,
  hasLastInteraction: true,
  hoursSinceLastMessage: 12,
  hoursSinceLastProactive: 24,
  todayCount: 0,
  perDay: 2,
  baseMinGapHours: 6,
  unanswered: 0,
  frequencyOff: false,
  dnd: false,
  quiet: false,
  offline: false,
  offlineRecent: false,
  busy: false,
  ritualSlot: null,
  eventToday: false,
  random: 0.9,
};

function state(over: Partial<ProactiveState> = {}): ProactiveState {
  return { ...DEFAULTS, ...over };
}

test('纪念日（event）不受温柔收敛影响：间隔不放大、额度不扣减', () => {
  const converged = state({
    eventToday: true,
    gapScale: 1.5,
    budgetPenalty: 1,
    perDay: 2,
    todayCount: 1,
    hoursSinceLastProactive: 7,
    baseMinGapHours: 6,
  });
  // 普通类型被放大后的间隔挡住（6h * 1.5 = 9h > 7h）
  assert.equal(p.evaluateProactiveKind('greeting', converged).eligible, false, '普通类型应受收敛影响');
  // 纪念日照常：间隔用 6h，额度用满 2
  assert.equal(p.evaluateProactiveKind('event', converged).eligible, true, '纪念日必须照常');

  // 对照：中性（无收敛字段）时普通类型是可以通过的
  const neutral = state({
    eventToday: true,
    perDay: 2,
    todayCount: 1,
    hoursSinceLastProactive: 7,
    baseMinGapHours: 6,
  });
  assert.equal(p.evaluateProactiveKind('greeting', neutral).eligible, true, '中性时普通类型可发');
});

test('仪式（ritual）不受温柔收敛影响：仍绕过每日额度与最小间隔', () => {
  const converged = state({
    ritualSlot: 'morning',
    gapScale: 1.5,
    budgetPenalty: 1,
    perDay: 2,
    todayCount: 5,
    hoursSinceLastProactive: 0.5,
  });
  assert.equal(p.evaluateProactiveKind('ritual', converged).eligible, true, '仪式必须照常');
});

/* ------------------------------------------------------------------ */
/* 集成：构造 proactive + 后续 user 消息 → 样本 / rate / counters       */
/* ------------------------------------------------------------------ */
test('集成：12h 内/外的回复 → compute/refresh 与 counters 更新正确', () => {
  const now = new Date('2026-10-06T12:00:00.000Z');
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3600000);

  const addProactive = (kind: string, when: Date): void => {
    dbMod.dbRun(
      'INSERT INTO proactive_messages (user_id, kind, content, message_id, created_at) VALUES (?, ?, ?, ?, ?)',
      UID,
      kind,
      'test',
      null,
      when.toISOString()
    );
  };
  const addUserMsg = (when: Date): void => {
    dbMod.dbRun(
      "INSERT INTO messages (user_id, role, content, created_at) VALUES (?, 'user', ?, ?)",
      UID,
      'test',
      when.toISOString()
    );
  };

  // pA：24h 前发出，20h 前回（4h，窗口内）→ answered
  addProactive('greeting', at(24));
  addUserMsg(at(20));
  // pC：48h 前发出，回复在 30h 前（18h，超出 12h 窗口）→ 未答
  addProactive('miss', at(48));
  addUserMsg(at(30));
  // pB / pE：老消息，无回复 → 未答
  addProactive('greeting', at(72));
  addProactive('memory', at(100));
  // pD：6h 前发出、未满 12h 且无回复 → 未成熟，不计样本
  addProactive('greeting', at(6));

  const samples = p.loadProactiveResponseSamples(10, now);
  assert.equal(samples.length, 5, '应取到最近 5 条主动消息');

  // 直接交给纯函数：5 条里 pD（未满 12h 且未回）被判定为未成熟而剔除 → 4 样本、1 已回
  const mature = p.computeProactiveResponseRate(samples);
  assert.equal(mature.samples, 4);
  assert.equal(mature.answered, 1);
  approx(mature.rate, 0.25);

  // 未成熟样本存在（sentHoursAgo < 12 且未回）
  const immature = samples.filter((s) => (s.sentHoursAgo ?? 0) < 12);
  assert.equal(immature.length, 1);
  assert.equal(immature[0]!.repliedWithinHours, null);

  // 首次 refresh：无历史 counter → 直接取本次
  const first = p.refreshProactiveResponseRate(10, now);
  approx(first.rate, 0.25);
  assert.equal(first.samples, 4);
  assert.equal(first.answered, 1);
  approx(dbMod.getCounter('proactive_response_rate'), 0.25, 1e-9);

  // 指数平滑：旧值 0.5 * 0.6 + 本次 0.25 * 0.4 = 0.4
  dbMod.setCounter('proactive_response_rate', 0.5);
  const second = p.refreshProactiveResponseRate(10, now);
  approx(second.rate, 0.4, 1e-9);
  approx(dbMod.getCounter('proactive_response_rate'), 0.4, 1e-9);

  // 低率 → 收敛参数可用（与纯函数一致）
  assert.equal(p.shouldAddGentleContext(second.rate, second.samples), false, '平滑后 0.4 已回升到中性');
  assert.equal(p.adjustedGapHours(6, 0.25, 4), 9);
  assert.equal(p.adjustedDailyBudget(2, 0.25, 4), 1);
});