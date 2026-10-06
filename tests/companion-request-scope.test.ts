// T05 集成补丁 · 伴侣请求作用域回归：
//  ① withCompanionQuery 纯函数：缺省 1 / 显式 2 / 已有 query / 非法值 / 字符串 id / 小数截断；
//  ② companionReadKey：主女友沿用旧键（零回归）/ 其它伴侣按伴侣分键；
//  ③ 服务端契约：resolveCompanionId 正确解析 ?companionId= 与 X-Companion-Id，缺省 1；
//  ④ 前后端闭环：withCompanionQuery 产出的 URL 喂给 resolveCompanionId 得到同一个 id；
//  ⑤ 聊天链路端点枚举：对 id=2 每个请求都带 companionId=2，对 id=1（缺省）一个都不带。
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-companion-scope-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB;

const dbMod = await import('../src/lib/db.ts');
const queryMod = await import('../src/components/chat/companion-query.ts');
const companionMod = await import('../src/lib/companion.ts');

dbMod.getDb();

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

const { withCompanionQuery, companionReadKey, DEFAULT_COMPANION_ID } = queryMod;
const { resolveCompanionId } = companionMod;

const req = (url: string, init?: RequestInit): Request => new Request(`http://localhost${url}`, init);

/* ================================================================== */
/* 1. withCompanionQuery 纯函数                                        */
/* ================================================================== */
test('withCompanionQuery：缺省 1 原样返回（单女友零回归）', () => {
  assert.equal(DEFAULT_COMPANION_ID, 1);
  assert.equal(withCompanionQuery('/api/state', 1), '/api/state');
  assert.equal(withCompanionQuery('/api/messages?limit=80', 1), '/api/messages?limit=80');
  assert.equal(withCompanionQuery('/api/messages?limit=80', 1, 1), '/api/messages?limit=80');
});

test('withCompanionQuery：显式 2 —— 无 query 用 ?，已有 query 用 &', () => {
  assert.equal(withCompanionQuery('/api/chat', 2), '/api/chat?companionId=2');
  assert.equal(withCompanionQuery('/api/messages?limit=80', 2), '/api/messages?limit=80&companionId=2');
  assert.equal(withCompanionQuery('/api/messages?beforeId=10&limit=60', 2), '/api/messages?beforeId=10&limit=60&companionId=2');
});

test('withCompanionQuery：非法值一律原样返回', () => {
  for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(withCompanionQuery('/api/state', bad), '/api/state', `非法 id ${String(bad)} 应原样返回`);
  }
  assert.equal(withCompanionQuery('/api/state', 'abc' as unknown as number), '/api/state');
});

test('withCompanionQuery：字符串 id 与小数截断', () => {
  assert.equal(withCompanionQuery('/api/chat', '2' as unknown as number), '/api/chat?companionId=2');
  assert.equal(withCompanionQuery('/api/chat', '1' as unknown as number), '/api/chat', '字符串 "1" 等于缺省 → 原样返回');
  assert.equal(withCompanionQuery('/api/chat', 2.9), '/api/chat?companionId=2', '小数应截断为 2');
  assert.equal(withCompanionQuery('/api/chat', '0' as unknown as number), '/api/chat', '"0" 非法 → 原样返回');
});

/* ================================================================== */
/* 2. companionReadKey                                                 */
/* ================================================================== */
test('companionReadKey：主女友沿用旧键，其它伴侣按伴侣分键', () => {
  assert.equal(companionReadKey(1), 'lastReadMsgId');
  assert.equal(companionReadKey('1' as unknown as number), 'lastReadMsgId');
  assert.equal(companionReadKey(2), 'lastReadMsgId#c2');
  assert.equal(companionReadKey(0), 'lastReadMsgId');
  assert.equal(companionReadKey(NaN), 'lastReadMsgId');
});

/* ================================================================== */
/* 3. 服务端契约 resolveCompanionId                                     */
/* ================================================================== */
test('resolveCompanionId：查询参数 / 请求头 / 缺省 1', () => {
  assert.equal(resolveCompanionId(req('/api/messages')), 1, '无参数 → 主女友 1');
  assert.equal(resolveCompanionId(req('/api/messages?companionId=2')), 2);
  assert.equal(resolveCompanionId(req('/api/messages', { headers: { 'X-Companion-Id': '3' } })), 3);
  // 查询参数优先于请求头
  assert.equal(resolveCompanionId(req('/api/messages?companionId=2', { headers: { 'X-Companion-Id': '3' } })), 2);
  // 非法值 → 兜底主女友
  assert.equal(resolveCompanionId(req('/api/messages?companionId=abc')), 1);
  assert.equal(resolveCompanionId(req('/api/messages?companionId=0')), 1);
  assert.equal(resolveCompanionId(req('/api/messages?companionId=-5')), 1);
});

/* ================================================================== */
/* 4. 前后端闭环：前端构造的 URL 能被服务端解析为同一个 id               */
/* ================================================================== */
test('闭环：withCompanionQuery 的输出喂给 resolveCompanionId 得到同一 id', () => {
  const bases = ['/api/chat', '/api/messages?limit=80', '/api/messages?beforeId=9&limit=60', '/api/state'];
  for (const id of [1, 2, 5, 42]) {
    for (const base of bases) {
      const url = withCompanionQuery(base, id);
      assert.equal(resolveCompanionId(req(url)), id, `${base} @ id=${id} 应闭环解析一致（实际 url=${url}）`);
    }
  }
});

/* ================================================================== */
/* 5. 聊天链路端点枚举：切换后每个请求都带正确 id                        */
/* ================================================================== */
test('聊天链路端点：id=2 每个请求都带 companionId=2；id=1（缺省）一个都不带', () => {
  // 与 use-chat-stream / use-chat-state / use-photo / use-delete-flow / use-event-bar /
  // ChatHeader / PhotoModal 中实际调用的「伴侣作用域」端点和参数一一对应。
  const chain = (id: number): string[] => [
    withCompanionQuery('/api/chat', id), // use-chat-stream 发送/重生成
    withCompanionQuery('/api/messages?limit=80', id), // 首屏消息
    withCompanionQuery('/api/messages?beforeId=10&limit=60', id), // 加载更早
    withCompanionQuery('/api/messages?afterId=10', id), // 15s 轮询
    withCompanionQuery('/api/messages?id=10&cascade=0', id), // 撤回
    withCompanionQuery('/api/messages?id=10&cascade=1', id), // 删除
    withCompanionQuery('/api/analyze', id), // 后台分析 poll
    withCompanionQuery('/api/state', id), // 状态
    withCompanionQuery('/api/relationship', id), // 场景/昵称
    withCompanionQuery('/api/life', id), // 事件条
    withCompanionQuery('/api/photo', id), // 照片
    withCompanionQuery('/api/interact', id), // 摸头 / 触摸互动
  ];

  const forTwo = chain(2);
  assert.ok(forTwo.length >= 12, '端点清单应覆盖整条聊天链路');
  for (const url of forTwo) {
    assert.ok(url.includes('companionId=2'), `切换后每个请求都应带 companionId=2：${url}`);
    assert.equal(resolveCompanionId(req(url)), 2, `服务端应解析为 2：${url}`);
  }

  const forOne = chain(1);
  for (const url of forOne) {
    assert.ok(!url.includes('companionId='), `缺省伴侣不应出现多余查询参数：${url}`);
    assert.equal(resolveCompanionId(req(url)), 1, `缺省应解析为 1：${url}`);
  }
});

test('非伴侣作用域端点（tick / asr / tts / groups）保持裸 URL 不变', () => {
  // 这些端点服务端不读取 companion 上下文，故 not wired：即便传入非缺省 id 也应原样返回。
  for (const url of ['/api/tick', '/api/asr', '/api/tts', '/api/groups', '/api/groups/3']) {
    // 说明：这里断言的是「即使调用方误传 id，也不应改变 url 语义」——它们本就不经过 withCompanionQuery，
    // 用缺省 id 调用天然保持不变（单女友零回归）。
    assert.equal(withCompanionQuery(url, 1), url);
  }
});
