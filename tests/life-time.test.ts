// 生活模拟回归：历史回放时间 / 生病门限 / 事件结束边界 / 事件池过滤 / 身份模板 / Life Arc 失败重试
// 隐私：使用独立临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-lifetime-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const lifeMod = await import('../src/lib/life.ts');

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

function resetLifeState(): void {
  dbMod.dbRun('DELETE FROM ongoing_events WHERE user_id = ?', dbMod.DEFAULT_USER_ID);
  dbMod.dbRun("UPDATE agent_health SET illness = 'none', illness_severity = 0 WHERE user_id = ?", dbMod.DEFAULT_USER_ID);
  dbMod.dbRun('DELETE FROM agent_daily_events WHERE user_id = ?', dbMod.DEFAULT_USER_ID);
  dbMod.dbRun('DELETE FROM life_state_logs WHERE user_id = ?', dbMod.DEFAULT_USER_ID);
}

/* ------------------------------------------------------------------ */
/* P1-29：生活事件池前置条件（硬约束过滤 + 权重）                         */
/* ------------------------------------------------------------------ */

test('P1-29 事件池：按身份/地点/健康做硬约束过滤', () => {
  const base = { hour: 10, activityType: 'class', locationType: 'school', illness: 'none' };
  const elig = lifeMod.eligibleEvents(base);
  // 只在 out 地点发生的"橘猫"不应在教室出现；只在 class 的"上课差点睡着"应出现
  assert.ok(!elig.some((e) => e.content.includes('橘猫')), 'out-only 事件不应出现在 school');
  assert.ok(elig.some((e) => e.content.includes('上课差点睡着')), 'class-only 事件应出现');

  // 睡觉时不会有任何日常小事
  assert.equal(lifeMod.eligibleEvents({ ...base, activityType: 'sleep' }).length, 0);

  // 生病时过滤户外类事件（whenIll=false）
  const ill = lifeMod.eligibleEvents({ hour: 15, activityType: 'out', locationType: 'out', illness: '感冒' });
  assert.ok(ill.length > 0, '生病时仍应有居家/室内事件');
  assert.ok(!ill.some((e) => e.content.includes('橘猫')), '生病时不应外出看猫');
  assert.ok(!ill.some((e) => e.content.includes('下雨没带伞')), '生病时不应淋雨');
});

test('P1-29 事件池：pickEvent 只返回候选集合内的条目，且 roll 确定', () => {
  const ctx = { hour: 12, activityType: 'study', locationType: 'school', illness: 'none' };
  const elig = lifeMod.eligibleEvents(ctx);
  const p1 = lifeMod.pickEvent(ctx, 0.5);
  const p2 = lifeMod.pickEvent(ctx, 0.5);
  assert.ok(p1 && elig.includes(p1), '抽中的事件必须在候选集合内');
  assert.equal(p1, p2, '同一 roll 结果确定（回放一致）');
  assert.equal(lifeMod.pickEvent({ hour: 3, activityType: 'sleep', locationType: 'home', illness: 'none' }, 0.5), null);
});

/* ------------------------------------------------------------------ */
/* P1-30：身份模板推导 + 作息分支                                         */
/* ------------------------------------------------------------------ */

test('P1-30 身份模板：从 occupation 自由文本识别', () => {
  assert.equal(lifeMod.lifeTemplate('在读研究生，喜欢摄影和猫'), 'graduate');
  assert.equal(lifeMod.lifeTemplate('硕士在读'), 'graduate');
  assert.equal(lifeMod.lifeTemplate(''), 'student');
  assert.equal(lifeMod.lifeTemplate(null), 'student');
  assert.equal(lifeMod.lifeTemplate('大一新生'), 'student');
  assert.equal(lifeMod.lifeTemplate('在互联网公司上班'), 'worker');
  assert.equal(lifeMod.lifeTemplate('实习生'), 'intern');
  assert.equal(lifeMod.lifeTemplate('自由职业，接单画画'), 'freelancer');
});

test('P1-30 作息模板：研究生不再出现"上课/教室/教学楼"', () => {
  const grad = JSON.stringify(lifeMod.scheduleOf('graduate').weekday);
  assert.ok(!grad.includes('上课'), '研究生作息不应含"上课"');
  assert.ok(!grad.includes('教室'), '研究生作息不应含"教室"');
  assert.ok(!grad.includes('教学楼'), '研究生作息不应含"教学楼"');
  assert.ok(grad.includes('实验') || grad.includes('文献'), '研究生作息应命中实验室/文献分支');

  // 默认 student 保持旧行为（含"上课"），保证向后兼容
  const stu = JSON.stringify(lifeMod.scheduleOf('student').weekday);
  assert.ok(stu.includes('上课'));

  // 上班族作息也不应含学生语义
  const work = JSON.stringify(lifeMod.scheduleOf('worker').weekday);
  assert.ok(!work.includes('上课') && !work.includes('教学楼') && work.includes('上班'));
});

test('P1-30 currentLifeTemplate 读取 personas.occupation', () => {
  lifeMod.ensureLife();
  dbMod.dbRun('UPDATE personas SET occupation = ? WHERE user_id = ?', '在读研究生，喜欢摄影和猫', dbMod.DEFAULT_USER_ID);
  assert.equal(lifeMod.currentLifeTemplate(), 'graduate');
  dbMod.dbRun('UPDATE personas SET occupation = ? WHERE user_id = ?', '', dbMod.DEFAULT_USER_ID);
  assert.equal(lifeMod.currentLifeTemplate(), 'student');
});

/* ------------------------------------------------------------------ */
/* P1-28：生病不可重复触发 + 冷却                                        */
/* ------------------------------------------------------------------ */

test('P1-28 生病门限：在病中 / 冷却期不触发，超期可触发；startIllness 记录时间戳', () => {
  lifeMod.ensureLife();
  const now = Date.now();
  dbMod.setCounter('illness_last_at', 0);
  assert.equal(lifeMod.illnessTriggerAllowed({ illness: 'none' }, now), true);
  assert.equal(lifeMod.illnessTriggerAllowed({ illness: '感冒' }, now), false, '正在生病不能再触发');

  dbMod.setCounter('illness_last_at', now - 86400000);
  assert.equal(lifeMod.illnessTriggerAllowed({ illness: 'none' }, now), false, '1 天内应处于冷却');

  dbMod.setCounter('illness_last_at', now - 8 * 86400000);
  assert.equal(lifeMod.illnessTriggerAllowed({ illness: 'none' }, now), true, '超过 7 天可再次触发');

  // startIllness 会把发病时间写入冷却计数
  dbMod.setCounter('illness_last_at', 0);
  const at = new Date(now - 3600000).toISOString();
  lifeMod.startIllness('感冒', 2, at);
  assert.equal(dbMod.getCounter('illness_last_at'), new Date(at).getTime());
  assert.equal(lifeMod.illnessTriggerAllowed({ illness: 'none' }, now), false, '刚发病应立即进入冷却');
});

/* ------------------------------------------------------------------ */
/* P1-25：历史回放的日志时间                                            */
/* ------------------------------------------------------------------ */

test('P1-25 离线回放 3 天：生活日志按各模拟日落到对应日期，而不是全落"今天"', () => {
  lifeMod.ensureLife();
  resetLifeState();
  dbMod.dbRun(
    'UPDATE agent_health SET updated_at = ? WHERE user_id = ?',
    new Date(Date.now() - 72 * 3600000).toISOString(),
    dbMod.DEFAULT_USER_ID
  );
  lifeMod.advanceLife();
  lifeMod.advanceLife(); // 单次最多 48h，分两次补满 72h

  const dates = dbMod
    .dbAll<{ d: string }>(
      "SELECT DISTINCT date(created_at, 'localtime') AS d FROM life_state_logs WHERE user_id = ? AND field = 'activity' ORDER BY d",
      dbMod.DEFAULT_USER_ID
    )
    .map((r) => r.d);
  assert.ok(dates.length >= 3, `回放 3 天应产生至少 3 个自然日的活动日志，实际 ${JSON.stringify(dates)}`);
});

/* ------------------------------------------------------------------ */
/* P1-27：进行中事件的结束边界                                          */
/* ------------------------------------------------------------------ */

test('P1-27 过期事件不再覆盖后续时段（22:00-23:00 事件回放跨到次日）', () => {
  lifeMod.ensureLife();
  resetLifeState();

  const startMs = Date.now() - 26 * 3600000;
  const start = new Date(startMs);
  const end = new Date(startMs + 3600000); // 只持续 1 小时
  dbMod.dbRun(
    'INSERT INTO ongoing_events (user_id, activity, event_type, started_at, expected_end_at, duration_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    dbMod.DEFAULT_USER_ID, '看电影', 'leisure', start.toISOString(), end.toISOString(), 'manual', start.toISOString(), start.toISOString()
  );
  dbMod.dbRun(
    'UPDATE agent_health SET updated_at = ? WHERE user_id = ?',
    new Date(startMs - 30 * 60000).toISOString(),
    dbMod.DEFAULT_USER_ID
  );

  lifeMod.advanceLife();

  // 事件早已过期 → 作息表应接管，而不是一直停在"看电影"
  assert.notEqual(lifeMod.getActivity().current_activity, '看电影', '过期事件不应继续作为"当前事件"');
});

/* ------------------------------------------------------------------ */
/* P1-26：生病开始时间可指定                                            */
/* ------------------------------------------------------------------ */

test('P1-26 startIllness 支持历史 startedAt；默认取当前时间', () => {
  lifeMod.ensureLife();
  resetLifeState();
  const iso = new Date(Date.now() - 5 * 86400000).toISOString();
  lifeMod.startIllness('感冒', 2, iso);
  assert.equal(lifeMod.getHealth().illness_start, iso, '应使用传入的历史发病时间');

  lifeMod.startIllness('感冒', 2);
  const nowStart = lifeMod.getHealth().illness_start;
  assert.ok(nowStart, '默认不发时间戳也应写入当前时间');
  assert.ok(Math.abs(new Date(nowStart!).getTime() - Date.now()) < 5000, '默认为当前时间');
});

/* ------------------------------------------------------------------ */
/* P1-32：Life Arc 生成失败不推进 last_gen                              */
/* ------------------------------------------------------------------ */

test('P1-32 生成失败：不推进 last_gen，写 retry_after', async () => {
  lifeMod.ensureLife();
  dbMod.dbRun('DELETE FROM life_arcs WHERE user_id = ?', dbMod.DEFAULT_USER_ID);
  const fourDaysAgo = Date.now() - 4 * 86400000;
  dbMod.setCounter('life_arc_last_gen', fourDaysAgo);
  dbMod.setCounter('life_arc_check_at', 0);
  dbMod.setCounter('life_arc_retry_after', 0);

  await lifeMod.tickLifeArc();

  assert.equal(dbMod.getCounter('life_arc_last_gen'), fourDaysAgo, '失败不应推进 last_gen');
  assert.ok(dbMod.getCounter('life_arc_retry_after') > Date.now(), '失败应写入将来时间点用于重试');
});