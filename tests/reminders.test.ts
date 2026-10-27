// 提醒：解析 / 创建（幂等）/ 列表 / 取消 / 到期选择 / 伴侣隔离
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-rem-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const rem = await import('../src/lib/reminders.ts');
const parse = await import('../src/lib/reminder-parse.ts');
const ctx = await import('../src/lib/companion-context.ts');
dbMod.getDb(); // 触发建库与迁移（含 v18 reminders 表）

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

const NOW = new Date(2026, 9, 28, 10, 0, 0); // 本地时间 2026-10-28 10:00（周三）

test('解析：相对时间（分钟 / 小时）', () => {
  const a = parse.parseReminder('20分钟后提醒我喝水', NOW);
  assert.ok(a, '应识别相对时间');
  assert.equal(a?.content, '喝水');
  assert.equal(Math.round((a!.due.getTime() - NOW.getTime()) / 60000), 20);

  const b = parse.parseReminder('2小时后叫我收衣服', NOW);
  assert.ok(b);
  assert.equal(b?.content, '收衣服');
  assert.equal(Math.round((b!.due.getTime() - NOW.getTime()) / 60000), 120);
});

test('解析：明天早上 8 点 / 今晚 9 点半', () => {
  const a = parse.parseReminder('提醒我明天早上8点交报告', NOW);
  assert.ok(a);
  assert.equal(a?.due.getDate(), 29);
  assert.equal(a?.due.getHours(), 8);
  assert.equal(a?.due.getMinutes(), 0);
  assert.equal(a?.content, '交报告');

  const b = parse.parseReminder('今晚9点半提醒我给妈妈打电话', NOW);
  assert.ok(b);
  assert.equal(b?.due.getDate(), 28);
  assert.equal(b?.due.getHours(), 21); // 「今晚」按晚间处理
  assert.equal(b?.due.getMinutes(), 30);
  assert.equal(b?.content, '给妈妈打电话');
});

test('解析：只有日期用默认时刻；没有明确时间 → null', () => {
  const a = parse.parseReminder('明天提醒我交报告', NOW);
  assert.ok(a);
  assert.equal(a?.due.getDate(), 29);
  assert.equal(a?.due.getHours(), 9);

  assert.equal(parse.parseReminder('提醒我喝水', NOW), null);
  assert.equal(parse.parseReminder('今天好累啊', NOW), null);
  assert.equal(parse.parseReminder('0分钟后提醒我', NOW), null);
  assert.equal(parse.parseReminder('你会提醒我吗', NOW), null);
});

test('解析：周几 + 下午；"第 3 点"不算时刻', () => {
  const a = parse.parseReminder('周五下午3点提醒我开会', NOW);
  assert.ok(a);
  assert.equal(a?.due.getDay(), 5);
  assert.equal(a?.due.getHours(), 15);
  assert.ok(a!.due.getTime() > NOW.getTime());
  assert.equal(parse.parseReminder('提醒我看一下第3点建议', NOW), null);
});

test('创建幂等 + 列表 + 到期选择 + 取消', () => {
  const id1 = rem.createReminderFromMessage(101, '20分钟后提醒我喝水', NOW);
  assert.ok(id1);
  // 同一条用户消息重复提交（如网络重试）不重复创建
  assert.equal(rem.createReminderFromMessage(101, '20分钟后提醒我喝水', NOW), null);

  const list = rem.listReminders();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.content, '喝水');
  assert.equal(list[0]?.status, 'pending');

  // 到期选择：把 due 改到过去（dbRun 不做伴侣作用域注入，cRun 会自动前置 companion_id）
  dbMod.dbRun('UPDATE reminders SET due_at = ? WHERE id = ?', new Date(NOW.getTime() - 60000).toISOString(), id1);
  const due = rem.listDueReminders(NOW.toISOString());
  assert.equal(due.length, 1);

  assert.equal(rem.cancelReminder(id1!), true);
  assert.equal(rem.cancelReminder(id1!), false); // 已取消不能重复取消
  assert.equal(rem.listDueReminders(NOW.toISOString()).length, 0);
});

test('伴侣隔离：c2 的提醒 c1 看不到', () => {
  ctx.withCompanion(2, () => {
    rem.createReminderFromMessage(201, '30分钟后提醒我关火', NOW);
  });
  assert.equal(rem.listReminders().length, 0);
  assert.equal(rem.listDueReminders(new Date(NOW.getTime() + 3600_000).toISOString()).length, 0);

  const theirs = ctx.withCompanion(2, () => rem.listReminders());
  assert.equal(theirs.length, 1);

  // 清理，避免影响其它用例
  ctx.withCompanion(2, () => {
    for (const r of rem.listReminders()) rem.cancelReminder(r.id);
  });
});
