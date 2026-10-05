// P1-51 历史分页：GET /api/messages?beforeId= 返回该 id 之前最近 limit 条（升序），缺省行为不变
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-messages-paging-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const routeMod = await import('../src/app/api/messages/route.ts');

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

function insertMessage(role: string, content: string): number {
  return dbMod.dbRun(
    'INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    1,
    role,
    content,
    new Date().toISOString()
  ).lastInsertRowid;
}

interface MessagesJson {
  messages: { id: number }[];
  total?: number;
  hasMore?: boolean;
}

test('beforeId：返回该 id 之前最近 limit 条（升序）+ hasMore', async () => {
  const ids: number[] = [];
  for (let i = 1; i <= 5; i++) ids.push(insertMessage('user', 'm' + i));

  const beforeId = ids[3]!; // id 为第 4 条 → 之前最近 2 条应为第 2、3 条
  const res = await routeMod.GET(new Request(`http://x/api/messages?beforeId=${beforeId}&limit=2`));
  assert.equal(res.status, 200);
  const j = (await res.json()) as MessagesJson;
  assert.deepEqual(
    j.messages.map((m) => m.id),
    [ids[1], ids[2]],
    '应返回 beforeId 之前最近 2 条且升序'
  );
  assert.equal(j.hasMore, true, '取满一页 → 可能还有更早');
});

test('beforeId：没有更早的消息 → 空数组 + hasMore=false', async () => {
  const firstId = Number(dbMod.dbGet<{ m: number | null }>('SELECT MIN(id) AS m FROM messages')?.m ?? 0);
  assert.ok(firstId > 0);
  const res = await routeMod.GET(new Request(`http://x/api/messages?beforeId=${firstId}&limit=5`));
  const j = (await res.json()) as MessagesJson;
  assert.equal(j.messages.length, 0);
  assert.equal(j.hasMore, false);
});

test('缺省行为不变：返回最近 limit 条（升序）', async () => {
  const res = await routeMod.GET(new Request('http://x/api/messages?limit=3'));
  const j = (await res.json()) as MessagesJson;
  assert.equal(j.messages.length, 3);
  const gotIds = j.messages.map((m) => m.id);
  assert.deepEqual(gotIds, [...gotIds].sort((a, b) => a - b), '应按 id 升序返回');
  const maxId = Number(dbMod.dbGet<{ m: number | null }>('SELECT MAX(id) AS m FROM messages')?.m ?? 0);
  assert.equal(gotIds[gotIds.length - 1], maxId, '最后一条应是库里最新的消息');
});

test('afterId 增量拉取（轮询用）仍然可用', async () => {
  const allIds = (await (await routeMod.GET(new Request('http://x/api/messages?limit=50'))).json() as MessagesJson).messages.map(
    (m) => m.id
  );
  const lastId = allIds[allIds.length - 1]!;
  const res = await routeMod.GET(new Request(`http://x/api/messages?afterId=${lastId}`));
  const j = (await res.json()) as MessagesJson;
  assert.equal(j.messages.length, 0, '没有比 lastId 更新的消息时应为空');
});