// 数据库迁移完整性回归：全新库初始化后迁移条数与关键表/列必须齐备
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-migrations-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

test('全新库初始化：schema_migrations 恰好有 11 条迁移记录', () => {
  dbMod.getDb(); // 触发 createDb → migrate + seed
  const rows = dbMod.dbAll<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
  assert.equal(rows.length, 11, `应恰好 11 条迁移，实际 ${rows.length}`);
  // 版本号应为连续的 1..11，且每条都记录了名称
  const versions = rows.map((r) => r.version);
  assert.deepEqual(
    versions,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  );
});

test('关键表存在：messages / memories / ongoing_events / life_arcs / agent_diaries', () => {
  const tables = ['messages', 'memories', 'ongoing_events', 'life_arcs', 'agent_diaries'];
  for (const name of tables) {
    const row = dbMod.dbGet<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      name
    );
    assert.ok(row, `表 ${name} 应存在`);
  }
});

test('shared_world 表含 cast_json 列（迁移 v11）', () => {
  const cols = dbMod.dbAll<{ name: string }>('PRAGMA table_info(shared_world)');
  const names = cols.map((c) => c.name);
  assert.ok(names.includes('cast_json'), `shared_world 应有 cast_json 列，实际列：${names.join(', ')}`);
});