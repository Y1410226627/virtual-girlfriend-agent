// 触摸互动纯逻辑回归：分层文案 / 冷却判定 / 每日上限 / 随机源注入
// 纯函数，无数据库依赖
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERACTIONS,
  INTERACTION_LINES,
  isInteractionKind,
  interactionTier,
  pickInteractionReply,
  cooldownRemainingMs,
  shouldApplyPokeEffect,
  PER_KIND_COOLDOWN_MS,
  GLOBAL_COOLDOWN_MS,
  POKE_DAILY_CAP,
} from '../src/lib/interactions.ts';

test('interactions：kind 校验', () => {
  assert.equal(isInteractionKind('pat'), true);
  assert.equal(isInteractionKind('hug'), true);
  assert.equal(isInteractionKind('kiss'), false);
  assert.equal(isInteractionKind(undefined), false);
});

test('interactions：阶段分层——阶段 0 只给"有距离感"的回应', () => {
  assert.equal(interactionTier(0), 0);
  assert.equal(interactionTier(1), 1);
  assert.equal(interactionTier(4), 2);

  for (const def of INTERACTIONS) {
    const { early, mid, close } = INTERACTION_LINES[def.kind];
    // 三档互不重叠
    for (const l of early) {
      assert.ok(!mid.includes(l), `${def.kind} early 不应出现在 mid`);
      assert.ok(!close.includes(l), `${def.kind} early 不应出现在 close`);
    }
    // 阶段 0：无论什么心情 / 场景 / 依恋 / 刚互动过，都必须落在 early 档（不进入亲密档）
    const contexts = [
      { stage: 0 },
      { stage: 0, mood: '低落', scene: 'offline', attachmentStyle: 'anxious', lastInteractionAt: 1000, nowMs: 1500 },
    ];
    for (const ctx of contexts) {
      for (const r of [0, 0.3, 0.7, 0.999999]) {
        const out = pickInteractionReply(def.kind, ctx, () => r);
        assert.ok(early.includes(out.text), `${def.kind} 阶段0 rand=${r} 应落在 early 档：${out.text}`);
      }
    }
  }
});

test('interactions：随机源可注入（同一 rand 结果确定）', () => {
  const early = INTERACTION_LINES.pat.early;
  assert.equal(pickInteractionReply('pat', { stage: 0 }, () => 0).text, early[0]);
  assert.equal(pickInteractionReply('pat', { stage: 0 }, () => 0.999999).text, early[early.length - 1]);
});

test('interactions：心情 / 场景 / 依恋会扩展口吻池（stage≥1）', () => {
  const mid = INTERACTION_LINES.hug.mid;
  const out = pickInteractionReply(
    'hug',
    { stage: 2, mood: '低落', scene: 'offline', attachmentStyle: 'anxious', lastInteractionAt: 1000, nowMs: 1200 },
    () => 0.999999
  );
  assert.ok(!mid.includes(out.text), `扩展池文案不应落在 mid 基档：${out.text}`);
});

test('interactions：效果说明是一句很轻的话（孤独高时更贴"想念"）', () => {
  const a = pickInteractionReply('pat', { stage: 2, psychology: { loneliness: 70 } }, () => 0);
  assert.match(a.effectNote, /想念/);
  const b = pickInteractionReply('pat', { stage: 2 }, () => 0);
  assert.ok(b.effectNote.length > 0);
});

test('interactions：冷却判定（同动作 90s、全部 20s，取较长者）', () => {
  const now = 5_000_000;
  assert.equal(cooldownRemainingMs(now, 0, 0), 0);
  // 距全部互动 10s → 还剩 10s
  assert.equal(cooldownRemainingMs(now, now - 10_000, 0), GLOBAL_COOLDOWN_MS - 10_000);
  // 距同动作 30s → 还剩 60s
  assert.equal(cooldownRemainingMs(now, 0, now - 30_000), PER_KIND_COOLDOWN_MS - 30_000);
  // 全部冷却已过、动作冷却仍在 → 取动作
  assert.equal(cooldownRemainingMs(now, now - 25_000, now - 30_000), PER_KIND_COOLDOWN_MS - 30_000);
  // 都刚好到点 → 可用
  assert.equal(cooldownRemainingMs(now, now - GLOBAL_COOLDOWN_MS, now - PER_KIND_COOLDOWN_MS), 0);
});

test('interactions：每日上限与自定义模式（超过只回文案）', () => {
  assert.equal(shouldApplyPokeEffect(0, false), true);
  assert.equal(shouldApplyPokeEffect(POKE_DAILY_CAP - 1, false), true);
  assert.equal(shouldApplyPokeEffect(POKE_DAILY_CAP, false), false);
  assert.equal(shouldApplyPokeEffect(99, false), false);
  assert.equal(shouldApplyPokeEffect(0, true), false); // 自定义模式冻结数值
});