// 人味层核心行为回归（核心路径：她的话在落库前一定会经过 humanizeReply）
// 覆盖历史修复过的高风险行为：睡着后不开口、AI 腔过滤、JSON 残留、替用户发言、超长截断等
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeReply } from '../src/lib/humanize.ts';

/** 统一的测试上下文（确定性输入，不依赖真实网络与数据库） */
const ctx = {
  userName: '测试猫',
  agentName: '小雅',
  stage: 3,
  personality: { warmth: 50, playfulness: 50, romance: 50, directness: 50, independence: 50, emotional_intensity: 50 },
  attachmentStyle: 'secure',
  mood: '平静',
  recentActions: [] as string[],
  recentReplies: [] as string[],
  userMessage: '晚安',
  scene: 'online' as const,
};

test('睡着后不再说话：只剩"睡过去"的动作时不补台词', () => {
  const r = humanizeReply('（把脸埋进枕头，彻底陷入梦乡）', ctx);
  assert.ok(!r.text.includes('我在呢'), `不该补台词，实际：${r.text}`);
  assert.ok(
    r.notes.some((n) => n.includes('不补台词')),
    `notes 应记录不补台词：${JSON.stringify(r.notes)}`
  );
});

test('睡着后不再说话：动作之后的台词被删掉', () => {
  const r = humanizeReply('（沉沉睡去）晚安，明天见。', ctx);
  assert.ok(!r.text.includes('晚安，明天见'), `睡着后的台词应被删除，实际：${r.text}`);
  assert.ok(
    r.notes.some((n) => n.includes('删掉后面的台词')),
    `notes 应记录删台词：${JSON.stringify(r.notes)}`
  );
});

test('正常回复保留内容', () => {
  const r = humanizeReply('（睫毛垂下去）今天真的好累呀。', ctx);
  assert.ok(r.text.includes('今天真的好累呀'), `内容应保留，实际：${r.text}`);
});

test('AI 腔整句删除、其余保留', () => {
  const r = humanizeReply('我是一个AI助手，很高兴见到你。\n（眼睛亮了一下）今天过得怎么样呀？', ctx);
  assert.ok(!/AI/.test(r.text), `AI 腔应被删除，实际：${r.text}`);
  assert.ok(r.text.includes('今天过得怎么样呀'), `正常内容应保留，实际：${r.text}`);
});

test('JSON 残留被删、表情包 token 不误删', () => {
  const r1 = humanizeReply('{"memory_updates": [], "reasoning": "x"}\n（歪头）你在说什么？', ctx);
  assert.ok(!r1.text.includes('memory_updates'), `JSON 残留应删除，实际：${r1.text}`);
  const r2 = humanizeReply('（眼睛亮了一下）好呀！\n[[sticker:hug]]', ctx);
  assert.ok(r2.text.includes('[[sticker:hug]]'), `表情包 token 应保留，实际：${r2.text}`);
});

test('替用户说话被截断', () => {
  const r = humanizeReply('（叹气）唉。\n测试猫：我今天不想说话', ctx);
  assert.ok(!r.text.includes('测试猫：'), `替用户发言应被截掉，实际：${r.text}`);
});

test('半角括号动作统一为全角', () => {
  const r = humanizeReply('(眨了眨眼) 好呀。', ctx);
  assert.ok(r.text.includes('（眨了眨眼）'), `应统一为全角括号，实际：${r.text}`);
});

test('超长文本在完整句末截断', () => {
  const long = '（托着下巴）' + '今天发生了一件小事呀。'.repeat(100);
  const r = humanizeReply(long, ctx);
  assert.ok(r.text.length < long.length, `应被截断：${r.text.length}/${long.length}`);
  assert.ok(r.text.endsWith('。'), `应在句末截断，结尾：${r.text.slice(-8)}`);
  assert.ok(
    r.notes.some((n) => n.includes('长度整形')),
    `notes 应记录长度整形：${JSON.stringify(r.notes)}`
  );
});

test('完全空输出走兜底台词', () => {
  const r = humanizeReply('   ', ctx);
  assert.ok(r.text.trim().length > 0, '兜底台词不应为空');
  assert.equal(r.fallback, true, '应标记为兜底');
});