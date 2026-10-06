// T03 伴侣域回归：攻略状态机 / initPanels 幂等 + 主女友零变化 / dedupe_hash 防重复 /
// 好感闭环只经 applyRelationshipDelta / optOut 无亲密无主动 / age<18 双拦 / 调度钩子零侵入。
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-companion-domain-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const ctxMod = await import('../src/lib/companion-context.ts');
const companionMod = await import('../src/lib/companion.ts');
const pursuitMod = await import('../src/lib/pursuit.ts');
const relationsMod = await import('../src/lib/companion-relations.ts');
const genMod = await import('../src/lib/candidate-gen.ts');
const relMod = await import('../src/lib/relationship.ts');
const hintsMod = await import('../src/lib/response-hints.ts');

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
const { dbGet, dbRun, getCounter, DEFAULT_USER_ID } = dbMod;

/* ---------------------- 工具 ---------------------- */
function count(table: string, companionId: number): number {
  const r = dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE companion_id = ?`, companionId);
  return Number(r?.c ?? 0);
}

function setRelationship(id: number, patch: Partial<{ intimacy: number; trust: number; conflict_state: string; emotional_balance: number }>): void {
  withCompanion(id, () => {
    const s = relMod.getRelationshipState();
    if (patch.intimacy !== undefined) s.intimacy = patch.intimacy;
    if (patch.trust !== undefined) s.trust = patch.trust;
    if (patch.conflict_state !== undefined) s.conflict_state = patch.conflict_state;
    if (patch.emotional_balance !== undefined) s.emotional_balance = patch.emotional_balance;
    relMod.saveRelationshipState(s);
  });
}

function readIntimacy(id: number): number {
  return withCompanion(id, () => Number(relMod.getRelationshipState().intimacy));
}

/* ================================================================== */
/* 1. 攻略状态机：主线迁移                                              */
/* ================================================================== */
test('攻略状态机：stranger → acquaintance → ambiguous → pursuing → girlfriend', () => {
  const created = companionMod.createCompanion({ name: '状态机甲', age: 24 });
  assert.equal(created.ok, true);
  assert.ok(created.ok);
  const id = created.companion.id;
  assert.equal(created.companion.status, 'stranger');

  // stranger → acquaintance：turn>=1 且 intimacy>=5
  setRelationship(id, { intimacy: 5 });
  let r = pursuitMod.checkAdvance(id, 1);
  assert.equal(r?.status, 'acquaintance');

  // acquaintance → ambiguous：intimacy>=20 且无 open conflict
  setRelationship(id, { intimacy: 20, conflict_state: 'none' });
  r = pursuitMod.checkAdvance(id, 2);
  assert.equal(r?.status, 'ambiguous');

  // ambiguous → pursuing：intimacy>=40 且 attraction>=30 且已选攻略
  setRelationship(id, { intimacy: 40 });
  dbRun('UPDATE companions SET pursue_opt_in = 1, attraction = 30 WHERE id = ?', id);
  r = pursuitMod.checkAdvance(id, 3);
  assert.equal(r?.status, 'pursuing');

  // pursuing → girlfriend：仅在达标 + 用户确认（resolveConfession）时发生
  setRelationship(id, { intimacy: 60, trust: 50 });
  dbRun('UPDATE companions SET attraction = 50 WHERE id = ?', id);
  const conf = pursuitMod.resolveConfession(id);
  assert.equal(conf.accepted, true);
  assert.equal(conf.status, 'girlfriend');
  assert.equal(pursuitMod.statusOf(id), 'girlfriend');
});

/* ================================================================== */
/* 2. 被拒 / 冷却 / 永久关闭                                            */
/* ================================================================== */
test('攻略状态机：表白被拒进入 24h 冷却；累计 3 次永久关闭并移出主列表', () => {
  const created = companionMod.createCompanion({ name: '状态机乙', age: 26, pursue: true });
  assert.ok(created.ok);
  const id = created.companion.id;

  // 条件未达标 → 被拒（冷却 + reject_count++）
  setRelationship(id, { intimacy: 10, trust: 10 });
  const c1 = pursuitMod.resolveConfession(id);
  assert.equal(c1.accepted, false);
  assert.equal(c1.status, 'rejected');
  assert.equal(c1.reject_count, 1);
  assert.equal(pursuitMod.inCooldown(id), true, '应处于冷却期');
  assert.equal(pursuitMod.canConfess(id), false, '冷却期屏蔽表白');

  // 冷却期内再表白 → 语义错误码
  const c2 = pursuitMod.resolveConfession(id);
  assert.equal(c2.accepted, false);
  assert.equal(c2.code, 'PURSUIT_REJECTED_COOLDOWN');

  // 累计到 3 次 → closed
  pursuitMod.reject(id, '第二次');
  const c3 = pursuitMod.reject(id, '第三次');
  assert.equal(c3.reject_count, 3);
  assert.equal(c3.closed, true);
  assert.equal(pursuitMod.statusOf(id), 'closed');
  const row = companionMod.getCompanion(id);
  assert.ok(row?.closed_at, 'closed_at 应被写入');

  // 已关闭 → 移出主列表（roster 的 closed 分组）
  const roster = companionMod.listRoster();
  assert.ok(roster.closed.some((e) => e.id === id), 'closed 伴侣应进入 closed 分组');
  assert.ok(!roster.pursuing.some((e) => e.id === id), 'closed 伴侣不应出现在主列表');
});

test('攻略状态机：冷却结束后 rejected → acquaintance（可再接触）', () => {
  const created = companionMod.createCompanion({ name: '状态机丙', age: 27, pursue: true });
  assert.ok(created.ok);
  const id = created.companion.id;
  pursuitMod.reject(id, '表白未达标');
  assert.equal(pursuitMod.statusOf(id), 'rejected');

  // 把冷却截止时间改到过去 → 视为冷却已过
  dbRun('UPDATE companions SET cooldown_until = ? WHERE id = ?', new Date(Date.now() - 3600000).toISOString(), id);
  assert.equal(pursuitMod.recooldownElapsed(id), true);
  const r = pursuitMod.checkAdvance(id, 1);
  assert.equal(r?.status, 'acquaintance');
});

/* ================================================================== */
/* 3. initPanels 幂等 + 主女友各表零变化                                */
/* ================================================================== */
test('initPanels：幂等补种全套空面板，且主女友各表零变化', () => {
  const C1_TABLES = [
    'relationship_state',
    'attachment_state',
    'personality_state',
    'personas',
    'agent_health',
    'agent_profile',
    'shared_world',
    'intimacy_state',
    'messages',
    'memories',
  ] as const;
  const before1: Record<string, number> = {};
  for (const t of C1_TABLES) before1[t] = count(t, 1);

  const created = companionMod.createCompanion({ name: '面板丁', age: 28 });
  assert.ok(created.ok);
  const id = created.companion.id;

  // 面板已建：relationship_state=1 / attachment_state=1 / personality_state=6 / personas=1
  assert.equal(count('relationship_state', id), 1);
  assert.equal(count('attachment_state', id), 1);
  assert.equal(count('personality_state', id), 6);
  assert.equal(count('personas', id), 1);

  // 幂等：重复调用不产生重复行、不覆盖已有数据
  const intimacyBefore = readIntimacy(id);
  companionMod.initPanels(id);
  companionMod.initPanels(id);
  assert.equal(count('relationship_state', id), 1, '重复调用不产生重复 relationship_state');
  assert.equal(count('attachment_state', id), 1);
  assert.equal(count('personality_state', id), 6);
  assert.equal(count('personas', id), 1);
  assert.equal(readIntimacy(id), intimacyBefore, '不覆盖已有关系数值');

  // 主女友各表零变化
  for (const t of C1_TABLES) {
    assert.equal(count(t, 1), before1[t], `主女友表 ${t} 行数不应变化`);
  }
});

/* ================================================================== */
/* 4. dedupe_hash 防重复                                               */
/* ================================================================== */
test('dedupe_hash：归一化后同名同身份不重复生成候选人', async () => {
  assert.equal(genMod.dedupeHash(' 林 夏 ', '书店 店员', '黑发'), genMod.dedupeHash('林 夏', '书店 店员', '黑发'));

  const first = await genMod.generateCandidate({ forceTemplate: true, seed: 'fixed-seed-001' });
  assert.equal(first.ok, true);
  assert.ok(first.ok);
  const name = first.draft.name;
  // 产出的候选人应出现在「待处理发现区」
  assert.ok(
    companionMod.listRoster().pending.some((e) => e.id === first.row.id),
    '新候选人应出现在 roster.pending 发现区'
  );

  // 同一 seed（模板 + RNG 可复现）→ 同名同身份 → 判重
  const second = await genMod.generateCandidate({ forceTemplate: true, seed: 'fixed-seed-001' });
  assert.equal(second.ok, false);
  assert.ok(!second.ok);
  assert.equal(second.code, 'DUPLICATE');

  // 库里只有一条该 hash 的记录
  const hash = genMod.dedupeHash(first.draft.name, first.draft.identity, first.draft.portrait_desc);
  const n = dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM companions WHERE dedupe_hash = ?', hash);
  assert.equal(Number(n?.c ?? 0), 1, `候选人 ${name} 只应存在一条`);

  // 模板兜底恒成年
  const draft = genMod.templateDraft(genMod.mulberry32(42), 'seed-x');
  assert.ok(draft.age >= 18, '模板候选人必须成年');
  // RNG 可复现
  const a = genMod.templateDraft(genMod.mulberry32(7), 's');
  const b = genMod.templateDraft(genMod.mulberry32(7), 's');
  assert.deepEqual(a, b, '同一种子的模板草稿应完全一致');
});

/* ================================================================== */
/* 5. 好感闭环只经 applyRelationshipDelta                               */
/* ================================================================== */
test('伴侣关系：applyDelta 触发好感闭环且不直接改 emotional_balance（无双计）', () => {
  const a = companionMod.createCompanion({ name: '关系甲', age: 24 });
  const b = companionMod.createCompanion({ name: '关系乙', age: 25 });
  assert.ok(a.ok && b.ok);
  const aId = a.companion.id;
  const bId = b.companion.id;

  const balBefore = withCompanion(aId, () => Number(relMod.getRelationshipState().emotional_balance));
  const intiBefore = readIntimacy(aId);
  const logsBefore = Number(
    dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM relationship_logs WHERE companion_id = ? AND reason = '伴侣关系变化'", aId)?.c ?? 0
  );

  const res = relationsMod.applyDelta(aId, bId, 50, '测试结盟');
  assert.equal(res.value, 50);
  assert.equal(res.state, 'ally');
  assert.equal(relationsMod.getRelation(aId, bId)?.value, 50, '关系值应落库');

  // 好感变化：经 applyRelationshipDelta（写关系日志，reason='伴侣关系变化'）
  assert.ok(readIntimacy(aId) > intiBefore, '联盟应使她对用户好感小幅上升');
  const logsAfter = Number(
    dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM relationship_logs WHERE companion_id = ? AND reason = '伴侣关系变化'", aId)?.c ?? 0
  );
  assert.ok(logsAfter > logsBefore, '好感闭环必须经 applyRelationshipDelta（留下伴侣关系变化日志）');

  // 关键：绝不直接改 emotional_balance（余额唯一记账点是 addBankEntry）
  assert.equal(
    withCompanion(aId, () => Number(relMod.getRelationshipState().emotional_balance)),
    balBefore,
    'companion-relations 不得改动 emotional_balance'
  );

  // toAffectionDelta 确定性纯函数
  assert.deepEqual(relationsMod.toAffectionDelta(50, 5), relationsMod.toAffectionDelta(50, 5));
  const up = relationsMod.toAffectionDelta(50, 5);
  assert.ok(up.a > 0 && up.b > 0);
  const down = relationsMod.toAffectionDelta(-50, -5);
  assert.ok(down.a < 0 && down.b < 0);
  assert.deepEqual(relationsMod.toAffectionDelta(0, 0), { a: 0, b: 0 });
});

/* ================================================================== */
/* 6. optOut：保留为认识的人、无亲密、无主动                            */
/* ================================================================== */
test('optOut（暂不）：保留为认识的人，pursue_opt_in=0、无亲密、无主动', () => {
  const created = companionMod.createCompanion({ name: '暂不戊', age: 23, pursue: true });
  assert.ok(created.ok);
  const id = created.companion.id;
  assert.equal(companionMod.getCompanion(id)?.pursue_opt_in, 1);

  const r = companionMod.optOut(id);
  assert.equal(r.ok, true);
  assert.equal(companionMod.getCompanion(id)?.pursue_opt_in, 0);
  assert.equal(companionMod.getCompanion(id)?.status, 'acquaintance');
  assert.equal(companionMod.getCompanion(id)?.is_discovered, 1, '仍是通讯录里认识的人');

  // 无亲密：好感仍为 0；无主动：非女友（不参与主动消息推送）
  assert.equal(readIntimacy(id), 0, '暂不后不应产生亲密/好感');
  assert.notEqual(companionMod.getCompanion(id)?.status, 'girlfriend');
  assert.equal(pursuitMod.canConfess(id), false, '暂不后不具备表白资格');
});

/* ================================================================== */
/* 7. age<18 双拦                                                      */
/* ================================================================== */
test('18+ 双拦：应用层拒绝（AGE_RESTRICTED）+ DB CHECK(age>=18)', () => {
  // 应用层
  const bad = companionMod.createCompanion({ name: '未成年', age: 17 });
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok);
  assert.equal(bad.code, 'AGE_RESTRICTED');
  const n = dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM companions WHERE name = ?', '未成年');
  assert.equal(Number(n?.c ?? 0), 0, '被应用层拒绝的未成年角色不应落库');

  // DB 层（绕过应用层直插 → CHECK 约束拒绝）
  assert.throws(
    () =>
      dbRun(
        `INSERT INTO companions (user_id, name, age, gender, status, created_at, updated_at)
         VALUES (?, ?, 17, 'female', 'stranger', ?, ?)`,
        DEFAULT_USER_ID,
        '未成年DB',
        new Date().toISOString(),
        new Date().toISOString()
      ),
    /CHECK|constraint/i,
    'DB 层 CHECK(age>=18) 必须拒绝未成年'
  );
});

/* ================================================================== */
/* 8. 调度钩子：单女友默认流程零行为变化                                 */
/* ================================================================== */
test('调度钩子：主女友零侵入；攻略中伴侣每 5 回合触发一次检查', () => {
  // 主女友（primary）→ 直接跳过，不写任何计数
  const skip = hintsMod.noteTurnAndMaybeCheck(1);
  assert.equal(skip.skipped, true);
  assert.equal(skip.ran, false);

  // 已晋升女友也跳过
  const gf = companionMod.createCompanion({ name: '女友己', age: 25 });
  assert.ok(gf.ok);
  companionMod.promote(gf.companion.id);
  const gfTick = hintsMod.noteTurnAndMaybeCheck(gf.companion.id);
  assert.equal(gfTick.skipped, true);

  // 攻略中伴侣：复用引擎维护的私有回合计数（ck('turn_count') = 'turn_count#c{id}'），每 5 回合触发一次
  const p = companionMod.createCompanion({ name: '攻略庚', age: 24, pursue: true });
  assert.ok(p.ok);
  const id = p.companion.id;
  const key = `${hintsMod.TURN_COUNTER}#c${id}`;
  let ran = 0;
  let lastTurn = 0;
  for (let i = 1; i <= 5; i++) {
    // 模拟引擎 commitTurn：为该伴侣的私有回合计数 +1（bumpCounter 接收原始键，命名空间由调用方叠加）
    dbMod.bumpCounter(key);
    const t = hintsMod.noteTurnAndMaybeCheck(id);
    lastTurn = t.turn;
    if (t.ran) ran++;
  }
  assert.equal(lastTurn, 5, '私有回合计数应递增到 5');
  assert.equal(ran, 1, '第 5 回合应触发一次攻略检查');
  assert.equal(getCounter(key), 5);
});
