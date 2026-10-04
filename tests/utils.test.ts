// 纯工具函数回归（核心路径：数值钳制 / 时间兜底 / LLM 输出稳健解析）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, localDateStr, hoursSince, parseJsonLoose, safeJson, truncate, cosine, hashString } from '../src/lib/utils.ts';

test('clamp：正常值 / 边界 / NaN / Infinity', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(clamp(NaN, 0, 10), 0, 'NaN 应回落到 min');
  assert.equal(clamp(Infinity, 0, 10), 10);
  assert.equal(clamp(-Infinity, 0, 10), 0);
});

test('localDateStr：本地时区 YYYY-MM-DD', () => {
  assert.match(localDateStr(new Date(2026, 0, 5)), /^2026-01-05$/);
  assert.match(localDateStr(new Date(2026, 11, 31)), /^2026-12-31$/);
});

test('hoursSince：脏数据与空值 → 999', () => {
  assert.equal(hoursSince(null), 999);
  assert.equal(hoursSince(undefined), 999);
  assert.equal(hoursSince('不是时间'), 999);
  const h = hoursSince(new Date(Date.now() - 2 * 3600000).toISOString());
  assert.ok(Math.abs(h - 2) < 0.1, `期望约 2 小时，实际 ${h}`);
});

test('parseJsonLoose：代码块 / 双大括号 / 尾逗号 / 截断补齐', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('{{"a":1}}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('{"a":1,}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('{"a":[1,2'), { a: [1, 2] }, '被截断的 JSON 应补全括号');
  assert.equal(parseJsonLoose('纯文本没有对象'), null);
  assert.equal(parseJsonLoose(''), null);
});

test('safeJson / truncate / cosine / hashString', () => {
  assert.deepEqual(safeJson('{"x":1}', {}), { x: 1 });
  assert.deepEqual(safeJson('坏 json', { y: 2 }), { y: 2 });
  assert.equal(truncate('abcdef', 3), 'abc…');
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('', 5), '');
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1], [1, 2]), 0, '维度不一致应返回 0');
  const h1 = hashString('hello');
  assert.equal(h1, hashString('hello'), '同一输入应稳定');
  assert.ok(h1 >= 0 && h1 < 1);
});