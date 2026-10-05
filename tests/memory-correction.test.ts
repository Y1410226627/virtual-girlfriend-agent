// 记忆纠正 / 灰区合并回归：相似但不同的记忆不能误判；真正的纠正要命中；灰区同类近似要合并
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-memcorr-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const memMod = await import('../src/lib/memory.ts');
const llmMod = await import('../src/lib/llm.ts');

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

/** 插入一条不带宽度的语义记忆（向量缺失 → 只走文本兜底评分） */
function insertSemantic(content: string): number {
  const { lastInsertRowid } = dbMod.dbRun(
    `INSERT INTO memories (user_id, type, content, importance, created_at, last_accessed_at, status, access_count)
     VALUES (?, 'semantic', ?, 7, ?, NULL, 'active', 0)`,
    dbMod.DEFAULT_USER_ID,
    content,
    new Date().toISOString()
  );
  return lastInsertRowid;
}

function statusOf(id: number): string {
  const row = dbMod.dbGet<{ status: string }>('SELECT status FROM memories WHERE id = ?', id);
  return String(row?.status ?? '');
}

/* ------------------------------------------------------------------ */
/* P1-7：更正与误判                                                     */
/* ------------------------------------------------------------------ */

test('P1-7 相似但不同的两条记忆：共享常见词不应被 supersede', async () => {
  const a = insertSemantic('她喜欢吃辣');
  const r = await memMod.applyMemoryCorrection('她喜欢吃甜', '她其实更喜欢吃甜的');
  assert.equal(statusOf(a), 'active', '相近但不同的旧记忆不应被标 superseded');
  assert.equal(r.supersededId, null, '不应记录被推翻的旧记忆');
  assert.ok(r.newMemoryId, '新事实仍应写入');
});

test('P1-7 共享句式但内容不同：不应被 supersede（阈值上调）', async () => {
  const c = insertSemantic('他喜欢在晴天听歌');
  const r = await memMod.applyMemoryCorrection('他喜欢在雨天听歌', '他其实喜欢在雨天听歌');
  assert.equal(statusOf(c), 'active', '只在关键处不同的不同记忆不应被误判为同一条');
  assert.equal(r.supersededId, null);
});

test('P1-7 真正的名字纠正：旧条被 supersede，新事实落地', async () => {
  const oldName = insertSemantic('他叫小明');
  const r = await memMod.applyMemoryCorrection('他叫小明', '他叫小红');
  assert.equal(statusOf(oldName), 'superseded', '真正的纠正应把旧记忆标为 superseded');
  assert.equal(r.supersededId, oldName);
  const newRow = dbMod.dbGet<{ content: string; status: string }>(
    'SELECT content, status FROM memories WHERE id = ?',
    r.newMemoryId
  );
  assert.equal(newRow?.content, '他叫小红');
  assert.equal(newRow?.status, 'active');
});

test('P1-7 低相似度不误伤', async () => {
  const c = insertSemantic('她最喜欢的运动是游泳');
  const r = await memMod.applyMemoryCorrection('今天食堂的饭很难吃', '她今天没去上课');
  assert.equal(statusOf(c), 'active');
  assert.equal(r.supersededId, null);
});

/* ------------------------------------------------------------------ */
/* P1-8：灰区（0.85~0.92）同类近似应合并                                 */
/* ------------------------------------------------------------------ */

test('P1-8 灰区同类近似记忆 → 合并为一条，而非两条并存', async () => {
  const content = '周末一起去逛那家新开的书店';
  const vec = await llmMod.embedOne(content);
  const dim = vec.length;

  // 构造与 vec 余弦恰为 0.9 的单位向量（落入 0.85~0.92 灰区）
  const e = new Array<number>(dim).fill(0);
  e[0] = 1;
  let dot = 0;
  for (let i = 0; i < dim; i++) dot += e[i]! * vec[i]!;
  const w = e.map((x, i) => x - dot * vec[i]!);
  const wn = Math.sqrt(w.reduce((s, v) => s + v * v, 0)) || 1;
  const vGray = vec.map((x, i) => 0.9 * x + Math.sqrt(1 - 0.81) * (w[i]! / wn));

  const oldContent = '周末一起去逛那家新开的书店，顺便喝杯咖啡';
  const now = new Date().toISOString();
  const { lastInsertRowid: oldId } = dbMod.dbRun(
    `INSERT INTO memories (user_id, type, content, importance, created_at, access_count, status)
     VALUES (?, 'episodic', ?, 9, ?, 0, 'active')`,
    dbMod.DEFAULT_USER_ID,
    oldContent,
    now
  );
  dbMod.dbRun(
    `INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dim, vector, created_at) VALUES (?, 'local', ?, ?, ?)`,
    oldId,
    dim,
    JSON.stringify(vGray),
    now
  );

  await memMod.addMemory({ type: 'episodic', content, importance: 6 });

  const active = dbMod.dbAll<{ id: number; content: string; importance: number }>(
    "SELECT id, content, importance FROM memories WHERE user_id = ? AND type = 'episodic' AND status = 'active'",
    dbMod.DEFAULT_USER_ID
  );
  assert.equal(active.length, 1, '灰区同类近似应合并为一条，而不是两条并存');
  assert.equal(active[0]!.id, oldId);
  assert.equal(active[0]!.content, oldContent, '合并保留信息更全（更长）的一条');
  assert.equal(active[0]!.importance, 9, '合并取较高重要度');
});