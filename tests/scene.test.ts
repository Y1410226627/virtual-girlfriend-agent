// 场景识别回归（P1-17/18）：
// 只有"当下"（temporal=current）的句子才允许切换场景；梦境 / 回忆 / 假设 / 引用都不得改场景。
// scene.ts 不依赖数据库，可直接静态导入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectScene } from '../src/lib/scene.ts';

test('梦境句不得判为当前场景：temporal=dream、不切换场景', () => {
  const d = detectScene('我昨晚梦见你抱着我，特别开心', 'online');
  assert.equal(d.temporal, 'dream', '应识别为梦');
  assert.equal(d.scene, 'online', '梦境不应把场景切成线下');
  assert.equal(d.confidence, 0, '非当下的句子置信度应为 0');
});

test('回忆句（过去）不切换场景', () => {
  const d = detectScene('前几天你靠在我肩上，我到现在还记得', 'online');
  assert.equal(d.temporal, 'past');
  assert.equal(d.scene, 'online');
  assert.equal(d.confidence, 0);
});

test('假设句不切换场景', () => {
  const d = detectScene('如果我们现在坐在一起就好了，我就能抱抱你', 'online');
  assert.equal(d.temporal, 'hypothetical');
  assert.equal(d.scene, 'online');
  assert.equal(d.confidence, 0);
});

test('引用影视/台词不切换场景', () => {
  const d = detectScene('「你过来抱我一下」——电视剧里这句台词好苏', 'online');
  assert.equal(d.temporal, 'quoted');
  assert.equal(d.scene, 'online');
  assert.equal(d.confidence, 0);
});

test('正常的当下线下线索会被识别为 offline，置信度为合理数字', () => {
  const d = detectScene('我抱着你，靠在你肩上，别动', 'online');
  assert.equal(d.temporal, 'current');
  assert.equal(d.scene, 'offline');
  assert.ok(d.confidence > 0 && d.confidence <= 1, `置信度应在 (0,1]，实际 ${d.confidence}`);
});

test('正常的当下线上线索会被识别为 online', () => {
  const d = detectScene('你怎么不回我消息，看手机了吗', 'offline');
  assert.equal(d.temporal, 'current');
  assert.equal(d.scene, 'online');
  assert.ok(d.confidence > 0 && d.confidence <= 1, `置信度应在 (0,1]，实际 ${d.confidence}`);
});

test('线索越多置信度越高（单调）', () => {
  const one = detectScene('我抱着你', 'online');
  const many = detectScene('我抱着你，牵着你的手，靠在你肩上', 'online');
  assert.equal(one.scene, 'offline');
  assert.equal(many.scene, 'offline');
  assert.ok(many.confidence >= one.confidence, `多线索不应低于单线索：${many.confidence} vs ${one.confidence}`);
});

test('无线索时保持原场景、置信度 0', () => {
  const d = detectScene('今天天气不错', 'offline');
  assert.equal(d.scene, 'offline');
  assert.equal(d.confidence, 0);
  assert.equal(d.temporal, 'current');
});

test('纯表情包消息不改变场景', () => {
  const d = detectScene('[[sticker:hug]]', 'online');
  assert.equal(d.scene, 'online');
  assert.equal(d.confidence, 0);
});