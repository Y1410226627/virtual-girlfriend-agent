// life.ts 纯逻辑回归：事件类型识别 / 预计结束时间解析 / 智能时长
// 这些是可控事件系统的核心判断，不依赖数据库（只测纯函数）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventTypeOf, parseExpectedEnd, smartDurationMinutes } from '../src/lib/life.ts';

/* ------------------------------------------------------------------ */
/* eventTypeOf：活动名 → 事件类型                                        */
/* ------------------------------------------------------------------ */

test('eventTypeOf：睡眠类', () => {
  assert.equal(eventTypeOf('我去睡睡了'), 'sleep');
  assert.equal(eventTypeOf('午休一下'), 'sleep');
  assert.equal(eventTypeOf('眯一会'), 'sleep');
  assert.equal(eventTypeOf('打盹'), 'sleep');
});

test('eventTypeOf：吃饭类（注意"做饭"应归 chore 而非 meal）', () => {
  assert.equal(eventTypeOf('我去吃饭'), 'meal');
  assert.equal(eventTypeOf('吃外卖'), 'meal');
  assert.equal(eventTypeOf('做饭'), 'chore'); // 做饭是家务
  assert.equal(eventTypeOf('洗碗'), 'chore');
});

test('eventTypeOf：洗澡/运动/游戏/社交/护肤', () => {
  assert.equal(eventTypeOf('洗澡'), 'shower');
  assert.equal(eventTypeOf('去跑步'), 'sport');
  assert.equal(eventTypeOf('打游戏'), 'game');
  assert.equal(eventTypeOf('和朋友聊天'), 'social');
  assert.equal(eventTypeOf('敷面膜'), 'care');
});

test('eventTypeOf：上课/出门/通勤/休闲', () => {
  assert.equal(eventTypeOf('上课'), 'focus');
  assert.equal(eventTypeOf('出门逛街'), 'out');
  assert.equal(eventTypeOf('通勤'), 'commute');
  assert.equal(eventTypeOf('看剧'), 'leisure');
  assert.equal(eventTypeOf('发呆'), 'leisure');
});

test('eventTypeOf：未知 → other', () => {
  assert.equal(eventTypeOf(''), 'other');
  assert.equal(eventTypeOf('不知道在干嘛'), 'other');
});

/* ------------------------------------------------------------------ */
/* parseExpectedEnd：文字 → ISO 时间                                    */
/* ------------------------------------------------------------------ */

// 固定一个"现在"时间：本地 2026-10-05 14:00（用本地组件构造，任意时区都成立）
// 注意：不要用 '...Z' 这种 UTC 字面量——那是"某个瞬间"，换时区会改变本地钟点，断言随之失效。
const FROM = new Date(2026, 9, 5, 14, 0, 0);

test('parseExpectedEnd：小时数', () => {
  const r = parseExpectedEnd('2小时', FROM);
  assert.ok(r, '应解析成功');
  // 2 小时后 = 本地 16:00
  assert.equal(new Date(r!).getHours(), 16);
});

test('parseExpectedEnd：分钟数', () => {
  const r = parseExpectedEnd('30分钟', FROM);
  assert.ok(r);
  assert.equal(new Date(r!).getMinutes(), 30);
});

test('parseExpectedEnd：半点', () => {
  const r = parseExpectedEnd('半小时', FROM);
  assert.ok(r);
  assert.equal(new Date(r!).getMinutes(), 30);
});

test('parseExpectedEnd：一个半小时', () => {
  const r = parseExpectedEnd('一个半小时', FROM);
  assert.ok(r);
  // 1.5 小时后 = 本地 15:30
  assert.equal(new Date(r!).getHours(), 15);
  assert.equal(new Date(r!).getMinutes(), 30);
});

test('parseExpectedEnd：HH:MM 格式', () => {
  const r = parseExpectedEnd('23:30', FROM);
  assert.ok(r);
  // from 是 14:00 本地，23:30 是今天 23:30
  const d = new Date(r!);
  assert.equal(d.getHours(), 23);
  assert.equal(d.getMinutes(), 30);
});

test('parseExpectedEnd：到X点', () => {
  const r = parseExpectedEnd('到7点', FROM);
  assert.ok(r);
  // from 14:00，到7点 → 次日 7:00
  const d = new Date(r!);
  assert.equal(d.getHours(), 7);
});

test('parseExpectedEnd：明早', () => {
  const r = parseExpectedEnd('明早', FROM);
  assert.ok(r);
  // from 是 10-05 14:00，明早 = 10-06 07:30
  const d = new Date(r!);
  assert.equal(d.getDate(), 6);
  assert.equal(d.getHours(), 7);
  assert.equal(d.getMinutes(), 30);
});

test('parseExpectedEnd：无法识别 → null', () => {
  assert.equal(parseExpectedEnd('', FROM), null);
  assert.equal(parseExpectedEnd('随便什么', FROM), null);
});

/* ------------------------------------------------------------------ */
/* smartDurationMinutes：智能时长                                        */
/* ------------------------------------------------------------------ */

test('smartDurationMinutes：午睡（11:30-16:30）→ 90 分钟', () => {
  const noon = new Date(2026, 9, 5, 12, 0, 0); // 本地 12:00
  assert.equal(smartDurationMinutes('sleep', '午睡', noon), 90);
});

test('smartDurationMinutes：早上回笼睡（<11:30）→ 60 分钟', () => {
  const morning = new Date(2026, 9, 5, 9, 0, 0); // 本地 09:00
  assert.equal(smartDurationMinutes('sleep', '', morning), 60);
});

test('smartDurationMinutes：晚上睡睡 → 睡到次日早上（≥180 分钟）', () => {
  const night = new Date(2026, 9, 5, 22, 0, 0); // 本地 22:00
  const mins = smartDurationMinutes('sleep', '', night);
  assert.ok(mins >= 180 && mins <= 720, `应在 180-720 之间，实际 ${mins}`);
});

test('smartDurationMinutes：吃饭 → 25/30 分钟', () => {
  assert.equal(smartDurationMinutes('meal', '早饭'), 25);
  assert.equal(smartDurationMinutes('meal', '午饭'), 30);
});

test('smartDurationMinutes：洗澡/上课/出门/通勤/家务/休闲', () => {
  assert.equal(smartDurationMinutes('shower'), 35);
  assert.equal(smartDurationMinutes('focus', '上课'), 90);
  assert.equal(smartDurationMinutes('focus', '自习'), 60);
  assert.equal(smartDurationMinutes('out'), 120);
  assert.equal(smartDurationMinutes('commute'), 35);
  assert.equal(smartDurationMinutes('chore'), 40);
  assert.equal(smartDurationMinutes('leisure'), 60);
});

test('smartDurationMinutes：未知类型 → 40 分钟', () => {
  assert.equal(smartDurationMinutes('unknown_type'), 40);
});
