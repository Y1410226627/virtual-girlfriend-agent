// v16 同场感知回归：
//  ① 迁移 v16：groups.origin / groups.host_companion_id / memories.source_group_id 列齐备；
//  ② detectCohabitants：同地点女友互为在场 / cast 天然在场 / closed 排除 / 排除自己；
//  ③ ensurePresenceGroup：cast「见面即认识」（直接 acquaintance + initPanels，跳过候选待处理）、
//     开局上下文 system 消息、幂等复用同一群；
//  ④ endPresenceGroup + writeSharedMemories：每人一行、companion_id 各自、互不串读、每群每人只写一条；
//  ⑤ 资格放开：acquaintance 可入群；stranger → PERMISSION_NOT_ACQUAINTED；closed → COMPANION_CLOSED；
//  ⑥ 独立性回归：A 改名后 B 的 persona/设置/关系数值零变化；B 的记忆不含 A 的私域记忆。
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-presence-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const ctxMod = await import('../src/lib/companion-context.ts');
const companionMod = await import('../src/lib/companion.ts');
const groupMod = await import('../src/lib/group.ts');
const activityMod = await import('../src/lib/activity.ts');
const presenceMod = await import('../src/lib/presence.ts');
const lifeMod = await import('../src/lib/life.ts');
const relationshipMod = await import('../src/lib/relationship.ts');

dbMod.getDb(); // 触发建库（迁移 + 种子：companion 1 = 主女友）

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

const { dbAll, dbGet, dbRun, DEFAULT_USER_ID } = dbMod;
const { withCompanion } = ctxMod;

/* ---------------------- 工具 ---------------------- */
function makeGirlfriend(name: string): number {
  const r = companionMod.createCompanion({ name, age: 24 });
  if (!r.ok) throw new Error(`createCompanion 失败：${name}`);
  companionMod.promote(r.companion.id);
  return r.companion.id;
}

/** 直接置某伴侣为 closed（模拟「已关闭」） */
function closeCompanion(id: number): void {
  dbRun("UPDATE companions SET status = 'closed', closed_at = ? WHERE id = ?", new Date().toISOString(), id);
}

/** 设置某伴侣的所在地点（agent_location.current_location，显式 companion_id 的 UPDATE） */
function setLocation(id: number, loc: string): void {
  dbRun('UPDATE agent_location SET current_location = ?, updated_at = ? WHERE companion_id = ?', loc, new Date().toISOString(), id);
}

function insertMessage(companionId: number, role: 'user' | 'assistant', content: string): void {
  dbRun(
    'INSERT INTO messages (companion_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    companionId,
    DEFAULT_USER_ID,
    role,
    content,
    new Date().toISOString()
  );
}

/* ================================================================== */
/* 1. 迁移 v16                                                          */
/* ================================================================== */
test('迁移 v16：schema_migrations 共 16 条；groups/memories 新列齐备', () => {
  const versions = dbAll<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version').map((r) => Number(r.version));
  assert.equal(versions.length, 16);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

  const groupCols = dbAll<{ name: string }>('PRAGMA table_info(groups)').map((c) => c.name);
  assert.ok(groupCols.includes('origin'), 'groups 应有 origin 列');
  assert.ok(groupCols.includes('host_companion_id'), 'groups 应有 host_companion_id 列');

  const memCols = dbAll<{ name: string }>('PRAGMA table_info(memories)').map((c) => c.name);
  assert.ok(memCols.includes('source_group_id'), 'memories 应有 source_group_id 列');

  const idx = dbAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_groups_origin','idx_memories_source_group')");
  assert.equal(idx.length, 2, 'v16 的两个索引应存在');
});

/* ================================================================== */
/* 2. detectCohabitants                                                 */
/* ================================================================== */
test('detectCohabitants：同地点女友互为在场；cast 天然在场；closed 与自己排除', () => {
  withCompanion(1, () => lifeMod.ensureLife()); // 播种主女友的默认 cast（小夏/阿悦）
  setLocation(1, '家');
  const b = makeGirlfriend('同场乙');
  setLocation(b, '家');

  let list = presenceMod.detectCohabitants(1);
  assert.ok(list.some((p) => p.kind === 'companion' && p.id === b), '同地点的其他女友应在场');
  assert.ok(list.some((p) => p.kind === 'cast' && p.name === '小夏'), '室友（cast）应天然在场');
  assert.ok(!list.some((p) => p.kind === 'companion' && p.id === 1), '不得把 host 自己算作在场者');

  setLocation(b, '公司');
  list = presenceMod.detectCohabitants(1);
  assert.ok(!list.some((p) => p.kind === 'companion' && p.id === b), '不同地点的女友不在场');
  assert.ok(list.some((p) => p.kind === 'cast' && p.name === '小夏'), 'cast 不受地点过滤（简化假设：在家即在）');

  const c = makeGirlfriend('同场丙');
  setLocation(c, '家');
  closeCompanion(c);
  list = presenceMod.detectCohabitants(1);
  assert.ok(!list.some((p) => p.kind === 'companion' && p.id === c), 'closed 的伴侣必须被排除');

  // 反向：host 换到 b 的地点 → 互为在场（对称性）
  setLocation(1, '公司');
  const fromB = presenceMod.detectCohabitants(b);
  assert.ok(fromB.some((p) => p.kind === 'companion' && p.id === 1), '从 b 的视角也应看到 host');
  setLocation(1, '家');
});

/* ================================================================== */
/* 3. ensurePresenceGroup（cast 见面即认识）                             */
/* ================================================================== */
test('ensurePresenceGroup：cast 成员自动升格 acquaintance + initPanels + 开局上下文 + 幂等复用', async () => {
  // host 先有私聊历史 → 开局上下文应引用它
  insertMessage(1, 'user', '今晚想吃火锅');
  insertMessage(1, 'assistant', '那我先点外卖啦');

  const r1 = await presenceMod.ensurePresenceGroup(1, { kind: 'cast', name: '小夏', role: '室友' });
  assert.ok(r1.ok, `ensurePresenceGroup 应成功：${r1.error}`);
  assert.equal(r1.created, true);
  const gid1 = r1.groupId!;
  const mid = r1.memberId!;

  // 群行：origin / host_companion_id / topic
  const g = dbGet<{ origin: string; host_companion_id: number; status: string; topic: string; name: string }>(
    'SELECT origin, host_companion_id, status, topic, name FROM groups WHERE id = ?',
    gid1
  );
  assert.equal(g?.origin, 'presence');
  assert.equal(Number(g?.host_companion_id), 1);
  assert.equal(g?.status, 'active');
  assert.equal(g?.topic, '线下共处');
  assert.ok(g?.name.includes('小夏'), `群名应包含成员名，实际：${g?.name}`);

  // 成员 = host + 小夏
  const members = groupMod.listMemberIds(gid1).sort((x, y) => x - y);
  assert.deepEqual(members, [1, mid].sort((x, y) => x - y));

  // 见面即认识：跳过候选待处理，直接 acquaintance + 已发现
  const row = dbGet<{ status: string; is_discovered: number; pending: number }>(
    'SELECT status, is_discovered, pending FROM companions WHERE id = ?',
    mid
  );
  assert.equal(row?.status, 'acquaintance');
  assert.equal(Number(row?.is_discovered), 1);
  assert.equal(Number(row?.pending), 0);

  // initPanels：状态行齐备（可聊天）
  assert.equal(companionMod.hasPanels(mid), true, '升格后应有完整面板');

  // 开局上下文：system 群消息引用 host 的私聊
  const sys = dbGet<{ content: string }>(
    "SELECT content FROM group_messages WHERE group_id = ? AND speaker_type = 'system' ORDER BY id ASC LIMIT 1",
    gid1
  );
  assert.ok(sys, '应有开局上下文 system 消息');
  assert.ok(sys!.content.includes('今晚想吃火锅'), `开局上下文应引用私聊内容，实际：${sys?.content}`);
  assert.ok(sys!.content.includes('此前你们在旁边看到/听到了一些'));

  // 幂等：重复调用复用同一群、不重复生成角色
  const r2 = await presenceMod.ensurePresenceGroup(1, { kind: 'cast', name: '小夏' });
  assert.ok(r2.ok);
  assert.equal(r2.created, false, '第二次应复用既有共处群');
  assert.equal(r2.groupId, gid1);
  assert.equal(r2.memberId, mid);
  const dup = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM companions WHERE name = '小夏' AND status != 'closed'");
  assert.equal(Number(dup?.c), 1, '同名 cast 不得重复生成伴侣行');
  assert.equal(groupMod.listMemberIds(gid1).length, 2, '复用时成员数不变');
});

/* ================================================================== */
/* 4. endPresenceGroup + writeSharedMemories（每群每人一条、互不串读）    */
/* ================================================================== */
test('endPresenceGroup：置 ended + 写共域记忆（每人一行、companion_id 各自、重复调用不重复）', async () => {
  const gid = presenceMod.activePresenceGroupId(1);
  assert.ok(gid, '应存在 active 的共处群');
  const members = groupMod.listMemberIds(gid!);
  assert.equal(members.length, 2);

  const end = await presenceMod.endPresenceGroup(gid!);
  assert.ok(end.ok);
  assert.equal(end.memoriesWritten, 2, 'host + cast 各写一条');
  assert.equal(dbGet<{ status: string }>('SELECT status FROM groups WHERE id = ?', gid!)?.status, 'ended');

  const rows = dbAll<{ id: number; companion_id: number; type: string; content: string; source_group_id: number }>(
    'SELECT id, companion_id, type, content, source_group_id FROM memories WHERE source_group_id = ?',
    gid!
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => Number(r.companion_id)).sort((x, y) => x - y),
    members.sort((x, y) => x - y),
    '每名成员各一行，companion_id 各自'
  );
  for (const r of rows) {
    assert.equal(r.type, 'shared');
    assert.ok(r.content.includes('【共处】'), `内容应为共处摘要：${r.content}`);
  }
  // 视角：host 的记忆里是「小夏」，cast 的记忆里是 host（各自视角，内容互斥）
  const hostRow = rows.find((r) => Number(r.companion_id) === 1)!;
  const castRow = rows.find((r) => Number(r.companion_id) !== 1)!;
  assert.ok(hostRow.content.includes('小夏'));
  assert.ok(!hostRow.content.includes('【共处】和「她」'), 'host 的记忆不得以自己为视角对象');
  assert.ok(castRow.content !== hostRow.content, '两行内容应不同（各自视角）');

  // 幂等：重复调用不再新增
  const again = await presenceMod.endPresenceGroup(gid!);
  assert.ok(again.ok);
  assert.equal(again.memoriesWritten, 0, '每群每人只写一条，重复调用不得重复');
  const recount = dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM memories WHERE source_group_id = ?', gid!);
  assert.equal(Number(recount?.c), 2);
});

test('writeSharedMemories：多人群摘要统计 + A/B 互不串读（B 的记忆不含 A 的私域记忆与 A 的共处行）', async () => {
  const a = makeGirlfriend('共忆甲');
  const b = makeGirlfriend('共忆乙');
  const g = groupMod.createGroup('共忆群', null, [a, b]);
  assert.ok(g.ok && g.group);
  const gid = Number(g.group!.id);

  // 群消息：用户 2 句 + A 发言 1 条 + B reaction 1 条
  const now = new Date().toISOString();
  dbRun(
    "INSERT INTO group_messages (group_id, companion_id, speaker_type, speaker_name, content, round, created_at) VALUES (?, NULL, 'user', '我', '周末去爬山怎么样', 1, ?)",
    gid, now
  );
  dbRun(
    "INSERT INTO group_messages (group_id, companion_id, speaker_type, speaker_name, content, round, created_at) VALUES (?, NULL, 'user', '我', '记得带防晒', 1, ?)",
    gid, now
  );
  dbRun(
    `INSERT INTO group_messages (group_id, companion_id, speaker_type, speaker_name, content, round, created_at) VALUES (?, ?, 'companion', '共忆甲', '好呀我带水果', 1, ?)`,
    gid, a, now
  );
  dbRun(
    `INSERT INTO group_messages (group_id, companion_id, speaker_type, speaker_name, content, reaction, round, created_at) VALUES (?, ?, 'reaction', '共忆乙', '👍', '👍', 1, ?)`,
    gid, b, now
  );

  // A 的私域记忆（绝不允许进入 B 的任何记忆行 / prompt 行）
  withCompanion(a, () => {
    dbRun(
      `INSERT INTO memories (companion_id, user_id, type, content, importance, status, created_at, access_count)
       VALUES (?, ?, 'fact', 'A的私房钱藏在床底第三块地板下', 9, 'active', ?, 0)`,
      a, DEFAULT_USER_ID, now
    );
  });

  const written = groupMod.writeSharedMemories(gid);
  assert.equal(written, 2, 'A、B 各写一条');

  const rows = dbAll<{ companion_id: number; content: string }>(
    'SELECT companion_id, content FROM memories WHERE source_group_id = ? ORDER BY companion_id',
    gid
  );
  assert.equal(rows.length, 2);
  const aRow = rows.find((r) => Number(r.companion_id) === a)!;
  const bRow = rows.find((r) => Number(r.companion_id) === b)!;
  assert.ok(aRow, 'A 应有自己的共处记忆行');
  assert.ok(bRow, 'B 应有自己的共处记忆行');
  // 摘要统计：你说 2 句、互动 2 次、最近聊到「记得带防晒」
  for (const r of rows) {
    assert.ok(r.content.includes('你说 2 句'), `应统计用户句数：${r.content}`);
    assert.ok(r.content.includes('互动 2 次'), `应统计互动次数：${r.content}`);
    assert.ok(r.content.includes('记得带防晒'), `应包含最近用户消息：${r.content}`);
  }
  assert.ok(aRow.content.includes('共忆乙') && !aRow.content.includes('共忆甲'), 'A 的视角是「和 B 在一起」');
  assert.ok(bRow.content.includes('共忆甲') && !bRow.content.includes('共忆乙'), 'B 的视角是「和 A 在一起」');

  // 互不串读：memoryLinesFor（含 shared）只取自己作用域的行
  const linesB = groupMod.memoryLinesFor(b);
  assert.ok(linesB.some((l) => l.includes('【共处】') && l.includes('共忆甲')), 'B 应能想起共处的事');
  assert.ok(!linesB.some((l) => l.includes('私房钱')), 'B 的记忆行绝不含 A 的私域记忆');
  assert.ok(!linesB.some((l) => l.includes('和「共忆乙」')), 'B 的记忆行不含 A 视角的共处行');
  const linesA = groupMod.memoryLinesFor(a);
  assert.ok(linesA.some((l) => l.includes('【共处】') && l.includes('共忆乙')), 'A 应能想起共处的事');
  assert.ok(!linesA.some((l) => l.includes('和「共忆甲」')), 'A 的记忆行不含 B 视角的共处行');

  // 私域记忆仍在 A 自己的作用域里（没被共处写操作动过）
  const aPrivate = withCompanion(a, () => groupMod.memoryLinesFor(a));
  assert.ok(aPrivate.some((l) => l.includes('私房钱')), 'A 自己仍记得私域记忆');
});

/* ================================================================== */
/* 5. 伴侣成员入群 + 群资格放开                                          */
/* ================================================================== */
test('ensurePresenceGroup：伴侣成员直接建群；上一群 ended 后新共处开启新群', async () => {
  const c = makeGirlfriend('共处丙');
  const r = await presenceMod.ensurePresenceGroup(1, { kind: 'companion', id: c });
  assert.ok(r.ok, `应成功：${r.error}`);
  assert.equal(r.created, true, '上一共处群已 ended → 应新建');
  const members = groupMod.listMemberIds(r.groupId!).sort((x, y) => x - y);
  assert.deepEqual(members, [1, c].sort((x, y) => x - y));

  // 复用：同一 host 再拉别人进共处 → 复用 active 群并把新成员补进群
  const c2 = makeGirlfriend('共处丁');
  const r2 = await presenceMod.ensurePresenceGroup(1, { kind: 'companion', id: c2 });
  assert.ok(r2.ok);
  assert.equal(r2.created, false);
  assert.equal(r2.groupId, r.groupId);
  assert.ok(groupMod.listMemberIds(r.groupId!).includes(c2), '复用时应把新成员补进群');
});

test('资格放开：acquaintance 可入群；stranger → PERMISSION_NOT_ACQUAINTED(400)；closed → COMPANION_CLOSED(410)', () => {
  const gf = makeGirlfriend('资格女友');
  const acq = companionMod.createCompanion({ name: '资格熟人', age: 26, pursue: true });
  assert.ok(acq.ok);
  const acqId = acq.companion.id;
  assert.equal(dbGet<{ status: string }>('SELECT status FROM companions WHERE id = ?', acqId)?.status, 'acquaintance');

  // acquaintance 可入群
  const okGroup = groupMod.createGroup('资格群', null, [gf, acqId]);
  assert.ok(okGroup.ok, `acquaintance 应可入群：${okGroup.error}`);

  // stranger → 新错误码
  const stranger = companionMod.createCompanion({ name: '资格陌生人', age: 25 });
  assert.ok(stranger.ok);
  const sid = stranger.companion.id;
  const bad = groupMod.createGroup('含陌生人', null, [gf, sid]);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'PERMISSION_NOT_ACQUAINTED');
  assert.equal(groupMod.groupHttpStatus(bad.code), 400);

  // 改群加人同样校验
  const badAdd = groupMod.updateGroup(okGroup.group!.id, { add: [sid] });
  assert.equal(badAdd.ok, false);
  assert.equal(badAdd.code, 'PERMISSION_NOT_ACQUAINTED');

  // closed → COMPANION_CLOSED
  const closed = companionMod.createCompanion({ name: '资格关闭', age: 27 });
  assert.ok(closed.ok);
  closeCompanion(closed.companion.id);
  const badClosed = groupMod.createGroup('含关闭', null, [gf, closed.companion.id]);
  assert.equal(badClosed.ok, false);
  assert.equal(badClosed.code, 'COMPANION_CLOSED');
  assert.equal(groupMod.groupHttpStatus(badClosed.code), 410);

  // 错误码映射（companion.ts httpStatusForCode）
  assert.equal(companionMod.httpStatusForCode('PERMISSION_NOT_ACQUAINTED'), 400);
  assert.equal(companionMod.httpStatusForCode('COMPANION_CLOSED'), 410);
});

test('活动资格同步放开：acquaintance 可参加；stranger → PERMISSION_NOT_ACQUAINTED', () => {
  const gf = makeGirlfriend('活动女友');
  const acq = companionMod.createCompanion({ name: '活动熟人', age: 26, pursue: true });
  assert.ok(acq.ok);
  const stranger = companionMod.createCompanion({ name: '活动陌生人', age: 25 });
  assert.ok(stranger.ok);

  const okAct = activityMod.createActivity({ kind: 'online', templateKey: 'nighttalk', memberIds: [gf, acq.companion.id] });
  assert.ok(okAct.ok, `acquaintance 应可参加活动：${okAct.error}`);

  const badAct = activityMod.createActivity({ kind: 'online', templateKey: 'nighttalk', memberIds: [gf, stranger.companion.id] });
  assert.equal(badAct.ok, false);
  assert.equal(badAct.code, 'PERMISSION_NOT_ACQUAINTED');
  assert.equal(activityMod.activityHttpStatus(badAct.code), 400);
});

/* ================================================================== */
/* 6. 独立性回归（用户硬要求）                                          */
/* ================================================================== */
test('独立性回归：A set_persona 改名后，B 的 persona/设置/关系数值零变化', async () => {
  const a = makeGirlfriend('改名甲');
  const b = makeGirlfriend('改名乙');
  withCompanion(b, () => lifeMod.ensureLife());

  const snapshot = (id: number) =>
    withCompanion(id, () => ({
      persona: relationshipMod.getPersona(),
      rel: {
        intimacy: relationshipMod.getRelationshipState().intimacy,
        trust: relationshipMod.getRelationshipState().trust,
        mood: relationshipMod.getRelationshipState().mood,
        stage: relationshipMod.getRelationshipState().stage,
      },
    }));

  const beforeA = snapshot(a);
  const beforeB = snapshot(b);

  // A 改名（setPersonaField 白名单列）
  withCompanion(a, () => relationshipMod.setPersonaField('agent_name', '甲的新名字'));

  // A 的共处写操作：共处群 + 共域记忆（走 A 作用域的写入路径）
  await withCompanion(a, async () => {
    const r = await presenceMod.ensurePresenceGroup(a, { kind: 'cast', name: '甲的闺蜜', role: '闺蜜' });
    assert.ok(r.ok);
    await presenceMod.endPresenceGroup(r.groupId!);
  });

  const afterB = snapshot(b);
  assert.deepEqual(afterB, beforeB, 'B 的 persona/关系数值必须零变化');
  assert.notDeepEqual(snapshot(a), beforeA, 'A 自己的 persona 应已变化（对照组）');

  // B 的记忆行不含 A 的任何记忆（含共处记忆）
  const bNames = withCompanion(b, () => groupMod.memoryLinesFor(b));
  assert.ok(!bNames.some((l) => l.includes('甲的闺蜜')), 'B 不得读到 A 的私域/共处记忆');
  const bShared = dbAll<{ c: number }>(
    'SELECT COUNT(*) AS c FROM memories WHERE companion_id = ? AND source_group_id IS NOT NULL',
    b
  );
  assert.equal(Number(bShared[0]?.c), 0, 'B 名下不应有 A 的共处群记忆行');
});
