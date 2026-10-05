// 敏感项掩码回归：短 Key 全遮蔽不露尾 4 位；掩码识别收严（正常 Key 不会被误判为掩码而丢弃）
// 掩码函数是纯函数，不触库；这里仍指向独立临时库路径，确保不触碰 data/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-mask-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB;

const { maskSecret, looksLikeMask, maskSettingsForClient } = await import('../src/lib/db.ts');

after(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

test('maskSecret：空值返回空串；短 Key（≤8）整体遮蔽，不露尾 4 位', () => {
  assert.equal(maskSecret(''), '', '空值应返回空串（"未设置"由调用方判断存在性）');
  assert.equal(maskSecret(null), '');
  assert.equal(maskSecret(undefined), '');

  // ≤8 位：只回全遮蔽，绝不出现原文片段
  for (const v of ['a', '12345678']) {
    const masked = maskSecret(v);
    assert.equal(masked, '••••••', `${v} 应被整体遮蔽`);
    assert.ok(!masked.includes(v), `掩码不得包含原文：${v}`);
  }

  // >8 位：保留尾 4 位（沿用现有展示习惯）
  const long = 'sk-real-value-123456';
  const maskedLong = maskSecret(long);
  assert.equal(maskedLong, '••••••••3456');
  assert.ok(!maskedLong.includes('sk-real-value'), '不得暴露前缀明文');
});

test('looksLikeMask：只认以 ≥4 个连续圆点开头的掩码', () => {
  assert.equal(looksLikeMask('••••••••3456'), true, '8 个圆点开头的掩码应被识别');
  assert.equal(looksLikeMask('••••'), true, '恰好 4 个圆点算掩码');
  assert.equal(looksLikeMask('•••'), false, '3 个圆点不算掩码');
  // 正常 Key 即使含圆点，也不应被误判为掩码（否则 PUT 会把真 Key 丢掉）
  assert.equal(looksLikeMask('sk-abc•def'), false);
  assert.equal(looksLikeMask('abc••••'), false);
  assert.equal(looksLikeMask(''), false);
  assert.equal(looksLikeMask(123), false);
  assert.equal(looksLikeMask(null), false);
  assert.equal(looksLikeMask(undefined), false);
});

test('maskSettingsForClient：只对存在的敏感项做掩码，非敏感项原样返回', () => {
  const out = maskSettingsForClient({
    llm_api_key: 'sk-real-value-123456',
    embedding_api_key: '',
    llm_model: 'qwen',
  });
  assert.equal(out.llm_api_key, '••••••••3456');
  assert.equal(out.embedding_api_key, '', '空值保持空串，不做掩码');
  assert.equal(out.llm_model, 'qwen', '非敏感项不应改动');
});