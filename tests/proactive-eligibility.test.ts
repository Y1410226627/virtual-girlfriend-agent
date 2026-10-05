// 主动消息资格判定回归（P1-46 / P1-44）：
// - 纯逻辑：给定状态与时间 → 各类型独立条件与最小间隔 → 择优结果；
// - 全局约束（开关/免打扰/安静时段/初识期/线下/忙碌/未回复）不被破坏；
// - pickWhyNowMemories 与当下线索相关的记忆排前。
// 隐私：使用独立临时库（os.tmpdir），绝不触碰 data/ 下的真实数据（纯函数本身不读库）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { ProactiveState } from '../src/lib/proactive.ts';

const DB = path.join(os.tmpdir(), `gf-test-proactive-${process.pid}-${Date.now()}.db`);
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

test('聊天间隔不足：greeting/memory 都不满足 → 不主动', () => {
  const d = p.decideProactiveKind(state({ hoursSinceLastMessage: 2 }));
  assert.equal(d.kind, null);
  assert.equal(d.byKind.greeting.eligible, false);
  assert.equal(d.byKind.memory.eligible, false);
});

test('各类型独立最小间隔：relationship_talk 需 24h，miss 只需 12h', () => {
  const st = state({
    unresolvedTension: 60,
    pendingRelationshipTalk: true,
    missingUser: 80,
    hoursSinceLastProactive: 15,
    hoursSinceLastMessage: 12,
  });
  const d = p.decideProactiveKind(st);
  assert.equal(d.byKind.relationship_talk.eligible, false, '15 小时不满足关系谈话的 24 小时间隔');
  assert.equal(d.byKind.miss.eligible, true, '15 小时满足想念类的 12 小时间隔');
  assert.equal(d.kind, 'miss', '关系谈话被间隔挡住时应退到想念类');
});

test('stage_confirm 命中且间隔足够 → 优先级最高', () => {
  const d = p.decideProactiveKind(state({ pendingStageConfirm: true, hoursSinceLastProactive: 100 }));
  assert.equal(d.byKind.stage_confirm.eligible, true);
  assert.equal(d.kind, 'stage_confirm');
});

test('特殊日子当天：event 优先，且各类聊天间隔放宽到 3 小时', () => {
  const ok = p.decideProactiveKind(state({ eventToday: true, hoursSinceLastMessage: 4, random: 0.9 }));
  assert.equal(ok.byKind.event.eligible, true);
  assert.equal(ok.kind, 'event');

  const tooSoon = p.decideProactiveKind(state({ eventToday: true, hoursSinceLastMessage: 2, random: 0.9 }));
  assert.equal(tooSoon.byKind.event.eligible, false, '2 小时不满足放宽后的 3 小时门槛');
  assert.equal(tooSoon.kind, null);
});

test('仪式：不受每日额度与最小间隔限制', () => {
  const d = p.decideProactiveKind(
    state({ ritualSlot: 'morning', todayCount: 5, perDay: 2, hoursSinceLastProactive: 0.5, random: 0.9 })
  );
  assert.equal(d.byKind.ritual.eligible, true, '仪式应绕过每日额度与最小间隔');
  assert.equal(d.kind, 'ritual');
});

test('仪式：当天有特殊日子或待确认关系时不抢占', () => {
  const d = p.decideProactiveKind(state({ ritualSlot: 'morning', eventToday: true, random: 0.9 }));
  assert.equal(d.byKind.ritual.eligible, false, '特殊日子当天仪式不参与');
  assert.equal(d.kind, 'event');
});

test('全局约束：开关/免打扰/安静时段/初识期/未聊过/线下/忙碌/未回复 都会挡住', () => {
  assert.equal(p.decideProactiveKind(state({ frequencyOff: true })).kind, null);
  assert.equal(p.decideProactiveKind(state({ dnd: true })).kind, null);
  assert.equal(p.decideProactiveKind(state({ quiet: true })).kind, null);
  assert.equal(p.decideProactiveKind(state({ stage: 0 })).kind, null);
  assert.equal(p.decideProactiveKind(state({ hasLastInteraction: false })).kind, null);
  assert.equal(p.decideProactiveKind(state({ offline: true, offlineRecent: true })).kind, null);
  assert.equal(p.decideProactiveKind(state({ busy: true })).kind, null);
  assert.equal(p.decideProactiveKind(state({ unanswered: 2 })).kind, null);
  // 线下但已过去很久（offlineRecent=false）→ 不挡
  assert.ok(p.decideProactiveKind(state({ offline: true, offlineRecent: false })).kind !== null);
});

test('force：跳过间隔/额度/静默，但不主动选仪式', () => {
  const d = p.decideProactiveKind(
    state({
      force: true,
      ritualSlot: 'morning',
      hoursSinceLastMessage: 0.5,
      todayCount: 99,
      perDay: 0,
      quiet: true,
      dnd: true,
      frequencyOff: true,
    })
  );
  assert.equal(d.byKind.ritual.eligible, false, '手动触发时不选仪式');
  assert.equal(d.kind, 'greeting');
});

test('pickWhyNowMemories：与当下线索相关的记忆排前，无线索时保持原顺序', () => {
  const mems = [
    { content: '他喜欢喝冰美式咖啡' },
    { content: '他报名了下个月的马拉松训练' },
    { content: '他最近在学做菜' },
  ];
  const ranked = p.pickWhyNowMemories(mems, ['马拉松训练'], 3);
  assert.ok(ranked[0]!.content.includes('马拉松'), `相关记忆应排第一：${ranked.map((m) => m.content)}`);

  const unchanged = p.pickWhyNowMemories(mems, [], 3);
  assert.deepEqual(
    unchanged.map((m) => m.content),
    mems.map((m) => m.content),
    '无线索时应回退原顺序'
  );
});