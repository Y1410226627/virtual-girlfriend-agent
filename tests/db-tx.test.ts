// tx() 可重入行为回归：嵌套提交、内层回滚不影响外层、外层回滚全部撤销
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-tx-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
dbMod.getDb(); // 触发建库（counters 表由迁移创建）

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

test('嵌套 tx 正常提交：内外层写入都生效', () => {
  dbMod.tx(() => {
    dbMod.setCounter('tx_outer', 1);
    dbMod.tx(() => {
      dbMod.setCounter('tx_inner', 2);
    });
  });
  assert.equal(dbMod.getCounter('tx_outer'), 1);
  assert.equal(dbMod.getCounter('tx_inner'), 2);
});

test('内层抛错只回滚内层：外层已写数据保留、可继续提交', () => {
  dbMod.tx(() => {
    dbMod.setCounter('tx_a', 1);
    assert.throws(() =>
      dbMod.tx(() => {
        dbMod.setCounter('tx_b', 5);
        throw new Error('内层失败');
      })
    );
    // 内层回滚后外层仍可继续写
    dbMod.setCounter('tx_c', 3);
  });
  assert.equal(dbMod.getCounter('tx_a'), 1, '外层在内层之前写入的数据应保留');
  assert.equal(dbMod.getCounter('tx_b'), 0, '内层写入应被回滚');
  assert.equal(dbMod.getCounter('tx_c'), 3, '内层回滚后外层继续写入应生效');
});

test('外层抛错：全部写入回滚', () => {
  assert.throws(() =>
    dbMod.tx(() => {
      dbMod.setCounter('tx_x', 9);
      dbMod.tx(() => {
        dbMod.setCounter('tx_y', 8);
      });
      throw new Error('外层失败');
    })
  );
  assert.equal(dbMod.getCounter('tx_x'), 0, '外层写入应被回滚');
  assert.equal(dbMod.getCounter('tx_y'), 0, '嵌套写入应随外层一起回滚');
});