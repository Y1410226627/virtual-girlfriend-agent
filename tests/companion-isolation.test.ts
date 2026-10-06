// 双伴侣隔离验证（T02 DoD）：companion 1 与 companion 2 分别写消息 / 记忆 / 关系状态 / 情感银行，
// 在对方上下文里互查必须零串扰；缺省（无上下文）回落主女友 companion 1。
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-isolation-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const ctxMod = await import('../src/lib/companion-context.ts');
const engineMod = await import('../src/lib/engine.ts');
const memMod = await import('../src/lib/memory.ts');
const relMod = await import('../src/lib/relationship.ts');
const bankMod = await import('../src/lib/emotionalBank.ts');
const { nowIso } = await import('../src/lib/utils.ts');

dbMod.getDb(); // 触发建库（迁移 + 种子：companion 1 = 主女友）

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

const { withCompanion } = ctxMod;
const { dbRun, DEFAULT_USER_ID } = dbMod;

/** 播种一个非主女友 companion 2：数据行 + 状态行全套。
 *  说明：正式的「认识→攻略→确立关系」初始化属于 T03 范围；这里按 db.ts seed() 的口径
 *  给 c2 播种同等的状态行（personas / relationship_state / attachment_state / personality_state），
 *  仅用于验证隔离语义本身。 */
function seedCompanion2(): void {
  const now = nowIso();
  dbRun(
    `INSERT INTO companions (id, user_id, name, age, is_primary, status, created_at, updated_at)
     VALUES (2, ?, '二号', 25, 0, 'girlfriend', ?, ?)`,
    DEFAULT_USER_ID, now, now
  );
  dbRun(
    'INSERT OR IGNORE INTO personas (id, user_id, agent_name, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)',
    2, DEFAULT_USER_ID, now, now
  );
  dbRun(
    `UPDATE personas SET companion_id = 2 WHERE id = 2`
  );
  dbRun(
    `INSERT OR IGNORE INTO relationship_state
     (companion_id, user_id, intimacy, trust, mood, stage, stage_entered_at, stage_cap_since, pending_stage_confirm,
      pending_relationship_talk, conflict_state, last_conflict_at, nickname, anniversary,
      last_interaction_at, streak_days, emotional_balance, repair_credit, unresolved_tension, updated_at)
     VALUES (2, ?, 0, 0, '好奇', 0, ?, NULL, 0, 0, 'none', NULL, NULL, NULL, NULL, 0, 0, 0, 0, ?)`,
    DEFAULT_USER_ID, now, now
  );
  dbRun(
    'INSERT OR IGNORE INTO attachment_state (companion_id, user_id, anxiety, avoidance, style, updated_at) VALUES (2, ?, 30, 30, ?, ?)',
    DEFAULT_USER_ID, 'secure', now
  );
  for (const d of ['warmth', 'playfulness', 'romance', 'directness', 'independence', 'emotional_intensity']) {
    dbRun(
      `INSERT OR IGNORE INTO personality_state (companion_id, user_id, dimension, value, solidified, last_adjusted_turn, updated_at)
       VALUES (2, ?, ?, 50, 0, 0, ?)`,
      DEFAULT_USER_ID, d, now
    );
  }
}
seedCompanion2();

/* ---------------------- 1. 消息隔离 ---------------------- */
test('消息：c1 与 c2 各写一条，双方列表互不可见；缺省上下文 = c1', () => {
  const id1 = withCompanion(1, () => engineMod.insertMessage('user', '主女友的消息'));
  const id2 = withCompanion(2, () => engineMod.insertMessage('user', '二号的消息'));
  assert.notEqual(id1, id2);

  const c1Ids = withCompanion(1, () => engineMod.listMessages({ limit: 100 })).map((m) => m.id);
  const c2Ids = withCompanion(2, () => engineMod.listMessages({ limit: 100 })).map((m) => m.id);
  assert.ok(c1Ids.includes(id1) && !c1Ids.includes(id2), 'c1 只能看到自己的消息');
  assert.ok(c2Ids.includes(id2) && !c2Ids.includes(id1), 'c2 只能看到自己的消息');

  // 缺省上下文（未包 withCompanion）回落主女友 1
  const defaultIds = engineMod.listMessages({ limit: 100 }).map((m) => m.id);
  assert.ok(defaultIds.includes(id1) && !defaultIds.includes(id2), '缺省 = companion 1');
  assert.equal(withCompanion(2, () => engineMod.messageCount()), 1);
  assert.equal(withCompanion(1, () => engineMod.messageCount()), 1);
});

/* ---------------------- 2. 关系状态隔离 ---------------------- */
test('关系状态：c1 与 c2 的数值各自独立演进', () => {
  // c1 拉到 80
  withCompanion(1, () => {
    const s = relMod.getRelationshipState();
    s.intimacy = 80;
    relMod.saveRelationshipState(s);
  });
  // c2 此时读到的仍是自己的初始值（不是 80）
  const c2Initial = withCompanion(2, () => relMod.getRelationshipState().intimacy);
  assert.notEqual(Number(c2Initial), 80, 'c2 未被 c1 的写入串扰');
  // c2 拉到 55
  withCompanion(2, () => {
    const s = relMod.getRelationshipState();
    s.intimacy = 55;
    relMod.saveRelationshipState(s);
  });
  assert.equal(withCompanion(1, () => Number(relMod.getRelationshipState().intimacy)), 80);
  assert.equal(withCompanion(2, () => Number(relMod.getRelationshipState().intimacy)), 55);
});

/* ---------------------- 3. 情感银行隔离 ---------------------- */
test('情感银行：c1 记 +5、c2 记 -3，余额互不影响', () => {
  withCompanion(1, () => bankMod.addBankEntry(5, 'warm', '测试：c1 加分'));
  withCompanion(2, () => bankMod.addBankEntry(-3, 'cold', '测试：c2 减分'));
  const b1 = withCompanion(1, () => Number(relMod.getRelationshipState().emotional_balance));
  const b2 = withCompanion(2, () => Number(relMod.getRelationshipState().emotional_balance));
  assert.equal(b1, 5, 'c1 余额只含自己的记账');
  assert.equal(b2, -3, 'c2 余额只含自己的记账');
});

/* ---------------------- 4. 记忆隔离 ---------------------- */
test('记忆：c1 与 c2 各写一条，listMemories 互不可见', () => {
  dbRun(
    `INSERT INTO memories (companion_id, user_id, type, content, importance, status, created_at)
     VALUES (1, ?, 'fact', 'c1 的记忆：喜欢猫', 5, 'active', ?)`,
    DEFAULT_USER_ID,
    nowIso()
  );
  dbRun(
    `INSERT INTO memories (companion_id, user_id, type, content, importance, status, created_at)
     VALUES (2, ?, 'fact', 'c2 的记忆：喜欢狗', 5, 'active', ?)`,
    DEFAULT_USER_ID,
    nowIso()
  );
  const c1Contents = withCompanion(1, () => memMod.listMemories({ limit: 100 })).map((m) => String(m.content));
  const c2Contents = withCompanion(2, () => memMod.listMemories({ limit: 100 })).map((m) => String(m.content));
  assert.ok(c1Contents.some((c) => c.includes('c1 的记忆')) && !c1Contents.some((c) => c.includes('c2 的记忆')), 'c1 只见自己的记忆');
  assert.ok(c2Contents.some((c) => c.includes('c2 的记忆')) && !c2Contents.some((c) => c.includes('c1 的记忆')), 'c2 只见自己的记忆');
});

/* ---------------------- 5. 嵌套上下文不串味 ---------------------- */
test('上下文：withCompanion 嵌套与退出后正确恢复', () => {
  assert.equal(ctxMod.cId(), 1, '裸调用 = 主女友');
  withCompanion(2, () => {
    assert.equal(ctxMod.cId(), 2);
    withCompanion(1, () => {
      assert.equal(ctxMod.cId(), 1, '嵌套内切换成功');
    });
    assert.equal(ctxMod.cId(), 2, '内层退出后恢复外层');
  });
  assert.equal(ctxMod.cId(), 1, '全部退出后恢复主女友');
});

/* ---------------------- 6. UPDATE 路径隔离（显式 cId 的语句） ---------------------- */
test('UPDATE 路径：c2 的人设字段修改不影响 c1', () => {
  withCompanion(2, () => relMod.setPersonaField('self_story', '二号的故事'));
  withCompanion(1, () => {
    const p = relMod.getPersona();
    assert.notEqual(String(p?.self_story || ''), '二号的故事', 'c1 的 self_story 未被 c2 修改');
  });
  assert.equal(withCompanion(2, () => String(relMod.getPersona()?.self_story || '')), '二号的故事');
});
