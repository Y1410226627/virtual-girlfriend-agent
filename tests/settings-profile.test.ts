// P1-42 双事实源 / P1-58 test_profile 404：高级设置写穿激活档案 + 档案不存在返回 404
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-settings-profile-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const profilesMod = await import('../src/lib/profiles.ts');
const llmCore = await import('../src/lib/llm-core.ts');
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

test('P1-42：保存高级设置（llm_model）写穿到激活档案，两边一致', async () => {
  profilesMod.seedProfilesIfEmpty();
  const act = profilesMod.activeProfile();
  assert.ok(act, '首次播种后应存在激活档案');

  const r = await routeMod.PUT(jsonReq('PUT', { settings: { llm_model: 'synced-model-x' } }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.syncedProfile, act.id, '响应应带 syncedProfile');
  assert.ok(j.changed.includes('llm_model'));
  assert.equal(dbMod.getSetting('llm_model'), 'synced-model-x', 'settings 应更新');
  assert.equal(profilesMod.getProfile(act.id)?.chat_model, 'synced-model-x', '档案应同步更新');

  // targetsFor 优先用档案 → 不应再出现"改了 A 却调用 B"
  const t = llmCore.targetsFor('chat')[0];
  assert.ok(t);
  assert.equal(t.model, 'synced-model-x', '实际调用链应使用同步后的模型');
});

test('P1-42：保存 base_url 也写穿档案（改地址立即生效）', async () => {
  profilesMod.seedProfilesIfEmpty();
  const act = profilesMod.activeProfile();
  assert.ok(act);

  const r = await routeMod.PUT(jsonReq('PUT', { settings: { llm_base_url: 'http://10.9.9.9:8000/v1' } }));
  const j = await r.json();
  assert.equal(j.syncedProfile, act.id);
  assert.equal(profilesMod.getProfile(act.id)?.base_url, 'http://10.9.9.9:8000/v1');
  assert.equal(llmCore.targetsFor('chat')[0]?.baseUrl, 'http://10.9.9.9:8000/v1');
});

test('P1-42：无激活档案时保持原行为（syncedProfile 为 null，仅改 settings）', async () => {
  // 把所有档案取消默认 → activeProfile() 为 null
  dbMod.dbRun('UPDATE model_profiles SET is_default = 0');
  assert.equal(profilesMod.activeProfile(), null);

  const r = await routeMod.PUT(jsonReq('PUT', { settings: { llm_model: 'no-profile-model' } }));
  const j = await r.json();
  assert.equal(j.syncedProfile, null, '无激活档案时不应同步');
  assert.equal(dbMod.getSetting('llm_model'), 'no-profile-model');
});

test('P1-58：test_profile 传了 id 但档案不存在 → 404（不退化测当前配置）', async () => {
  const r = await routeMod.POST(jsonReq('POST', { action: 'test_profile', id: 999999 }));
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.ok(j.error, '应返回错误信息');
});

test('P1-58：非法地址（无 id）仍返回 400（原有校验不回退）', async () => {
  const r = await routeMod.POST(jsonReq('POST', { action: 'test_profile', base_url: 'ftp://x/v1' }));
  assert.equal(r.status, 400);
});