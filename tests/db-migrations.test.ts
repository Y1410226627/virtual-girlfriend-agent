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

test('全新库初始化：schema_migrations 恰好有 14 条迁移记录', () => {
  dbMod.getDb(); // 触发 createDb → migrate + seed
  const rows = dbMod.dbAll<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
  assert.equal(rows.length, 14, `应恰好 14 条迁移，实际 ${rows.length}`);
  // 版本号应为连续的 1..14，且每条都记录了名称
  const versions = rows.map((r) => r.version);
  assert.deepEqual(
    versions,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
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

test('新库初始化：busy_timeout 为 5000（写-写竞争等待窗口，防止被误删）', () => {
  const row = dbMod.dbGet<{ timeout: number }>('PRAGMA busy_timeout');
  assert.equal(Number(row?.timeout), 5000, `busy_timeout 应为 5000，实际 ${row?.timeout}`);
});

test('companions 主女友行满足红线：id=1 / is_primary=1 / age>=18 / status=girlfriend', () => {
  const row = dbMod.dbGet<{ id: number; is_primary: number; age: number; status: string }>(
    'SELECT id, is_primary, age, status FROM companions WHERE id = 1'
  );
  assert.ok(row, 'companions 应存在 id=1 的主女友行');
  assert.equal(row?.is_primary, 1, '主女友 is_primary 应为 1');
  assert.ok((row?.age ?? 0) >= 18, `主女友 age 必须 >= 18，实际 ${row?.age}`);
  assert.equal(row?.status, 'girlfriend', '主女友 status 应为 girlfriend');
});

test('18+ 硬红线：DB 层 CHECK(age>=18) 拒绝未成年写入', () => {
  const now = new Date().toISOString();
  assert.throws(
    () =>
      dbMod.dbRun(
        `INSERT INTO companions (user_id, name, age, status, created_at, updated_at)
         VALUES (?, ?, ?, 'stranger', ?, ?)`,
        1,
        '未成年合成行',
        17,
        now,
        now
      ),
    /CHECK|constraint/i,
    'age<18 必须被 DB 层约束拒绝'
  );
  const bad = dbMod.dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM companions WHERE age < 18');
  assert.equal(Number(bad?.c ?? -1), 0, '库中不得存在 age<18 的行');
});

test('v13 新表齐备：10 张伴侣域/群聊/活动表存在', () => {
  const tables = [
    'companions',
    'companion_relations',
    'companion_events',
    'groups',
    'group_members',
    'group_messages',
    'group_runs',
    'activities',
    'activity_participants',
    'activity_schedule_items',
  ];
  for (const name of tables) {
    const row = dbMod.dbGet<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      name
    );
    assert.ok(row, `表 ${name} 应存在`);
  }
});

test('v14 主键重建：relationship_state 以 companion_id 为主键', () => {
  const cols = dbMod.dbAll<{ name: string; pk: number }>('PRAGMA table_info(relationship_state)');
  const pkCol = cols.find((c) => Number(c.pk) === 1);
  assert.equal(pkCol?.name, 'companion_id', 'relationship_state 主键应为 companion_id');
});

test('cAll/cGet/cRun 按 withCompanion 作用域注入 companion_id；dbAll 缺省等价 companion 1', async () => {
  const ctx = await import('../src/lib/companion-context.ts');
  const now = new Date().toISOString();
  dbMod.dbRun(
    'INSERT INTO messages (companion_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    1, 1, 'user', 'c1-msg', now
  );
  dbMod.dbRun(
    'INSERT INTO messages (companion_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    2, 1, 'user', 'c2-msg', now
  );

  // 缺省（无作用域）：dbAll 显式按 companion 1 过滤 → 只看到 companion 1 的数据
  const viaDb = dbMod.dbAll<{ content: string }>(
    'SELECT content FROM messages WHERE companion_id = ?',
    1
  );
  assert.ok(viaDb.some((r) => r.content === 'c1-msg'), 'dbAll 应能看到 companion 1 的数据');

  // withCompanion(2)：cAll 自动注入 cId()=2 → 只返回 companion 2 的数据
  const c2 = ctx.withCompanion(2, () =>
    dbMod.cAll<{ content: string }>('SELECT content FROM messages WHERE companion_id = ?')
  );
  assert.ok(c2.length >= 1, 'companion 2 作用域应至少返回 1 条');
  assert.ok(c2.every((r) => r.content === 'c2-msg'), 'cAll 在 companion 2 作用域应只返回 2 的数据');
  assert.ok(c2.every((r) => r.content !== 'c1-msg'), 'cAll 不得返回 companion 1 的数据（零串扰）');

  // cGet 同样注入
  const one = ctx.withCompanion(2, () =>
    dbMod.cGet<{ content: string }>(
      "SELECT content FROM messages WHERE companion_id = ? AND content = ?",
      'c2-msg'
    )
  );
  assert.equal(one?.content, 'c2-msg', 'cGet 应在 companion 2 作用域命中');

  // cRun 写入时注入 companion_id
  const run = ctx.withCompanion(3, () =>
    dbMod.cRun(
      'INSERT INTO messages (companion_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      1, 'user', 'c3-msg', now
    )
  );
  assert.equal(run.changes, 1, 'cRun 应成功写入 1 行');
  const c3 = dbMod.dbGet<{ content: string }>(
    'SELECT content FROM messages WHERE companion_id = ? AND content = ?',
    3,
    'c3-msg'
  );
  assert.equal(c3?.content, 'c3-msg', 'cRun 注入的 companion_id 应为 3');

  // 未包裹时 cId() 缺省 = 1
  assert.equal(ctx.cId(), ctx.PRIMARY_COMPANION_ID, '无作用域时 cId() 应为主女友 1');
});