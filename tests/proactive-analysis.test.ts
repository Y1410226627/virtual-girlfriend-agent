// 主动消息的"自我暴露"落库回归（P1-45 · 纯落库部分，不测网络抽取）
// 覆盖：自述/未来意图 → 关系记忆（importance 6 + source_message_id）、
//       plan/promise → 共享计划/仪式、life_event → 日常事件、字段缺失安全。
// 隐私：使用独立临时库（os.tmpdir），绝不触碰 data/ 下的真实数据。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-proactive-analysis-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const memMod = await import('../src/lib/memory.ts');
const lifeMod = await import('../src/lib/life.ts');
const paMod = await import('../src/lib/proactive-analysis.ts');

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

test('自述 / 未来意图 → 关系类长期记忆（importance 6，source_message_id 指回消息）', async () => {
  await paMod.applyAgentOriginExtraction(12345, {
    self_disclosure: '她最近在学做饭',
    future_intention: '她打算下个月去海边旅行',
  });

  const all = memMod.listMemories();
  const self = all.find((m) => m.content === '她最近在学做饭');
  assert.ok(self, '自述应写入长期记忆');
  assert.equal(self!.type, 'relationship', '应为关系类记忆');
  assert.equal(self!.importance, 6, '重要度应为 6');
  assert.equal(self!.source_message_id, 12345, '应指回这条主动消息');
  assert.equal(self!.status, 'active');

  const intent = all.find((m) => m.content === '她打算下个月去海边旅行');
  assert.ok(intent, '未来意图应写入长期记忆');
  assert.equal(intent!.type, 'relationship');
});

test('plan / promise → 共享计划 / 共享仪式', async () => {
  // 生产路径里 proactive 发送前一定先 ensureLife()（它才会创建 shared_world 行）；这里对齐同样的前置。
  lifeMod.ensureLife();
  await paMod.applyAgentOriginExtraction(2, {
    plan: '周末一起去看电影',
    promise: '每晚睡前互相说晚安',
  });

  const w = lifeMod.getSharedWorld();
  assert.ok(
    w.plans.some((p) => String(p.content || '') === '周末一起去看电影'),
    '共同计划应写入 shared_world.plans'
  );
  assert.ok(
    w.rituals.some((r) => String(r.content || '') === '每晚睡前互相说晚安'),
    '承诺应写入 shared_world.rituals'
  );
});

test('life_event → 日常事件', async () => {
  await paMod.applyAgentOriginExtraction(3, {
    life_event: { type: '心情', content: '她今天被朋友夸了很开心' },
  });

  const events = lifeMod.listDailyEvents(20);
  assert.ok(
    events.some((e) => e.content === '她今天被朋友夸了很开心'),
    '生活事件应写入 agent_daily_events'
  );
});

test('字段缺失 / 空白安全：不抛错、不写入空记忆', async () => {
  await paMod.applyAgentOriginExtraction(4, {});
  await paMod.applyAgentOriginExtraction(5, {
    self_disclosure: '   ',
    plan: '',
    promise: '',
    life_event: {},
  });
  const all = memMod.listMemories();
  assert.ok(
    !all.some((m) => m.content.trim() === ''),
    '不应写入空白记忆'
  );
});