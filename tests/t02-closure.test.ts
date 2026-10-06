// T02 收尾回归（D2 上下文接入 + D3 counters 私有键 + extended fix：cast/偏好按伴侣播种）。
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据。
//
// 覆盖：
//  1. resolveCompanionId 解析（查询参数 / 请求头 / 缺省）
//  2. withRequestCompanion：读/写落到请求所指伴侣（"chat 到 c2 就落 c2" 的机制保证）
//  3. 会话锁按 companionId 分键：不同伴侣并行、同一伴侣串行（"c1/c2 并发聊天"的机制保证）
//  4. D3 ck 命名空间：主女友沿用无后缀键（零回归）、其余走 '#c{id}'、计数互不串味
//  5. D3 引擎回合计数：noteTurnAndMaybeCheck 复用引擎的 ck('turn_count')
//  6. extended fix：新伴侣 initPanels 播种 cast + 默认亲密偏好，且重复调用不重复播种
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-t02-closure-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const ctxMod = await import('../src/lib/companion-context.ts');
const companionMod = await import('../src/lib/companion.ts');
const engineMod = await import('../src/lib/engine.ts');
const turnMod = await import('../src/lib/turn.ts');
const lifeMod = await import('../src/lib/life.ts');
const hintsMod = await import('../src/lib/response-hints.ts');

dbMod.getDb(); // 触发建库（迁移 + 种子：companion 1 = 主女友）

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

const { withCompanion, cId, ck, PRIMARY_COMPANION_ID } = ctxMod;
const { dbGet, getCounter, setCounter, bumpCounter, getSetting } = dbMod;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function count(table: string, companionId: number): number {
  const r = dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE companion_id = ?`, companionId);
  return Number(r?.c ?? 0);
}

/* ================================================================== */
/* 1. resolveCompanionId：查询参数 / 请求头 / 缺省                       */
/* ================================================================== */
test('resolveCompanionId：?companionId= 优先，其次 X-Companion-Id，缺省 1', () => {
  const byQuery = new Request('http://localhost/api/messages?companionId=2');
  assert.equal(companionMod.resolveCompanionId(byQuery), 2);

  const byHeader = new Request('http://localhost/api/messages', { headers: { 'X-Companion-Id': '3' } });
  assert.equal(companionMod.resolveCompanionId(byHeader), 3);

  const none = new Request('http://localhost/api/messages');
  assert.equal(companionMod.resolveCompanionId(none), PRIMARY_COMPANION_ID);

  // 非法值一律回落主女友
  const bad = new Request('http://localhost/api/messages?companionId=-5');
  assert.equal(companionMod.resolveCompanionId(bad), PRIMARY_COMPANION_ID);
});

/* ================================================================== */
/* 2. withRequestCompanion：写落到请求所指伴侣                           */
/* ================================================================== */
test('withRequestCompanion：chat 到 c2 就落 c2（写入归属正确）', async () => {
  // 缺省 → 主女友
  const reqDefault = new Request('http://localhost/api/chat');
  const id1 = companionMod.withRequestCompanion(reqDefault, () => engineMod.insertMessage('user', 'closure-default'));
  const row1 = dbGet<{ companion_id: number }>('SELECT companion_id FROM messages WHERE id = ?', id1);
  assert.equal(Number(row1?.companion_id), PRIMARY_COMPANION_ID, '缺省应落主女友');

  // 指定 c2 → 落 c2
  const req2 = new Request('http://localhost/api/chat?companionId=2');
  const id2 = companionMod.withRequestCompanion(req2, () => engineMod.insertMessage('user', 'closure-c2'));
  const row2 = dbGet<{ companion_id: number }>('SELECT companion_id FROM messages WHERE id = ?', id2);
  assert.equal(Number(row2?.companion_id), 2, '指定 c2 应落 c2');

  // 异步 handler 也保持上下文（返回 Promise 结果正确）
  const seen = await companionMod.withRequestCompanion(req2, async () => {
    await sleep(1);
    return cId();
  });
  assert.equal(seen, 2, '异步包裹后 cId() 仍为 2');
});

/* ================================================================== */
/* 3. 会话锁按 companionId 分键                                          */
/* ================================================================== */
test('会话锁：不同伴侣并行、同一伴侣串行（c1/c2 并发聊天）', async () => {
  let r1 = false;
  let r2 = false;
  let overlap = false;
  await Promise.all([
    turnMod.withConversationLock(1, async () => {
      r1 = true;
      await sleep(40);
      if (r2) overlap = true;
      r1 = false;
    }),
    turnMod.withConversationLock(2, async () => {
      r2 = true;
      await sleep(40);
      if (r1) overlap = true;
      r2 = false;
    }),
  ]);
  assert.equal(overlap, true, '不同 companionId 的会话锁互不阻塞 → 应可并行');

  // 同一 key 严格串行：a 完全结束后 b 才开始
  const order: string[] = [];
  await Promise.all([
    turnMod.withConversationLock(5, async () => {
      order.push('a1');
      await sleep(30);
      order.push('a2');
    }),
    turnMod.withConversationLock(5, async () => {
      order.push('b1');
      await sleep(5);
      order.push('b2');
    }),
  ]);
  assert.equal(order.join(','), 'a1,a2,b1,b2', '同一 companionId 必须串行');
});

/* ================================================================== */
/* 4. D3 ck 命名空间：主女友无后缀 + 计数隔离                            */
/* ================================================================== */
test("D3 ck：主女友沿用无后缀键（零回归），其余 'key#c{id}'，计数互不串味", () => {
  // 无作用域即主女友 → 无后缀
  assert.equal(ck('turn_count'), 'turn_count', '主女友（缺省作用域）应落到无后缀键');
  assert.equal(withCompanion(1, () => ck('turn_count')), 'turn_count', 'c1 显式作用域同样无后缀');
  assert.equal(withCompanion(2, () => ck('turn_count')), 'turn_count#c2', 'c2 应带 #c2 后缀');

  // 计数隔离：c1 与 c2 各写各的
  withCompanion(1, () => setCounter(ck('turn_count'), 7));
  withCompanion(2, () => setCounter(ck('turn_count'), 3));
  assert.equal(withCompanion(1, () => getCounter(ck('turn_count'))), 7, 'c1 计数不受 c2 影响');
  assert.equal(withCompanion(2, () => getCounter(ck('turn_count'))), 3, 'c2 计数不受 c1 影响');
  // 底层键验证：主女友确用无后缀键（兼容老数据/老测试）
  assert.equal(getCounter('turn_count'), 7);
  assert.equal(getCounter('turn_count#c2'), 3);

  bumpCounter('turn_count#c2');
  assert.equal(getCounter('turn_count#c2'), 4, 'c2 私有键独立自增');
  assert.equal(getCounter('turn_count'), 7, 'c1 无后缀键不因 c2 自增而变化');
});

/* ================================================================== */
/* 5. D3 引擎回合计数：noteTurnAndMaybeCheck 复用 ck('turn_count')       */
/* ================================================================== */
test('D3 调度钩子：复用引擎回合计数（不再独立计数 → 无双重计数）', () => {
  const created = companionMod.createCompanion({ name: '攻略辛', age: 24, pursue: true });
  assert.ok(created.ok);
  const id = created.companion.id;
  const key = `${hintsMod.TURN_COUNTER}#c${id}`;
  setCounter(key, 0); // 归一：避免与本文件早先用例（可能占用同一 id 的私有键）相互影响

  // 引擎尚未推进 → turn=0，不触发检查
  const t0 = hintsMod.noteTurnAndMaybeCheck(id);
  assert.equal(t0.turn, 0, 'turn=0 不应触发');

  // 模拟引擎 commitTurn 累计到 5 回合（写的是同一把私有键）
  for (let i = 0; i < 5; i++) bumpCounter(key);
  const t5 = hintsMod.noteTurnAndMaybeCheck(id);
  assert.equal(t5.turn, 5, '应读到引擎维护的回合计数 5');
  assert.equal(t5.ran, true, '第 5 回合应触发一次攻略检查');

  // 关键：调用 noteTurnAndMaybeCheck 本身不改变计数（只读，避免与引擎双重计数）
  assert.equal(getCounter(key), 5, 'noteTurnAndMaybeCheck 不得自增回合计数');
});

/* ================================================================== */
/* 6. extended fix：cast / 亲密偏好按伴侣播种且幂等                        */
/* ================================================================== */
test('extended fix：新伴侣 initPanels 播种 cast + 默认偏好，重复调用不重复播种', () => {
  const created = companionMod.createCompanion({ name: '播种壬', age: 27 });
  assert.ok(created.ok);
  const id = created.companion.id;

  // 晋升 → initPanels → ensureLife（应在本伴侣命名空间内播种）
  companionMod.promote(id);

  assert.equal(getSetting(`cast_seeded#c${id}`), '1', '新伴侣的 cast 播种标记应落私有命名空间');

  const world = dbGet<{ cast_json: string | null }>('SELECT cast_json FROM shared_world WHERE companion_id = ?', id);
  const cast = JSON.parse(String(world?.cast_json ?? '[]')) as unknown[];
  assert.ok(cast.length >= 2, '新伴侣应拥有默认身边人（cast）');

  const prefN = count('intimacy_preferences', id);
  assert.ok(prefN >= 5, '新伴侣应拥有默认亲密偏好');

  // 幂等：再次 ensureLife 不应重复播种
  withCompanion(id, () => lifeMod.ensureLife());
  assert.equal(count('intimacy_preferences', id), prefN, '重复 ensureLife 不得重复播种偏好');

  const world2 = dbGet<{ cast_json: string | null }>('SELECT cast_json FROM shared_world WHERE companion_id = ?', id);
  const cast2 = JSON.parse(String(world2?.cast_json ?? '[]')) as unknown[];
  assert.equal(cast2.length, cast.length, '重复 ensureLife 不得改写/重复 cast');
});
