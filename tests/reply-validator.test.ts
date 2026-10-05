// 回复校验层（ResponseValidator）纯函数回归
// 覆盖：答非所问被 hardFail、正常接话不误报、复读被标记、空/极短被标记。
// 纯函数、零依赖数据库与网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReply, RETRY_SCORE_THRESHOLD } from '../src/lib/reply-validator.ts';

test('明显提问却答非所问 → hardFail + question_ignored', () => {
  const r = validateReply({
    userMessage: '你喜欢什么颜色？',
    reply: '（望着窗外）今天天气不错，我们去走走吧。',
  });
  assert.equal(r.hardFail, true, '答非所问应判为 hardFail');
  assert.ok(r.issues.includes('question_ignored'), `issues 应含 question_ignored：${JSON.stringify(r.issues)}`);
  assert.ok(r.score < RETRY_SCORE_THRESHOLD, `分数应低于重答阈值，实际 ${r.score}`);
});

test('正常接话不误报（接住了问题里的内容）', () => {
  const r = validateReply({
    userMessage: '你是不是不喜欢我了？',
    reply: '怎么会不喜欢你，我只是这两天有点累。',
  });
  assert.equal(r.hardFail, false, '正常接话不应 hardFail');
  assert.ok(!r.issues.includes('question_ignored'), `不应误报 question_ignored：${JSON.stringify(r.issues)}`);
  assert.ok(r.score > RETRY_SCORE_THRESHOLD, `正常接话分数应高于阈值，实际 ${r.score}`);
});

test('复读（与最近回复高度相似）→ repetition', () => {
  const reply = '今天真的好累啊，早点休息吧。';
  const r = validateReply({
    userMessage: '今天好累',
    reply,
    recentReplies: [reply],
  });
  assert.ok(r.issues.includes('repetition'), `应标记复读：${JSON.stringify(r.issues)}`);
});

test('空回复（用户说了很多）→ too_short', () => {
  const r = validateReply({
    userMessage: '我今天在公司被领导批评了，心情特别不好，你能安慰安慰我吗？',
    reply: '   ',
  });
  assert.ok(r.issues.includes('too_short'), `应标记太短：${JSON.stringify(r.issues)}`);
  assert.ok(r.score < RETRY_SCORE_THRESHOLD, `空回复分数应低于阈值，实际 ${r.score}`);
});