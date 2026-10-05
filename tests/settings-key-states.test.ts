// P1-43 API Key 三态：明文保存 / 空串与掩码保持不变 / 显式清除回退环境变量
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-settings-key-states-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置
process.env.LLM_API_KEY = 'sk-env-fallback-xyz'; // 供"清除后回退环境变量"断言

const dbMod = await import('../src/lib/db.ts');
const profilesMod = await import('../src/lib/profiles.ts');
const routeMod = await import('../src/app/api/settings/route.ts');

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

function jsonReq(method: string, body: unknown): Request {
  return new Request('http://test.local/api/settings', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('明文保存：真值覆盖已保存的 Key', async () => {
  profilesMod.seedProfilesIfEmpty();
  const r = await routeMod.PUT(jsonReq('PUT', { settings: { llm_api_key: 'sk-saved-12345678' } }));
  assert.equal(r.status, 200);
  assert.equal(dbMod.getSetting('llm_api_key'), 'sk-saved-12345678');
});

test('保持态：空串与掩码都不覆盖真实 Key', async () => {
  await routeMod.PUT(jsonReq('PUT', { settings: { llm_api_key: '' } }));
  assert.equal(dbMod.getSetting('llm_api_key'), 'sk-saved-12345678', '空串应保持不变');

  await routeMod.PUT(jsonReq('PUT', { settings: { llm_api_key: '••••••••5678' } }));
  assert.equal(dbMod.getSetting('llm_api_key'), 'sk-saved-12345678', '掩码应保持不变');
});

test('清除态：CLEAR_TOKEN 删除已保存的 Key → 回退环境变量，并写穿清空激活档案', async () => {
  const act = profilesMod.activeProfile();
  assert.ok(act);

  const r = await routeMod.PUT(jsonReq('PUT', { settings: { llm_api_key: '__clear__' } }));
  const j = await r.json();
  assert.deepEqual(j.cleared, ['llm_api_key'], '响应应报告被清除的键');
  assert.equal(dbMod.getSetting('llm_api_key'), '', '已保存的 Key 应被清除（空 → 回退 env）');
  assert.equal(dbMod.llmConfig().apiKey, 'sk-env-fallback-xyz', '应回退到环境变量');
  assert.equal(profilesMod.getProfile(act.id)?.api_key, '', '激活档案里的 Key 也应同步清空');
});

test('清除态：clear_keys 数组形式同样生效（向量 Key）', async () => {
  const r = await routeMod.PUT(jsonReq('PUT', { clear_keys: ['embedding_api_key'] }));
  const j = await r.json();
  assert.ok(j.cleared.includes('embedding_api_key'));
  assert.equal(dbMod.getSetting('embedding_api_key'), '');
});