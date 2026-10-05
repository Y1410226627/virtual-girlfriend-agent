// 设置页回归：敏感 Key 掩码/空串保护、自定义数值空值不归零、测试连接目标构造与校验
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-settings-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const relMod = await import('../src/lib/relationship.ts');
const personMod = await import('../src/lib/personality.ts');
const intMod = await import('../src/lib/intimacy.ts');
const profilesMod = await import('../src/lib/profiles.ts');
const routeMod = await import('../src/app/api/settings/route.ts');
const sharedMod = await import('../src/components/settings/shared.ts');

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

test('PUT settings：空串 / 掩码都不覆盖真实 Key，只有真值才覆盖（防不可逆丢失）', async () => {
  dbMod.setSetting('llm_api_key', 'sk-real-value-123456');

  // 空串（用户清空输入框）→ 不修改
  let r = await routeMod.PUT(jsonReq('PUT', { settings: { llm_api_key: '' } }));
  assert.equal(r.status, 200);
  assert.equal(dbMod.getSetting('llm_api_key'), 'sk-real-value-123456', '空串不应覆盖真实 Key');

  // 掩码值 → 不修改
  r = await routeMod.PUT(jsonReq('PUT', { settings: { llm_api_key: '••••••••3456' } }));
  assert.equal(r.status, 200);
  assert.equal(dbMod.getSetting('llm_api_key'), 'sk-real-value-123456', '掩码不应覆盖真实 Key');

  // 真值 → 覆盖
  r = await routeMod.PUT(jsonReq('PUT', { settings: { llm_api_key: 'sk-new-value-9000' } }));
  assert.equal(r.status, 200);
  assert.equal(dbMod.getSetting('llm_api_key'), 'sk-new-value-9000', '真值应正常覆盖');
});

test('custom_values：空串 / 缺字段保持原值，不下沉为 0', async () => {
  dbMod.setSetting('custom_mode', '1'); // 自定义模式需开启
  const rel0 = { ...relMod.getRelationshipState(), intimacy: 60, trust: 70 };
  relMod.saveRelationshipState(rel0);
  personMod.manualAdjust('warmth', 80, '测试准备');

  // 空串 / 纯空白 → 保持原值
  let r = await routeMod.POST(
    jsonReq('POST', { action: 'custom_values', values: { intimacy: '', trust: '   ' } })
  );
  assert.equal(r.status, 200);
  let rel = relMod.getRelationshipState();
  assert.equal(rel.intimacy, 60, '空串不应把亲密度归零');
  assert.equal(rel.trust, 70, '空白不应把信任归零');

  // 性格空串保持原值，另给的值生效
  r = await routeMod.POST(
    jsonReq('POST', {
      action: 'custom_values',
      values: { personality: { warmth: '', playfulness: '55' } },
    })
  );
  assert.equal(r.status, 200);
  const rows = personMod.getPersonalityRows();
  assert.equal(rows.find((x) => x.dimension === 'warmth')?.value, 80, '性格空串不应归零');
  assert.equal(rows.find((x) => x.dimension === 'playfulness')?.value, 55, '有效值应写入');

  // 正常数字仍可写入
  r = await routeMod.POST(jsonReq('POST', { action: 'custom_values', values: { intimacy: '42' } }));
  assert.equal(r.status, 200);
  rel = relMod.getRelationshipState();
  assert.equal(rel.intimacy, 42);

  // 性参数：先写入 40，再用空串清空 → 保持 40，不归零
  await routeMod.POST(jsonReq('POST', { action: 'custom_values', values: { libido: '40' } }));
  assert.equal(intMod.getIntimacy().libido, 40);
  await routeMod.POST(jsonReq('POST', { action: 'custom_values', values: { libido: '', intimacy_need: '' } }));
  assert.equal(intMod.getIntimacy().libido, 40, '空串不应把性欲归零');
});

test('test_profile：缺少协议 / 非法 URL → 400', async () => {
  const cases: Record<string, unknown>[] = [
    { action: 'test_profile', base_url: '10.0.0.10/v1' }, // 无协议
    { action: 'test_profile', base_url: 'ftp://10.0.0.1/v1' }, // 协议不符
    { action: 'test_profile', base_url: 'http://' }, // 无法解析
  ];
  for (const body of cases) {
    const r = await routeMod.POST(jsonReq('POST', body));
    assert.equal(r.status, 400, `应 400：${JSON.stringify(body)}`);
  }
});

test('resolveTestTarget：自定地址不带 Key 时不回落保存的 Key；未给地址时才回落', () => {
  const fallback = { baseUrl: 'http://10.0.0.10/v1', apiKey: 'sk-server-secret', model: 'server-model' };

  // 自定 base_url、无 api_key → 不允许回落真实 Key
  let res = profilesMod.resolveTestTarget(
    { baseUrl: 'http://1.2.3.4:8000/v1/', model: 'user-model' },
    fallback
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.target.apiKey, '', '自定地址且无 Key 时必须传空串，绝不能回落服务端 Key');
    assert.equal(res.target.baseUrl, 'http://1.2.3.4:8000/v1', '应去掉尾斜杠');
    assert.equal(res.target.model, 'user-model');
  }

  // 自定 base_url + 自带 Key → 用自带 Key
  res = profilesMod.resolveTestTarget({ baseUrl: 'http://1.2.3.4/v1', apiKey: 'sk-user' }, fallback);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.target.apiKey, 'sk-user');

  // 未给 base_url（测试当前配置）→ 允许回落
  res = profilesMod.resolveTestTarget({}, fallback);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.target.baseUrl, 'http://10.0.0.10/v1');
    assert.equal(res.target.apiKey, 'sk-server-secret');
    assert.equal(res.target.model, 'server-model');
  }

  // 内网地址是合法目标（用户自己的 GPU 服务器）
  res = profilesMod.resolveTestTarget({ baseUrl: 'http://10.0.0.10/v1' }, fallback);
  assert.equal(res.ok, true, '不应封禁私有网段');

  // 非法地址 → 直接报错，不发请求
  assert.equal(profilesMod.resolveTestTarget({ baseUrl: 'ftp://x/v1' }, fallback).ok, false);
  assert.equal(profilesMod.resolveTestTarget({ baseUrl: 'http://' }, fallback).ok, false);
});

test('buildCustomValues：空字段不提交，只提交真正填写过的值', () => {
  const base = {
    intimacy: '',
    trust: 12,
    emotional_balance: '',
    unresolved_tension: 0,
    repair_credit: '',
    mood: '  ',
    stage: 2,
    personality: { warmth: '', playfulness: '65' },
    anxiety: '',
    avoidance: '',
    libido: '',
    intimacy_need: '',
    sexual_satisfaction: '',
    sexual_stress: '',
  };
  const v = sharedMod.buildCustomValues(base);
  assert.equal(v.intimacy, undefined, '空串不应出现在提交体里');
  assert.equal(v.trust, 12);
  assert.equal(v.unresolved_tension, 0, '显式的 0 应保留');
  assert.equal(v.mood, undefined, '纯空白心情不应提交');
  assert.equal(v.stage, 2);
  assert.deepEqual(v.personality, { playfulness: 65 });
});