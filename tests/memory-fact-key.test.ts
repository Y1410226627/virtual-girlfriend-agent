// P1-20/21/23 记忆事实键回归：
//  - 同 fact_key 换说法 → supersede 旧条，不产生两条 active
//  - 不同 fact_key（向量相近）→ 不互相覆盖
//  - 纠正按 old_fact_key 精确命中（不靠文本相似度）
//  - addMemoriesBatch 返回与入参等长的 id，且判重生效
// 隐私：使用独立临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-fact-key-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const memMod = await import('../src/lib/memory.ts');

dbMod.getDb();

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

const U = dbMod.DEFAULT_USER_ID;

interface MemRow {
  id: number;
  content: string;
  status: string;
  superseded_by: number | null;
}

function byFactKey(key: string, status?: string): MemRow[] {
  const where = status ? 'AND status = ?' : '';
  const params: unknown[] = [U, key];
  if (status) params.push(status);
  return dbMod.dbAll<MemRow>(
    `SELECT id, content, status, superseded_by FROM memories WHERE user_id = ? AND fact_key = ? ${where} ORDER BY id ASC`,
    ...params
  );
}

test('P1-20 同 fact_key 换说法：supersede 旧条，active 只剩一条', async () => {
  const id1 = await memMod.addMemory({ type: 'semantic', content: '他喜欢冰美式', importance: 7, fact_key: 'preference.drink' });
  const id2 = await memMod.addMemory({
    type: 'semantic',
    content: '他每天早晨都要一杯冰美式',
    importance: 7,
    fact_key: 'preference.drink',
  });
  assert.ok(id1 && id2, '两条都应写入');
  assert.notEqual(id1, id2, '换说法的同一事实应新建一条');

  const active = byFactKey('preference.drink', 'active');
  assert.equal(active.length, 1, '同一 fact_key 只能有一条 active');
  assert.equal(active[0]!.id, id2);

  const old = byFactKey('preference.drink').find((r) => r.id === id1);
  assert.equal(old?.status, 'superseded', '旧条应标 superseded');
  assert.equal(old?.superseded_by, id2, '旧条应指向新条（保留历史）');
});

test('P1-20 不同 fact_key（向量相近）→ 互不覆盖，两条并存', async () => {
  await memMod.addMemory({ type: 'semantic', content: '他喜欢冰美式', importance: 7, fact_key: 'preference.drink.cold' });
  await memMod.addMemory({ type: 'semantic', content: '他喜欢拿铁', importance: 7, fact_key: 'preference.drink.latte' });

  assert.equal(byFactKey('preference.drink.cold', 'active').length, 1, '冰美式那条应保持 active');
  assert.equal(byFactKey('preference.drink.latte', 'active').length, 1, '拿铁那条应保持 active（不被相近向量误覆盖）');
});

test('P1-21 纠正按 old_fact_key 精确命中（不受 old_hint 文本影响）', async () => {
  const oldId = await memMod.addMemory({ type: 'semantic', content: '他叫小明', importance: 7, fact_key: 'identity.name' });
  assert.ok(oldId);

  // old_hint 故意与目标无关：命中的唯一依据应是 old_fact_key
  const r = await memMod.applyMemoryCorrection('一个完全无关的描述', '他其实叫小红', null, 'identity.name');
  assert.equal(r.supersededId, oldId, '应按事实键精确命中旧记忆');
  assert.ok(r.newMemoryId);

  const newRow = dbMod.dbGet<MemRow>('SELECT id, content, status, superseded_by FROM memories WHERE id = ?', r.newMemoryId);
  assert.equal(newRow?.content, '他其实叫小红');
  assert.equal(newRow?.status, 'active');
  const keyed = byFactKey('identity.name', 'active');
  assert.equal(keyed.length, 1, '纠正后同一事实键仍只保留一条 active');
  assert.equal(keyed[0]!.id, r.newMemoryId);
});

test('P1-23 addMemoriesBatch：返回 id 数组且判重生效', async () => {
  const ids = await memMod.addMemoriesBatch([
    { type: 'semantic', content: '他喜欢爬山', importance: 6, fact_key: 'hobby.hike' },
    { type: 'semantic', content: '他喜欢爬山', importance: 6, fact_key: 'hobby.hike' },
    { type: 'semantic', content: 'x', importance: 6, fact_key: 'hobby.short' },
  ]);

  assert.equal(ids.length, 3, '返回数组长度应与入参一致');
  assert.ok(ids[0] && ids[0] > 0, '第一条应写入并返回 id');
  assert.equal(ids[1], ids[0], '重复上报同一事实 → 返回已有 id（判重生效）');
  assert.equal(ids[2], null, '内容过短（<2 字）→ 返回 null');
  assert.equal(byFactKey('hobby.hike', 'active').length, 1, '同键重复不应产生两条 active');
});