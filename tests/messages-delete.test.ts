// /api/messages DELETE 回归：负/非法 id 不得清库、单条删除、显式 all=1 清空、级联清理孤儿表
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-messages-delete-${process.pid}-${Date.now()}.db`);
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

function count(table: string): number {
  return Number(dbMod.dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)?.c ?? 0);
}

test('DELETE 负 id：返回 400，消息仍在（绝不退化成清空）', async () => {
  const id = insertMessage('user', '这条不能被误删');
  const res = await routeMod.DELETE(new Request('http://x/api/messages?id=-1', { method: 'DELETE' }));
  assert.equal(res.status, 400, '负 id 必须 400');
  const j = await res.json();
  assert.ok(j.error, '应返回错误信息');
  assert.ok(dbMod.dbGet('SELECT id FROM messages WHERE id = ?', id), '消息不应被删除');
});

test('DELETE 真实 id：只删这一条', async () => {
  const id = insertMessage('user', '删我');
  const res = await routeMod.DELETE(new Request(`http://x/api/messages?id=${id}`, { method: 'DELETE' }));
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(dbMod.dbGet('SELECT id FROM messages WHERE id = ?', id), undefined, '目标消息应被删除');
});

test('DELETE 无参数返回 400；?all=1 才清空', async () => {
  insertMessage('user', 'a');
  insertMessage('assistant', 'b');
  const before = count('messages');
  assert.ok(before >= 2);

  const res1 = await routeMod.DELETE(new Request('http://x/api/messages', { method: 'DELETE' }));
  assert.equal(res1.status, 400, '不带参数必须 400');
  assert.equal(count('messages'), before, '不带参数不应删任何消息');

  const res2 = await routeMod.DELETE(new Request('http://x/api/messages?all=1', { method: 'DELETE' }));
  assert.equal(res2.status, 200);
  assert.equal(count('messages'), 0, 'all=1 应清空消息');
});

test('清空：清理孤儿审计数据、置 NULL 业务列、重置自增序列', async () => {
  const m1 = insertMessage('user', 'u');
  const m2 = insertMessage('assistant', 'a');
  const now = new Date().toISOString();

  // 造"指向消息"的孤儿数据
  dbMod.dbRun(
    'INSERT INTO turn_effects (user_id, message_id, user_message_id, created_at) VALUES (?, ?, ?, ?)',
    1, m2, m1, now
  );
  dbMod.dbRun(
    'INSERT INTO proactive_messages (user_id, kind, content, message_id, created_at) VALUES (?, ?, ?, ?, ?)',
    1, 'care', 'hi', m2, now
  );
  dbMod.dbRun(
    "INSERT INTO memories (user_id, type, content, source_message_id, created_at, status) VALUES (?, 'semantic', ?, ?, ?, 'active')",
    1, '她记得的事', m2, now
  );
  dbMod.dbRun(
    "INSERT INTO personality_signals (user_id, message_id, dimension, direction, strength, created_at) VALUES (?, ?, 'warmth', 'up', 1, ?)",
    1, m2, now
  );
  dbMod.dbRun(
    "INSERT INTO personality_logs (user_id, message_id, dimension, old_value, new_value, delta, created_at) VALUES (?, ?, 'warmth', 50, 51, 1, ?)",
    1, m2, now
  );
  dbMod.dbRun(
    "INSERT INTO attachment_signals (user_id, message_id, axis, direction, delta, created_at) VALUES (?, ?, 'anxiety', 'down', -1, ?)",
    1, m2, now
  );
  dbMod.dbRun(
    "INSERT INTO emotional_bank (user_id, message_id, delta, kind, balance_after, created_at) VALUES (?, ?, 1, 'deposit', 1, ?)",
    1, m2, now
  );
  dbMod.dbRun(
    "INSERT INTO relationship_logs (user_id, message_id, kind, summary, created_at) VALUES (?, ?, 'mood', '测试', ?)",
    1, m2, now
  );

  const res = await routeMod.DELETE(new Request('http://x/api/messages?all=1', { method: 'DELETE' }));
  assert.equal(res.status, 200);

  assert.equal(count('messages'), 0, '消息应清空');
  assert.equal(count('turn_effects'), 0, 'turn_effects（消息派生审计数据）应清空');
  assert.equal(count('proactive_messages'), 0, 'proactive_messages（消息派生审计数据）应清空');

  // 业务数据本体保留，仅解除对消息的引用
  const mem = dbMod.dbGet<{ source_message_id: number | null }>('SELECT source_message_id FROM memories LIMIT 1');
  assert.ok(mem, '记忆本体应保留');
  assert.equal(mem!.source_message_id, null, 'memories.source_message_id 应置 NULL');

  for (const t of ['personality_signals', 'personality_logs', 'attachment_signals', 'emotional_bank', 'relationship_logs']) {
    const n = Number(
      dbMod.dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t} WHERE message_id IS NOT NULL`)?.c ?? 0
    );
    assert.equal(n, 0, `${t}.message_id 应全部置 NULL`);
  }

  // 自增序列已重置：清空后新插入的第一条消息 id 从 1 开始（避免复用旧 id 命中陈旧记录）
  const newId = insertMessage('user', '清空后第一条');
  assert.equal(newId, 1, 'sqlite_sequence 应已重置，新消息 id 从 1 开始');
});