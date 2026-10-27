// 本地知识库：切块 / 导入 / 检索 / 删除 / 上限 / 伴侣隔离
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-kb-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const kb = await import('../src/lib/knowledge.ts');
const ctx = await import('../src/lib/companion-context.ts');
dbMod.getDb(); // 触发建库与迁移（含 v17 知识库表）

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

test('chunkText：空输入返回空数组；短文本保持单块', () => {
  assert.deepEqual(kb.chunkText(''), []);
  assert.deepEqual(kb.chunkText('   \n  '), []);
  const short = '今天去公园散步，看到一只很胖的猫。';
  const one = kb.chunkText(short);
  assert.equal(one.length, 1);
  assert.equal(one[0], short);
});

test('chunkText：长文本每块有界且非空', () => {
  const long = '这是第一句话，用来测试切块。'.repeat(40) + '\n\n' + '这是第二段内容，也要被切进某个块里。'.repeat(40);
  const chunks = kb.chunkText(long);
  assert.ok(chunks.length > 2);
  for (const c of chunks) {
    assert.ok(c.length > 0);
    assert.ok(c.length <= kb.KB_CHUNK_MAX);
  }
});

test('chunkText：超长无标点文本硬切不丢字', () => {
  const raw = '啊'.repeat(kb.KB_CHUNK_MAX * 2 + 37);
  const chunks = kb.chunkText(raw);
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.length <= kb.KB_CHUNK_MAX);
  assert.equal(chunks.join('').length, raw.length);
});

test('导入 → 列表 → 检索 → 删除（含块与向量清理）', async () => {
  const body = '手冲咖啡的水温建议控制在 92 度左右。水温太高会发苦，太低会发酸。';
  const r = await kb.addKbDoc('咖啡笔记', 'paste', body);
  assert.ok(r.id > 0);
  assert.ok(r.chunks >= 1);

  const docs = kb.listKbDocs();
  assert.equal(docs.length, 1);
  assert.equal(docs[0]?.title, '咖啡笔记');
  assert.equal(Number(docs[0]?.char_count), body.length);

  const hits = await kb.searchKb('手冲咖啡 水温 92 度');
  assert.ok(hits.length >= 1);
  assert.ok(String(hits[0]?.content || '').includes('92'));

  const block = kb.formatKbBlock(hits);
  assert.ok(block.includes('<DATA>'));
  assert.ok(block.includes('咖啡笔记'));
  assert.equal(kb.formatKbBlock([]), '');

  assert.equal(kb.deleteKbDoc(r.id), true);
  assert.equal(kb.listKbDocs().length, 0);
  const chunkLeft = dbMod.dbAll<{ c: number }>('SELECT COUNT(*) AS c FROM kb_chunks')[0]?.c;
  assert.equal(Number(chunkLeft || 0), 0);
  const embLeft = dbMod.dbAll<{ c: number }>('SELECT COUNT(*) AS c FROM kb_chunk_embeddings')[0]?.c;
  assert.equal(Number(embLeft || 0), 0);
  // 删不存在的资料不能回报成功
  assert.equal(kb.deleteKbDoc(r.id), false);
});

test('上限：超长资料被拒绝，且不落库', async () => {
  await assert.rejects(
    () => kb.addKbDoc('超长', '', '字'.repeat(kb.KB_MAX_DOC_CHARS + 1)),
    /最多/
  );
  assert.equal(kb.listKbDocs().length, 0);
});

test('伴侣隔离：c2 导入的资料，c1 检索与列表都看不到', async () => {
  await ctx.withCompanion(2, async () => {
    await kb.addKbDoc('二号伴侣的资料', '', '她喜欢在雨天听爵士乐。');
  });

  const mine = await kb.searchKb('雨天 爵士乐');
  assert.equal(mine.length, 0);
  assert.equal(kb.listKbDocs().length, 0);

  const theirs = await ctx.withCompanion(2, () => kb.searchKb('雨天 爵士乐'));
  assert.ok(theirs.length >= 1);
  assert.equal(kb.listKbDocs().length, 0); // 默认作用域仍是 c1

  // 清理 c2 的数据，避免影响其它用例
  ctx.withCompanion(2, () => {
    for (const d of kb.listKbDocs()) kb.deleteKbDoc(d.id);
  });
});
