// 记忆管理 + 可控事件核心路径回归
// 覆盖：createMemoryManually/listMemories/deleteMemory、registerOngoingEvent/getActiveEvent/endOngoingEvent
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
// 说明：本用例只走纯本地 DB 路径，不触发需要联网的 embedding（createMemoryManually 不等价于 addMemory）
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-memory-events-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const memMod = await import('../src/lib/memory.ts');
const lifeMod = await import('../src/lib/life.ts');

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

test('createMemoryManually → listMemories 可见；deleteMemory → 消失', () => {
  const id = memMod.createMemoryManually('semantic', '她喜欢在雨天听歌', 7, '温柔');
  assert.ok(id > 0, '应返回新建记忆的自增 id');

  const found = memMod.listMemories().find((m) => m.id === id);
  assert.ok(found, '新建记忆应出现在列表中');
  assert.equal(found!.content, '她喜欢在雨天听歌');
  assert.equal(found!.type, 'semantic');
  assert.equal(found!.importance, 7);
  assert.equal(found!.status, 'active');

  assert.equal(memMod.deleteMemory(id), true, '删除应返回 true');
  assert.equal(memMod.listMemories().find((m) => m.id === id), undefined, '删除后不应再出现');
});

test('registerOngoingEvent → getActiveEvent 返回该事件；endOngoingEvent → getActiveEvent 为 null', () => {
  const evt = lifeMod.registerOngoingEvent('洗澡');
  assert.ok(evt, '应注册成功');
  assert.equal(evt!.activity, '洗澡');
  assert.equal(evt!.ended_at, null, '新事件应为未结束状态');

  const active = lifeMod.getActiveEvent();
  assert.ok(active, '应有进行中的事件');
  assert.equal(active!.id, evt!.id, 'getActiveEvent 应返回刚注册的事件');

  const ended = lifeMod.endOngoingEvent('测试结束');
  assert.ok(ended);
  assert.equal(ended!.id, evt!.id);
  assert.equal(lifeMod.getActiveEvent(), null, '结束后不应再有进行中的事件');
});