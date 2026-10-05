// 关系阶段数据回归（阶段区间连续、取值钳制）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, stageOf } from '../src/lib/stages.ts';

test('STAGES：5 个阶段、区间连续无缝、覆盖 0-100', () => {
  assert.equal(STAGES.length, 5);
  assert.equal(STAGES[0]!.min, 0);
  assert.equal(STAGES[STAGES.length - 1]!.max, 100);
  for (let i = 0; i < STAGES.length; i++) {
    assert.equal(STAGES[i]!.id, i, 'id 应与序号一致');
    if (i > 0) assert.equal(STAGES[i]!.min, STAGES[i - 1]!.max, '相邻阶段区间应无缝衔接');
  }
});

test('stageOf：按 id 取阶段，越界钳制、小数取整', () => {
  assert.equal(stageOf(0).id, 0);
  assert.equal(stageOf(4).id, 4);
  assert.equal(stageOf(2.4).id, 2);
  assert.equal(stageOf(2.6).id, 3);
  assert.equal(stageOf(-5).id, 0, '负数应钳到第一阶段');
  assert.equal(stageOf(99).id, 4, '超界应钳到最后一个阶段');
});