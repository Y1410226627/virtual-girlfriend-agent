// 记忆多查询检索回归（P1-22）：
// - mergeQueryHits 纯函数：按 id 去重合并、取最大相似度、按相似度降序（可脱离网络确定性验证）；
// - extraQueries 集成：主查询命不中、额外查询能命中的记忆会被召回，且不传额外查询时行为不变。
// 隐私：使用独立临时库（os.tmpdir），绝不触碰 data/ 下的真实数据。
// 说明：测试环境未配置向量接口 → embedOne 走本地 512 维哈希，结果确定可复现。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-multiquery-${process.pid}-${Date.now()}.db`);
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

test('mergeQueryHits：按 id 去重、取最大相似度、按相似度降序（同分按 id）', () => {
  const merged = memMod.mergeQueryHits([
    [
      { id: 1, sim: 0.2 },
      { id: 2, sim: 0.9 },
    ],
    [
      { id: 1, sim: 0.7 },
      { id: 3, sim: 0.5 },
      { id: 2, sim: 0.4 },
    ],
  ]);
  assert.deepEqual(merged, [
    { id: 2, sim: 0.9 },
    { id: 1, sim: 0.7 },
    { id: 3, sim: 0.5 },
  ]);
});

test('extraQueries：只有额外查询能命中的记忆会被召回', async () => {
  const mainQuery = '今天天气好不好';
  const extra = '马拉松训练计划';
  const extraVec = await llmMod.embedOne(extra);
  const mainVec = await llmMod.embedOne(mainQuery);

  // 高重要度噪声：保证主查询有稳定命中（避免走"无命中兜底"分支）
  const idNoise = insertMemory('episodic', '今天天气真好，适合出去散步', 8, mainVec);
  // 与主查询基本无关、只跟额外查询高度相关的目标记忆
  const idTarget = insertMemory('episodic', '他报名了下个月的马拉松训练计划', 3, extraVec);

  const onlyMain = await memMod.retrieveMemories(mainQuery, 5);
  const withExtra = await memMod.retrieveMemories(mainQuery, { extraQueries: [extra], topK: 5 });

  assert.ok(
    withExtra.some((r) => r.id === idTarget),
    `额外查询应把目标记忆召回：${withExtra.map((r) => r.id)}`
  );
  assert.ok(
    !onlyMain.some((r) => r.id === idTarget),
    `仅主查询不应召回目标记忆：${onlyMain.map((r) => r.id)}`
  );
  assert.ok(
    withExtra.some((r) => r.id === idNoise),
    '主查询命中的噪声记忆应仍在结果里'
  );
});

test('旧调用（数字 topK）与新调用（对象 topK）结果一致', async () => {
  const q = '今天天气好不好';
  const a = await memMod.retrieveMemories(q, 3);
  const b = await memMod.retrieveMemories(q, { topK: 3 });
  assert.deepEqual(
    a.map((r) => r.id),
    b.map((r) => r.id),
    '两种调用方式应完全等价'
  );
});

test('单查询结果与多查询（无额外查询）一致', async () => {
  const q = '今天天气好不好';
  const a = await memMod.retrieveMemories(q);
  const b = await memMod.retrieveMemories(q, { extraQueries: [] });
  assert.deepEqual(
    a.map((r) => r.id),
    b.map((r) => r.id)
  );
});