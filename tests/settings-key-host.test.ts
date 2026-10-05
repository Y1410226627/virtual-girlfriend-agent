// P0-13 URL 与凭据分离：保存的 Key 只发给"它被保存时所属的 host"
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-settings-key-host-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置
process.env.LLM_API_KEY = 'sk-env-xyz'; // env 兜底 Key

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

test('guardKeyByHost：匹配放行 / 不匹配回退 env / 无绑定放行', () => {
  let r = llmCore.guardKeyByHost({
    savedKey: 'sk-a',
    savedHost: 'a.com',
    targetUrl: 'https://a.com/v1',
    envKey: 'sk-env',
  });
  assert.deepEqual(r, { apiKey: 'sk-a', dropped: false }, 'host 一致 → 发送保存的 Key');

  r = llmCore.guardKeyByHost({
    savedKey: 'sk-a',
    savedHost: 'a.com',
    targetUrl: 'https://b.com/v1',
    envKey: 'sk-env',
  });
  assert.deepEqual(r, { apiKey: 'sk-env', dropped: true }, 'host 不一致 → 回退 env Key');

  r = llmCore.guardKeyByHost({ savedKey: 'sk-a', savedHost: '', targetUrl: 'https://b.com/v1' });
  assert.equal(r.dropped, false, '未记录归属 host → 保守放行');
  assert.equal(r.apiKey, 'sk-a');
});

test('组装：URL 改了、Key 没重输 → 不把旧 Key 发往新 host', async () => {
  profilesMod.seedProfilesIfEmpty();
  const act = profilesMod.activeProfile();
  assert.ok(act);
  // 激活档案：host a.com + Key sk-aaa（一起保存 → 记录归属 host a.com）
  profilesMod.upsertProfile({ id: act.id, label: 'T', base_url: 'http://a.com/v1', chat_model: 'm1', api_key: 'sk-aaa' });
  assert.equal(profilesMod.keyHostFor('llm'), 'a.com', '保存档案时应记录 Key 归属 host');

  let t = llmCore.targetsFor('chat')[0];
  assert.ok(t);
  assert.equal(t.baseUrl, 'http://a.com/v1');
  assert.equal(t.apiKey, 'sk-aaa', 'host 匹配时发送保存的 Key');

  // 只改 URL（不带 Key）→ 写穿档案 base_url，但 Key 归属 host 仍是 a.com
  await routeMod.PUT(jsonReq('PUT', { settings: { llm_base_url: 'http://b.com/v1' } }));
  t = llmCore.targetsFor('chat')[0];
  assert.ok(t);
  assert.equal(t.baseUrl, 'http://b.com/v1', '新 URL 应立即生效');
  assert.equal(t.apiKey, 'sk-env-xyz', 'host 不匹配时绝不发送旧 Key，回退 env');
});

test('组装：同一次请求提交 URL + Key → 视为用户意图，更新绑定', async () => {
  await routeMod.PUT(
    jsonReq('PUT', { settings: { llm_base_url: 'http://b.com/v1', llm_api_key: 'sk-new-9999' } })
  );
  assert.equal(profilesMod.keyHostFor('llm'), 'b.com', '同时提交 URL 与 Key → 更新绑定 host');
  const t = llmCore.targetsFor('chat')[0];
  assert.ok(t);
  assert.equal(t.baseUrl, 'http://b.com/v1');
  assert.equal(t.apiKey, 'sk-new-9999', '绑定更新后应发送新 Key');
});