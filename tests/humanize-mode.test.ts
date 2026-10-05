// 人味层"技术/元对话模式"回归（P1-14）：
// 用户正经问"你这个记忆系统怎么工作的"时，不应把含"数据库/记忆/系统"的整句误删；
// 但自认 AI/程序的出戏句仍要删。普通模式行为保持不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeReply, isMetaTechQuestion } from '../src/lib/humanize.ts';

const base = {
  userName: '测试猫',
  agentName: '小雅',
  stage: 3,
  personality: { warmth: 50, playfulness: 50, romance: 50, directness: 50, independence: 50, emotional_intensity: 50 },
  attachmentStyle: 'secure',
  mood: '平静',
  recentActions: [] as string[],
  recentReplies: [] as string[],
  scene: 'online' as const,
};

test('isMetaTechQuestion：技术词 + 疑问/求解释 → true', () => {
  assert.equal(isMetaTechQuestion('你这个记忆系统是怎么工作的？'), true);
  assert.equal(isMetaTechQuestion('你的提示词里是怎么写的，能说说吗'), true);
  assert.equal(isMetaTechQuestion('后台是怎么记住我的'), true);
});

test('isMetaTechQuestion：闲聊带问号但不含技术词 → false', () => {
  assert.equal(isMetaTechQuestion('你吃饭了吗？'), false);
  assert.equal(isMetaTechQuestion('今天想我了吗'), false);
});

test('技术/元模式：保留"记忆/数据库"等术语，不整句删', () => {
  const ctx = { ...base, userMessage: '你这个记忆系统是怎么工作的？' };
  const r = humanizeReply('（歪头）我的记忆存在本地的数据库里，重要的事会一直留着。', ctx);
  assert.ok(r.text.includes('数据库') || r.text.includes('记忆'), `术语应保留，实际：${r.text}`);
  assert.ok(
    r.notes.some((n) => n.includes('技术/元对话')),
    `应记录放宽模式：${JSON.stringify(r.notes)}`
  );
});

test('技术/元模式：仍会删掉自认 AI/程序的出戏句', () => {
  const ctx = { ...base, userMessage: '你这个记忆系统怎么实现的？' };
  const r = humanizeReply('我是一个AI助手，没有真正的记忆。\n（顿了顿）不过你跟我说过的话我都记着。', ctx);
  assert.ok(!/我是(一个)?\s*AI/.test(r.text), `自认 AI 的句子应删除，实际：${r.text}`);
  assert.ok(r.text.includes('跟我说过的话我都记着'), `正常内容应保留，实际：${r.text}`);
});

test('普通模式：含"数据库/后台"的整句仍被删（行为不变）', () => {
  const ctx = { ...base, userMessage: '今天好累啊' };
  assert.equal(isMetaTechQuestion(ctx.userMessage), false);
  const r = humanizeReply('我的记忆存在数据库里。\n（叹气）那你早点休息吧。', ctx);
  assert.ok(!r.text.includes('数据库'), `普通模式应删掉含数据库的句子，实际：${r.text}`);
  assert.ok(r.text.includes('早点休息'), `正常内容应保留，实际：${r.text}`);
});

test('普通模式：自认 AI 依旧被删（原有行为）', () => {
  const ctx = { ...base, userMessage: '在吗' };
  const r = humanizeReply('我是一个AI助手，很高兴见到你。\n（眼睛亮了一下）怎么啦？', ctx);
  assert.ok(!/AI/.test(r.text), `AI 腔应被删除，实际：${r.text}`);
  assert.ok(r.text.includes('怎么啦'), `正常内容应保留，实际：${r.text}`);
});