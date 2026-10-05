// 记忆检索一致性回归：优化（向量解析缓存）后打分结果必须与手工重算一致
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
// 说明：测试环境未配置向量接口 → embedOne 走本地 512 维哈希，结果确定可复现
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-retrieval-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const memMod = await import('../src/lib/memory.ts');
const llmMod = await import('../src/lib/llm.ts');
const { cosine } = await import('../src/lib/utils.ts');

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

interface Seeded {
  id: number;
  type: string;
  importance: number;
}

function insertMemory(type: string, content: string, importance: number, vector: number[]): number {
  const now = new Date().toISOString();
  const { lastInsertRowid: id } = dbMod.dbRun(
    `INSERT INTO memories (user_id, type, content, importance, emotion, created_at, last_accessed_at, expires_at, status, access_count)
     VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, 'active', 0)`,
    dbMod.DEFAULT_USER_ID,
    type,
    content,
    importance,
    now
  );
  dbMod.dbRun(
    `INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dim, vector, created_at) VALUES (?, 'local', ?, ?, ?)`,
    id,
    vector.length,
    JSON.stringify(vector),
    now
  );
  return id;
}

/** 复刻 retrieveMemories 的打分公式（关系阶段取初始值 0） */
function manualScore(row: Seeded, vec: number[], qVec: number[]): number {
  const vecSim = vec.length ? Math.max(0, cosine(qVec, vec)) : 0;
  const importance = row.importance / 10;
  const ageDays = 0; // 刚写入，recency ≈ 1
  const halfLife = row.importance >= 8 ? 100000 : 14;
  const recency = Math.exp(-ageDays / halfLife);
  let stageRel = 0.8;
  if (row.type === 'relationship' || row.type === 'attachment') stageRel = 0.6; // stage 0
  else if (row.type === 'episodic' || row.type === 'emotional') stageRel = 1;
  else if (row.type === 'semantic') stageRel = 0.9;
  return 0.5 * vecSim + 0.2 * importance + 0.15 * recency + 0.15 * stageRel;
}

test('检索打分与手工重算一致，同一批记忆两次检索结果一致', async () => {
  const query = '她喜欢在雨天听歌';
  const qVec = await llmMod.embedOne(query);

  // 一条与查询几乎完全一致的向量，一条不相关向量
  const nearVec = qVec.slice();
  const farVec = qVec.map((_, i) => (i % 2 === 0 ? -1 : 1));

  const idNear = insertMemory('semantic', '她喜欢在雨天听歌', 8, nearVec);
  const idFar = insertMemory('semantic', '她讨厌吃香菜', 8, farVec);
  const idLow = insertMemory('episodic', '一条不重要的普通事件', 3, farVec);

  const rows1 = await memMod.retrieveMemories(query, 5);
  assert.ok(rows1.length > 0, '应检索到记忆');

  // 手工重算期望分数，top1 必须与检索结果一致
  const seeds: Array<{ id: number; type: string; importance: number; vec: number[] }> = [
    { id: idNear, type: 'semantic', importance: 8, vec: nearVec },
    { id: idFar, type: 'semantic', importance: 8, vec: farVec },
    { id: idLow, type: 'episodic', importance: 3, vec: farVec },
  ];
  let expectedTop = -1;
  let expectedBest = -Infinity;
  for (const s of seeds) {
    const score = manualScore(s, s.vec, qVec);
    if (score > expectedBest) {
      expectedBest = score;
      expectedTop = s.id;
    }
  }
  assert.equal(rows1[0]!.id, expectedTop, 'top1 应与手工重算一致');
  assert.equal(rows1[0]!.id, idNear, '与查询向量最接近的高重要度记忆应排第一');

  // 两次检索（第二次走向量解析缓存）结果集合一致
  const rows2 = await memMod.retrieveMemories(query, 5);
  const ids1 = rows1.map((r) => r.id).sort((a, b) => a - b);
  const ids2 = rows2.map((r) => r.id).sort((a, b) => a - b);
  assert.deepEqual(ids2, ids1, '两次检索结果集合应完全一致');
});