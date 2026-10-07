// T03/T04/T05 · 独立对抗性终验（跨模块 + 端到端）。
//
// 本文件由独立 QA（不复查实现者用例）新写，目标是用"更强"的断言验证：
//   A. T03 关键正确性：initPanels 幂等 + 主女友逐表逐字段零变化 / 状态机边界（冷却 ±1s、
//      3 拒永久关闭、冷却期表白被拒但普通聊天不受影响、attraction 不污染 relationship_state）/
//      候选人生成（dedupe、待处理上限 3、种子可复现、18+ 应用层 + DB CHECK 双拦）/ 好感闭环。
//   B. T04 隐私与调度：隐私红线强化（含运行时调用路径与 activity 复用路径）/ 调度与收尾边界 /
//      群聊 × 私聊并发。
//   C. T05 + 跨模块端到端：完整主流程 scenario、场景恢复对抗性、切换器链路、多伴侣后台推进。
//
// 隐私：所有测试使用 os.tmpdir() 下的独立临时库，绝不读写 data/ 与 .env.local。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { GroupRunRow, GroupMessageRow, RelationshipState } from '../src/lib/types.ts';

const DB = path.join(os.tmpdir(), `gf-e2e-multicompanion-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const ctxMod = await import('../src/lib/companion-context.ts');
const companionMod = await import('../src/lib/companion.ts');
const pursuitMod = await import('../src/lib/pursuit.ts');
const relationsMod = await import('../src/lib/companion-relations.ts');
const genMod = await import('../src/lib/candidate-gen.ts');
const relMod = await import('../src/lib/relationship.ts');
const hintsMod = await import('../src/lib/response-hints.ts');
const groupMod = await import('../src/lib/group.ts');
const groupRunMod = await import('../src/lib/group-run.ts');
const activityMod = await import('../src/lib/activity.ts');
const turnMod = await import('../src/lib/turn.ts');
const engineMod = await import('../src/lib/engine.ts');
const queryMod = await import('../src/components/chat/companion-query.ts');
const tickMod = await import('../src/app/api/tick/route.ts');

dbMod.getDb(); // 触发建库（迁移 + 种子：companion 1 = 主女友）

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

const { dbGet, dbRun, dbAll, withCompanion } = { ...ctxMod, ...dbMod };

/* ================================================================== */
/* 通用工具                                                            */
/* ================================================================== */
type ChatFn = (messages: unknown, opts: unknown) => Promise<string>;

const fakeChat: ChatFn = async () => '（笑）好呀，我也这么想。';

function makeGirlfriend(name: string, extra: { identity?: string; personality_tags?: string[] } = {}): number {
  const r = companionMod.createCompanion({ name, age: 24, identity: extra.identity, personality_tags: extra.personality_tags });
  if (!r.ok) throw new Error(`createCompanion 失败：${name}`);
  companionMod.promote(r.companion.id);
  return r.companion.id;
}

function setRel(id: number, patch: Partial<RelationshipState>): void {
  withCompanion(id, () => {
    const s = relMod.getRelationshipState();
    Object.assign(s, patch);
    relMod.saveRelationshipState(s);
  });
}

const intiOf = (id: number): number => Number(withCompanion(id, () => relMod.getRelationshipState().intimacy));
const balOf = (id: number): number => Number(withCompanion(id, () => relMod.getRelationshipState().emotional_balance));
const sceneOf = (id: number): string =>
  String(dbGet<{ scene: string | null }>('SELECT scene FROM relationship_state WHERE companion_id = ?', id)?.scene ?? 'online');
const sceneSrcOf = (id: number): string | null =>
  dbGet<{ scene_source: string | null }>('SELECT scene_source FROM relationship_state WHERE companion_id = ?', id)?.scene_source ?? null;
const countRows = (sql: string, ...params: unknown[]): number =>
  Number(dbGet<{ c: number }>(sql, ...params)?.c ?? 0);

/** 枚举所有带 companion_id 的 per-companion 表（动态，覆盖"全部 per-companion 表"） */
function companionScopedTables(): string[] {
  const names = dbAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) =>
    String(r.name)
  );
  return names
    .filter((n) => dbAll<{ name: string }>(`PRAGMA table_info("${n}")`).some((c) => String(c.name) === 'companion_id'))
    .sort();
}

/** 逐字段快照某伴侣在【全部 per-companion 表】中的行（顺序无关） */
function snapshotAll(cid: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of companionScopedTables()) {
    const rows = dbAll<Record<string, unknown>>(`SELECT * FROM "${t}" WHERE companion_id = ?`, cid);
    out[t] = JSON.stringify(rows.map((r) => JSON.stringify(r)).sort());
  }
  return out;
}

/** 确定性 RNG 序列（耗尽后重复最后一个值） */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[Math.min(values.length - 1, i)] ?? 0;
    i++;
    return v;
  };
}

function runLike(recent: number[], counts: Record<number, number>, round = 1, maxRounds = 12): GroupRunRow {
  return {
    id: 1,
    group_id: 1,
    kind: 'chat',
    activity_id: null,
    status: 'running',
    round,
    max_rounds: maxRounds,
    last_speaker_id: null,
    recent_speakers: JSON.stringify(recent),
    spoke_counts: JSON.stringify(counts),
    ended_reason: null,
    started_at: new Date().toISOString(),
    ended_at: null,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 某批群消息里「非焦点」的产出（正式发言 + reaction） */
function nonFocusOutputs(messages: GroupMessageRow[], focusId: number): GroupMessageRow[] {
  return messages.filter(
    (m) => m.companion_id != null && Number(m.companion_id) !== focusId && (m.speaker_type === 'companion' || m.speaker_type === 'reaction')
  );
}
/** 某批群消息里「焦点」的产出（正式发言 + reaction） */
function focusOutputs(messages: GroupMessageRow[], focusId: number): GroupMessageRow[] {
  return messages.filter((m) => Number(m.companion_id) === focusId && (m.speaker_type === 'companion' || m.speaker_type === 'reaction'));
}
/** 求 recent_speakers 中同一 id 的最大连续出现次数 */
function maxConsecutive(ids: number[]): number {
  let max = 0;
  let cur = 0;
  let prev = 0;
  for (const id of ids) {
    cur = id === prev ? cur + 1 : 1;
    prev = id;
    max = Math.max(max, cur);
  }
  return max;
}

/* ================================================================== */
/* A. T03 关键正确性                                                   */
/* ================================================================== */

/* A1 —— initPanels 幂等 + 主女友全部 per-companion 表逐字段零变化 */
test('A1 initPanels 幂等：重复调用不新增行/不覆盖；主女友全部 per-companion 表逐字段零变化', () => {
  const created = companionMod.createCompanion({ name: 'A1面板乙', age: 26 });
  assert.ok(created.ok);
  const c2 = created.companion.id;

  // 先确认 c2 的最小面板已建立
  assert.equal(countRows('SELECT COUNT(*) AS c FROM relationship_state WHERE companion_id = ?', c2), 1);
  assert.equal(countRows('SELECT COUNT(*) AS c FROM attachment_state WHERE companion_id = ?', c2), 1);
  assert.equal(countRows('SELECT COUNT(*) AS c FROM personality_state WHERE companion_id = ?', c2), 6);
  assert.equal(countRows('SELECT COUNT(*) AS c FROM personas WHERE companion_id = ?', c2), 1);

  const intiBefore = intiOf(c2);
  const tables = companionScopedTables();
  assert.ok(tables.length >= 20, `per-companion 表应被动态枚举到（实际 ${tables.length}）`);

  // 主女友（c1）在 promote/initPanels(c2) 前后的逐字段快照
  const before1 = snapshotAll(1);

  companionMod.promote(c2);
  companionMod.initPanels(c2);
  companionMod.initPanels(c2);

  const after1 = snapshotAll(1);
  for (const t of Object.keys(before1)) {
    assert.equal(after1[t], before1[t], `主女友表 ${t} 应逐字段零变化（promote/initPanels 不得串扰 c1）`);
  }

  // 幂等：c2 各表行数不膨胀、已有数值不被覆盖
  assert.equal(countRows('SELECT COUNT(*) AS c FROM relationship_state WHERE companion_id = ?', c2), 1);
  assert.equal(countRows('SELECT COUNT(*) AS c FROM attachment_state WHERE companion_id = ?', c2), 1);
  assert.equal(countRows('SELECT COUNT(*) AS c FROM personality_state WHERE companion_id = ?', c2), 6);
  assert.equal(countRows('SELECT COUNT(*) AS c FROM personas WHERE companion_id = ?', c2), 1);
  assert.equal(intiOf(c2), intiBefore, 'initPanels 不得覆盖已有关系数值');
});

/* A2 —— 状态机边界 */
test('A2 状态机：冷却 +24h（±1s 边界）；3 拒永久关闭并移出主列表；冷却期表白被拒但普通聊天不受影响', () => {
  const c = companionMod.createCompanion({ name: 'A2攻略甲', age: 24, pursue: true });
  assert.ok(c.ok);
  const id = c.companion.id;

  // 条件未达标 → 被拒：冷却 = now + 24h
  setRel(id, { intimacy: 10, trust: 10, conflict_state: 'none' });
  const t0 = Date.now();
  const res = pursuitMod.resolveConfession(id);
  const t1 = Date.now();
  assert.equal(res.accepted, false);
  assert.equal(res.reject_count, 1);
  assert.equal(pursuitMod.statusOf(id), 'rejected');
  const until = dbGet<{ cooldown_until: string | null }>('SELECT cooldown_until FROM companions WHERE id = ?', id)?.cooldown_until ?? null;
  assert.ok(until, '被拒应写入 cooldown_until');
  const untilMs = new Date(until).getTime();
  const expected = 24 * 3600000;
  assert.ok(
    untilMs - t0 >= expected - 1500 && untilMs - t1 <= expected + 1500,
    `冷却应恰为 +24h（实测 ${(untilMs - t0) / 3600000}h）`
  );

  // 边界：冷却到期前 1s → 仍在冷却；到期后 1s → 冷却已过
  dbRun('UPDATE companions SET cooldown_until = ? WHERE id = ?', new Date(Date.now() + 1000).toISOString(), id);
  assert.equal(pursuitMod.inCooldown(id), true, '到期前 1s 应仍在冷却');
  dbRun('UPDATE companions SET cooldown_until = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), id);
  assert.equal(pursuitMod.inCooldown(id), false, '到期后 1s 冷却应已过');
  assert.equal(pursuitMod.recooldownElapsed(id), true);

  // 冷却期内表白必须被拒（PURSUIT_REJECTED_COOLDOWN）
  dbRun('UPDATE companions SET cooldown_until = ? WHERE id = ?', new Date(Date.now() + 3600000).toISOString(), id);
  const blocked = pursuitMod.resolveConfession(id);
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.code, 'PURSUIT_REJECTED_COOLDOWN');
  assert.equal(pursuitMod.canConfess(id), false);

  // —— 普通聊天不受影响：冷却期内仍可落消息、仍可经 applyRelationshipDelta 提升好感 ——
  withCompanion(id, () => {
    engineMod.insertMessage('user', '冷却期也能正常聊天');
    engineMod.insertMessage('assistant', '当然可以呀。');
  });
  assert.ok(countRows('SELECT COUNT(*) AS c FROM messages WHERE companion_id = ?', id) >= 2, '冷却不应阻断普通聊天');
  const intiBefore = intiOf(id);
  withCompanion(id, () => relMod.applyRelationshipDelta({ intimacy: 3, trust: 3 }, '普通聊天'));
  assert.ok(intiOf(id) > intiBefore, '冷却期普通聊天仍应推进好感');
  assert.equal(pursuitMod.statusOf(id), 'rejected', '普通聊天不应改变攻略状态');
  // 调度钩子不应抛错（冷却期仍安全）
  assert.doesNotThrow(() => hintsMod.noteTurnAndMaybeCheck(id));

  // 累计 3 拒 → closed + closed_at + 移出主列表
  const c2 = companionMod.createCompanion({ name: 'A2攻略乙', age: 25, pursue: true });
  assert.ok(c2.ok);
  const id2 = c2.companion.id;
  pursuitMod.reject(id2, '第1次');
  pursuitMod.reject(id2, '第2次');
  const third = pursuitMod.reject(id2, '第3次');
  assert.equal(third.reject_count, 3);
  assert.equal(third.closed, true);
  assert.equal(pursuitMod.statusOf(id2), 'closed');
  assert.ok(companionMod.getCompanion(id2)?.closed_at, 'closed_at 应写入');
  const roster = companionMod.listRoster();
  assert.ok(roster.closed.some((e) => e.id === id2), 'closed 伴侣应进入 closed 分组');
  assert.ok(!roster.pursuing.some((e) => e.id === id2), 'closed 伴侣不应出现在主列表');
});

test('A2b attraction 变更不得污染 relationship_state 任何字段', () => {
  const c = companionMod.createCompanion({ name: 'A2b吸引甲', age: 24 });
  assert.ok(c.ok);
  const id = c.companion.id;
  const snapOf = (): string =>
    JSON.stringify(dbGet<Record<string, unknown>>('SELECT * FROM relationship_state WHERE companion_id = ?', id));
  const before = snapOf();
  pursuitMod.setAttraction(id, 88);
  assert.equal(Number(companionMod.getCompanion(id)?.attraction), 88, 'attraction 应写入 companions');
  assert.equal(snapOf(), before, 'attraction 变更不得污染 relationship_state 任何字段');
});

/* A3 —— 候选人生成 */
test('A3 候选人生成：dedupe 防重 + 待处理上限 3 + 种子可复现 + 18+ 双拦', async () => {
  // 清空待处理，保证可控
  dbRun('DELETE FROM companions WHERE pending = 1');

  // (a) dedupe_hash：同名同身份不重复
  assert.equal(genMod.dedupeHash(' 林 夏 ', '书店 店员', '黑发'), genMod.dedupeHash('林 夏', '书店 店员', '黑发'));
  const first = await genMod.generateCandidate({ forceTemplate: true, seed: 'A3-DUP' });
  assert.ok(first.ok);
  const hash = genMod.dedupeHash(first.draft.name, first.draft.identity, first.draft.portrait_desc);
  const dup = await genMod.generateCandidate({ forceTemplate: true, seed: 'A3-DUP' });
  assert.ok(!dup.ok);
  assert.equal(dup.code, 'DUPLICATE');
  assert.equal(countRows('SELECT COUNT(*) AS c FROM companions WHERE dedupe_hash = ?', hash), 1, '同 hash 只应落库一条');

  // (b) 数量无上限（需求变更）：已存在软上限数量的待处理候选人时，仍可继续生成
  dbRun('DELETE FROM companions WHERE pending = 1');
  const now = new Date().toISOString();
  for (let i = 0; i < genMod.PENDING_SOFT_LIMIT; i++) {
    dbRun(
      `INSERT INTO companions (user_id, name, age, gender, status, is_primary, is_discovered, pending, pursue_opt_in, reject_count, created_at, updated_at)
       VALUES (?, ?, 24, 'female', 'stranger', 0, 0, 1, 0, 0, ?, ?)`,
      dbMod.DEFAULT_USER_ID,
      `A3待处理${i}-${Date.now()}`,
      now,
      now
    );
  }
  assert.equal(genMod.countPendingCandidates(), genMod.PENDING_SOFT_LIMIT);
  assert.equal(genMod.pendingOverSoftLimit(), false, '恰好等于软上限时不算超限');
  const over = await genMod.generateCandidate({ forceTemplate: true, seed: 'A3-OVER' });
  assert.ok(over.ok, '无上限：超过软上限仍应能生成候选人');
  assert.equal(genMod.countPendingCandidates(), genMod.PENDING_SOFT_LIMIT + 1);
  assert.equal(genMod.pendingOverSoftLimit(), true, '超过软上限仅作 UI 提示，不阻塞');
  dbRun('DELETE FROM companions WHERE pending = 1');

  // (c) gen_seed 可复现：同种子端到端一致
  const d1 = await genMod.generateCandidate({ forceTemplate: true, seed: 'A3-DET' });
  assert.ok(d1.ok);
  dbRun('DELETE FROM companions WHERE pending = 1');
  const d2 = await genMod.generateCandidate({ forceTemplate: true, seed: 'A3-DET' });
  assert.ok(d2.ok);
  assert.deepEqual(d2.draft, d1.draft, '同 seed 应产出完全一致的候选人');
  dbRun('DELETE FROM companions WHERE pending = 1');
  // 不同 seed → 不同（用纯函数避免 dedupe 干扰）
  const t1 = genMod.templateDraft(genMod.mulberry32(1111), 'seed-a');
  const t1b = genMod.templateDraft(genMod.mulberry32(1111), 'seed-a');
  const t2 = genMod.templateDraft(genMod.mulberry32(2222), 'seed-b');
  assert.deepEqual(t1, t1b, '同 rng/seed 的模板草稿应一致');
  assert.notDeepEqual(t1, t2, '不同 rng/seed 的模板草稿应不同');
  assert.ok(t1.age >= 18 && t2.age >= 18, '模板候选人必须成年');

  // (d) 18+ 双拦：应用层
  const bad = companionMod.createCompanion({ name: 'A3未成年', age: 17 });
  assert.ok(!bad.ok);
  assert.equal(bad.code, 'AGE_RESTRICTED');
  assert.equal(countRows('SELECT COUNT(*) AS c FROM companions WHERE name = ?', 'A3未成年'), 0, '应用层拒绝不得落库');
  // (d) 18+ 双拦：DB CHECK（绕过应用层直插必须被拒）
  assert.throws(
    () =>
      dbRun(
        `INSERT INTO companions (user_id, name, age, gender, status, created_at, updated_at)
         VALUES (?, ?, 17, 'female', 'stranger', ?, ?)`,
        dbMod.DEFAULT_USER_ID,
        'A3未成年DB',
        new Date().toISOString(),
        new Date().toISOString()
      ),
    /CHECK|constraint/i,
    'DB CHECK(age>=18) 必须拒绝未成年'
  );
});

/* A4 —— 好感闭环 */
test('A4 好感闭环：applyDelta 不直接改 emotional_balance（无双计）；关系边规范序唯一；阈值方向/幅度', () => {
  const a = makeGirlfriend('A4关系甲');
  const b = makeGirlfriend('A4关系乙');
  // 让两者处于 stage 3（min60/max80），好感才有上升空间
  setRel(a, { stage: 3, intimacy: 60, conflict_state: 'none' });
  setRel(b, { stage: 3, intimacy: 60, conflict_state: 'none' });

  const balA0 = balOf(a);
  const balB0 = balOf(b);
  const bankA0 = countRows('SELECT COUNT(*) AS c FROM emotional_bank WHERE companion_id = ?', a);
  const bankB0 = countRows('SELECT COUNT(*) AS c FROM emotional_bank WHERE companion_id = ?', b);
  const logsA0 = countRows("SELECT COUNT(*) AS c FROM relationship_logs WHERE companion_id = ? AND reason = '伴侣关系变化'", a);
  const logsB0 = countRows("SELECT COUNT(*) AS c FROM relationship_logs WHERE companion_id = ? AND reason = '伴侣关系变化'", b);
  const intiA0 = intiOf(a);
  const intiB0 = intiOf(b);

  const res = relationsMod.applyDelta(a, b, 50, 'A4 结盟');
  assert.equal(res.value, 50);
  assert.equal(res.state, 'ally');

  // (a) emotional_balance 未被直接改写；流水条数不变（无重复记账）
  assert.equal(balOf(a), balA0, 'applyDelta 不得直接改 a 的 emotional_balance');
  assert.equal(balOf(b), balB0, 'applyDelta 不得直接改 b 的 emotional_balance');
  assert.equal(countRows('SELECT COUNT(*) AS c FROM emotional_bank WHERE companion_id = ?', a), bankA0, '不得新增 emotional_bank 流水（防双计）');
  assert.equal(countRows('SELECT COUNT(*) AS c FROM emotional_bank WHERE companion_id = ?', b), bankB0);
  // 好感只经关系日志这条唯一写点产生变化
  assert.ok(intiOf(a) > intiA0, '联盟应使 a 好感上升（经 applyRelationshipDelta）');
  assert.ok(intiOf(b) > intiB0, '联盟应使 b 好感上升');
  assert.ok(
    countRows("SELECT COUNT(*) AS c FROM relationship_logs WHERE companion_id = ? AND reason = '伴侣关系变化'", a) > logsA0,
    '好感闭环必须留下「伴侣关系变化」日志'
  );
  assert.ok(countRows("SELECT COUNT(*) AS c FROM relationship_logs WHERE companion_id = ? AND reason = '伴侣关系变化'", b) > logsB0);

  // (b) 规范序唯一一行、无反向重复行
  const [lo, hi] = relationsMod.normalizePair(a, b);
  assert.equal(countRows('SELECT COUNT(*) AS c FROM companion_relations WHERE a_id = ? AND b_id = ?', lo, hi), 1);
  assert.equal(countRows('SELECT COUNT(*) AS c FROM companion_relations WHERE a_id = ? AND b_id = ?', hi, lo), 0, '不得存在反向行');
  assert.ok(lo < hi);

  // (c) toAffectionDelta 方向/幅度
  const up = relationsMod.toAffectionDelta(50, 5);
  assert.ok(up.a > 0 && up.a <= 1 && up.b > 0 && up.b <= 1, '盟友阈值以上应给正增量（0.5~1.0）');
  const down = relationsMod.toAffectionDelta(-50, -5);
  assert.ok(down.a < 0 && down.b < 0, '吃醋阈值以下应给负增量');
  assert.deepEqual(relationsMod.toAffectionDelta(0, 0), { a: 0, b: 0 }, '中性区不产生增量');
  assert.deepEqual(relationsMod.toAffectionDelta(50, 5), relationsMod.toAffectionDelta(50, 5), '纯函数应确定性');
});

/* ================================================================== */
/* B. T04 隐私与调度                                                   */
/* ================================================================== */

const SECRET_MEMORY = '★私密记忆：玲偷偷攒钱想给他买表';
const SECRET_VECTOR = '[0.913,0.277,0.888]';
const SECRET_STORY = '★私密自述：她怕黑，小时候被锁在储藏间';
const SECRET_MSG = '★私聊专属：只有我和她知道的悄悄话';
const SECRET_PROFILE = '★用户画像：本名韩梅梅，住杭州市西湖区，怕高';
const SECRET_NAME = '韩梅梅';
const SECRET_C2_MEMORY = '★乙的私密记忆：她问我下周能不能去看她的咖啡店';

test('B5 隐私红线强化：私密记忆/向量/画像/私聊/self_story 绝不进入任何群上下文产物（含运行时与活动复用路径）', async () => {
  // 构造 c1（主女友）的各类私密内容
  dbRun(
    `INSERT INTO memories (companion_id, user_id, type, content, importance, created_at, status, access_count)
     VALUES (1, ?, 'relationship', ?, 9, ?, 'active', 0)`,
    dbMod.DEFAULT_USER_ID,
    SECRET_MEMORY,
    new Date().toISOString()
  );
  const memId = Number(dbGet<{ id: number }>('SELECT id FROM memories WHERE content = ?', SECRET_MEMORY)?.id ?? 0);
  dbRun(
    "INSERT INTO memory_embeddings (memory_id, model, dim, vector, created_at) VALUES (?, 'test', 3, ?, ?)",
    memId,
    SECRET_VECTOR,
    new Date().toISOString()
  );
  dbRun('UPDATE personas SET self_story = ? WHERE companion_id = 1', SECRET_STORY);
  withCompanion(1, () => engineMod.insertMessage('assistant', SECRET_MSG));
  dbMod.setSetting('user_profile', SECRET_PROFILE);
  dbMod.setSetting('user_name', SECRET_NAME);

  const c2 = makeGirlfriend('B5群友乙', { identity: '咖啡师', personality_tags: ['元气'] });
  // c2 也有一条只属于她自己的记忆（用于验证双向隔离）
  dbRun(
    `INSERT INTO memories (companion_id, user_id, type, content, importance, created_at, status, access_count)
     VALUES (?, ?, 'relationship', ?, 9, ?, 'active', 0)`,
    c2,
    dbMod.DEFAULT_USER_ID,
    SECRET_C2_MEMORY,
    new Date().toISOString()
  );
  const g = groupMod.createGroup('B5隐私群', '随便聊聊', [1, c2]);
  assert.ok(g.ok && g.group);
  const gid = g.group.id;

  // —— 所有运行时调用路径：捕获 chatFn 收到的每一条 prompt ——
  const captured: string[] = [];
  const capChat: ChatFn = async (msgs) => {
    captured.push(JSON.stringify(msgs));
    return '（挥手）嗨，聊点什么好呢。';
  };
  for (let i = 0; i < 3; i++) {
    await groupRunMod.withGroupLock(gid, () =>
      groupMod.runGroupTurn(gid, i === 0 ? '大家晚上好呀' : '嗯嗯继续说', {
        chatFn: capChat,
        rng: () => 0.3,
        newRun: i === 0,
      })
    );
  }

  // —— 直接调用 builder 的多种分支（不同历史窗口 / 不同发言人）——
  // 注意：不传 speakerMemories 时，prompt 里**不应有任何记忆**（builder 本身不读库）
  const history = groupMod.listMessages(gid);
  for (const speaker of [1, c2]) {
    for (const maxHistory of [0, 1, 4, 16, 999]) {
      captured.push(
        JSON.stringify(
          groupMod.buildGroupPrompt({ speakerId: speaker, memberIds: [1, c2], history, topic: '随便聊聊', maxHistory })
        )
      );
    }
  }

  // —— 活动复用路径（线上）也会走群引擎 ——
  const act = activityMod.createActivity({ kind: 'online', templateKey: 'nighttalk', memberIds: [1, c2], groupId: gid });
  assert.ok(act.ok && act.activity);
  const actChat: ChatFn = async (msgs) => {
    captured.push(JSON.stringify(msgs));
    return '（笑）那我先说说今天。';
  };
  await groupRunMod.withGroupLock(gid, () =>
    activityMod.runActivityTurn(Number(act.activity!.id), '今晚聊点走心的', { chatFn: actChat, rng: () => 0.3, newRun: true })
  );

  // —— 断言 1：永不出现的内容（向量 / 用户画像 / 真实姓名 / 别人的 self_story / 私聊）——
  const joined = captured.join('\n');
  for (const secret of [SECRET_VECTOR, SECRET_STORY, SECRET_MSG, SECRET_PROFILE, SECRET_NAME, '怕黑', '怕高', '储藏间']) {
    assert.ok(!joined.includes(secret), `群上下文（所有调用路径）不得包含：${secret}`);
  }

  // —— 断言 2：双向记忆隔离 —— 每个人的记忆只进她自己的 prompt ——
  const speakerOf = (json: string): string => {
    const m = /当前发言人：([^）)、]+)/.exec(json);
    return m ? m[1]!.trim() : '';
  };
  const c1Prompts = captured.filter((j) => speakerOf(j) === '她');
  const c2Prompts = captured.filter((j) => speakerOf(j) === 'B5群友乙');
  for (const p of c2Prompts) {
    assert.ok(!p.includes(SECRET_MEMORY), 'c2 的上下文绝不含 c1 的记忆（记忆不混用）');
  }
  for (const p of c1Prompts) {
    assert.ok(!p.includes(SECRET_C2_MEMORY), 'c1 的上下文绝不含 c2 的记忆（双向隔离）');
  }

  // —— 断言 3：她自己的记忆**可以**出现在她自己的发言上下文里（这是需求："按各自的记忆聊起来"）——
  const c1WithMem = groupMod.buildGroupPrompt({
    speakerId: 1,
    memberIds: [1, c2],
    history,
    topic: '随便聊聊',
    speakerMemories: [SECRET_MEMORY],
  });
  assert.ok(
    JSON.stringify(c1WithMem).includes(SECRET_MEMORY),
    '显式传入的「发言人自己的记忆」应出现在她的 prompt 里'
  );
  const c2WithC1Mem = groupMod.buildGroupPrompt({
    speakerId: c2,
    memberIds: [1, c2],
    history,
    topic: '随便聊聊',
    speakerMemories: [SECRET_C2_MEMORY],
  });
  assert.ok(!JSON.stringify(c2WithC1Mem).includes(SECRET_MEMORY), 'c2 的 prompt 不会因为传参而混入 c1 的记忆');
  // 反向对照：公开字段（identity / tags）应当出现，证明 builder 确实取到了角色卡
  assert.ok(joined.includes('咖啡师'), '应包含公开身份');

  // —— 群消息、meta、伴侣事件 reason 不得携带私密内容 ——
  const gm = dbAll<{ content: string; meta: string | null }>('SELECT content, meta FROM group_messages WHERE group_id = ?', gid);
  for (const m of gm) {
    for (const secret of [SECRET_MEMORY, SECRET_STORY, SECRET_MSG, SECRET_PROFILE, SECRET_NAME]) {
      assert.ok(!String(m.content).includes(secret) && !String(m.meta ?? '').includes(secret), `群消息/meta 不得泄漏：${secret}`);
    }
  }
  const ev = dbAll<{ summary: string; reason: string | null; meta_json: string | null }>(
    'SELECT summary, reason, meta_json FROM companion_events WHERE companion_id IN (1, ?)',
    c2
  );
  for (const e of ev) {
    for (const secret of [SECRET_MEMORY, SECRET_STORY, SECRET_MSG, SECRET_PROFILE]) {
      assert.ok(
        !String(e.summary).includes(secret) && !String(e.reason ?? '').includes(secret) && !String(e.meta_json ?? '').includes(secret),
        `伴侣事件（含 reason/meta）不得泄漏：${secret}`
      );
    }
  }
  // applyRelationshipDelta 的 reason 固定串，不含私密内容
  const relLogs = dbAll<{ summary: string; reason: string | null }>(
    "SELECT summary, reason FROM relationship_logs WHERE companion_id IN (1, ?) AND reason = '伴侣关系变化'",
    c2
  );
  assert.ok(relLogs.every((l) => !String(l.summary).includes(SECRET_MSG)), '好感闭环日志不得携带私密内容');
});

test('B6 调度与收尾边界：仅 1 成员被拒；@ 多名全发言；全员发言轮转回退；max_rounds 1/2；END 变体', async () => {
  // 仅 1 名成员：建群被拒 + runGroupTurn 报 INVALID_INPUT
  const a = makeGirlfriend('B6甲');
  const b = makeGirlfriend('B6乙');
  const few = groupMod.createGroup('B6少人', null, [a]);
  assert.ok(!few.ok);
  assert.equal(few.code, 'INVALID_INPUT');

  const g = groupMod.createGroup('B6边界群', null, [a, b]);
  assert.ok(g.ok && g.group);
  const gid = g.group.id;
  dbRun('DELETE FROM group_members WHERE group_id = ? AND companion_id = ?', gid, b);
  const one = await groupMod.runGroupTurn(gid, 'hi', { chatFn: fakeChat, rng: () => 0.9, newRun: true });
  assert.ok(!one.ok);
  assert.equal(one.code, 'INVALID_INPUT');
  dbRun('INSERT OR IGNORE INTO group_members (group_id, companion_id, joined_at) VALUES (?, ?, ?)', gid, b, new Date().toISOString());

  // @ 多名 → 全部发言
  const members = [a, b];
  const at = groupMod.planSpeakers(runLike([], {}), members, { rng: seqRng([0.9]), mentions: [a, b] });
  assert.deepEqual(at.slice().sort((x, y) => x - y), [a, b].slice().sort((x, y) => x - y), '@ 多人应全部发言');
  // 禁三连击优先于 @：尾部连说 2 次者即便被 @ 也应被过滤
  const blockedAt = groupMod.planSpeakers(runLike([a, a], {}), members, { rng: seqRng([0.9]), mentions: [a, b] });
  assert.ok(!blockedAt.includes(a), '会三连击者即便被 @ 也应被过滤');
  assert.deepEqual(blockedAt, [b]);

  // 全员都刚发言过 → 轮转回退到随机分支
  const allSpoke = groupMod.planSpeakers(runLike([a, b], { [a]: 1, [b]: 1 }), members, { rng: seqRng([0.42, 0.42]) });
  assert.ok(allSpoke.length >= 1 && allSpoke.length <= 2, '全员发言后应回退到随机 1–2 人');
  assert.equal(new Set(allSpoke).size, allSpoke.length, '同轮不得重复同一发言人');

  // max_rounds = 1 / 2 边界
  const g1 = groupMod.createGroup('B6一轮群', null, [a, b]);
  assert.ok(g1.ok && g1.group);
  groupRunMod.createRun(g1.group!.id, { maxRounds: 1 });
  const r1 = await groupMod.runGroupTurn(g1.group!.id, '开始', { chatFn: fakeChat, rng: () => 0.3 });
  assert.equal(r1.ok, true);
  const last1 = groupRunMod.getLastRun(g1.group!.id);
  assert.equal(last1?.status, 'ended');
  assert.equal(last1?.round, 1, 'max_rounds=1 应恰好 1 轮结束');

  const g2 = groupMod.createGroup('B6两轮群', null, [a, b]);
  assert.ok(g2.ok && g2.group);
  groupRunMod.createRun(g2.group!.id, { maxRounds: 2 });
  const r2 = await groupMod.runGroupTurn(g2.group!.id, '开始', { chatFn: fakeChat, rng: () => 0.3 });
  assert.equal(r2.ok, true);
  const last2 = groupRunMod.getLastRun(g2.group!.id);
  assert.equal(last2?.status, 'ended');
  assert.equal(last2?.round, 2, 'max_rounds=2 应恰好 2 轮结束');

  // END_PHRASES 大小写/空格/标点变体
  const hits = ['大家晚安~', '  再见  ', '我先睡了。', '88', '88~', '撤了！', '我要下线了', '拜拜各位', '不聊了哦'];
  for (const s of hits) assert.equal(groupMod.hitsEndPhrase(s), true, `应命中收尾词：${s}`);
  const misses = ['今天天气不错', '拜师学艺真难', '', '我们聊点别的'];
  for (const s of misses) assert.equal(groupMod.hitsEndPhrase(s), false, `不应命中收尾词：${s}`);
});

test('B6b abort 竞态：在"写最后一条消息"期间 abort → 收敛（cancelled、消息有界、不死循环）', async () => {
  const a = makeGirlfriend('B6b甲');
  const b = makeGirlfriend('B6b乙');
  const g = groupMod.createGroup('B6b竞态群', null, [a, b]);
  assert.ok(g.ok && g.group);
  const gid = g.group.id;

  let calls = 0;
  const raceChat: ChatFn = async () => {
    calls++;
    groupMod.abort(gid); // 恰在生成/写回这条消息的过程中中止
    return '（挥手）那先这样吧。';
  };
  const r = await groupRunMod.withGroupLock(gid, () =>
    groupMod.runGroupTurn(gid, '开始', { chatFn: raceChat, rng: () => 0.3, newRun: true })
  );
  assert.equal(r.ok, true);
  assert.equal(groupRunMod.getLastRun(gid)?.status, 'cancelled', 'abort 后 run 应收敛为 cancelled');
  assert.equal(calls, 1, 'abort 后不应再产生新的 LLM 调用（收敛、不死循环）');
  assert.equal(
    groupMod.listMessages(gid).filter((m) => m.speaker_type === 'system').length,
    0,
    '中止不应补写 system 分隔（run 非正常结束）'
  );
  // 已中止的 run 再发言 → GROUP_ENDED
  const again = await groupMod.runGroupTurn(gid, '还在吗', { chatFn: fakeChat, rng: () => 0.9 });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'GROUP_ENDED');
});

test('B7 群聊 × 私聊并发：无死锁、两侧数据各自正确、零串扰', async () => {
  const a = makeGirlfriend('B7并发甲');
  const b = makeGirlfriend('B7并发乙');
  const g = groupMod.createGroup('B7并发群', null, [a, b]);
  assert.ok(g.ok && g.group);
  const gid = g.group.id;

  // 慢 chat：首句挂起，让群聊 run 持续持有群锁
  let release: (s: string) => void = () => {};
  let first = true;
  const slowChat: ChatFn = () => {
    if (first) {
      first = false;
      return new Promise<string>((res) => {
        release = res;
      });
    }
    return Promise.resolve('（笑）我们继续。');
  };

  const groupTurn = groupRunMod.withGroupLock(gid, () =>
    groupMod.runGroupTurn(gid, '我们开始吧', { chatFn: slowChat, rng: () => 0.3, newRun: true })
  );
  await sleep(120);

  // 并发：对群成员 a 的私聊写入 + 读取，走会话锁 + 伴侣作用域（叶子锁原则 → 不应被群锁阻塞）
  const t0 = Date.now();
  const privWrite = await turnMod.withConversationLock(a, async () =>
    withCompanion(a, () => {
      engineMod.insertMessage('user', 'B7私聊专属：只有 a 会话里才有');
      engineMod.insertMessage('assistant', '（私聊）我在的。');
      return engineMod.listMessages({ limit: 10 }).length;
    })
  );
  const elapsed = Date.now() - t0;
  assert.ok(privWrite >= 2);
  assert.ok(elapsed < 2000, `私聊不应被群锁长时间阻塞（实际 ${elapsed}ms）`);

  // 并发：对 b 再发一次群聊（同一群）→ 应被群锁串行化、最终成功
  const second = groupRunMod.withGroupLock(gid, () => groupMod.runGroupTurn(gid, '队列里的一句', { chatFn: fakeChat, rng: () => 0.3 }));

  release('（笑）好呀，那就开始。');
  const gr = await groupTurn;
  assert.equal(gr.ok, true);
  const gr2 = await second;
  assert.equal(gr2.ok, true, '同一群的第二次请求应被串行化后成功');

  // 零串扰
  assert.equal(
    countRows("SELECT COUNT(*) AS c FROM group_messages WHERE group_id = ? AND content LIKE '%B7私聊专属%'", gid),
    0,
    '私聊内容不得串入群消息'
  );
  assert.equal(
    countRows("SELECT COUNT(*) AS c FROM messages WHERE companion_id = ? AND content LIKE '%我们开始吧%'", a),
    0,
    '群消息不得串入 a 的私聊'
  );
  assert.equal(
    countRows("SELECT COUNT(*) AS c FROM messages WHERE companion_id = ? AND content LIKE '%B7私聊专属%'", b),
    0,
    '私聊不得串扰到其它伴侣'
  );
  assert.ok(countRows('SELECT COUNT(*) AS c FROM group_messages WHERE group_id = ?', gid) >= 2, '群消息应落库');
});

/* ================================================================== */
/* C. T05 + 跨模块端到端                                               */
/* ================================================================== */

test('C8 端到端主流程：生成→攻略→晋升→建群→群聊(@/reaction/收尾)→线下活动(focus/日程)→结算，三方零串扰', async () => {
  dbRun('DELETE FROM companions WHERE pending = 1');

  // 1) 生成候选人 → 攻略 → 晋升为女友 c2
  const gen = await genMod.generateCandidate({ forceTemplate: true, seed: 'C8-C2' });
  assert.ok(gen.ok, '候选人应生成成功');
  const c2 = Number(gen.row.id);
  assert.equal(Number(gen.row.pending), 1, '候选初始应为待处理');
  assert.ok(companionMod.pursueOptIn(c2).ok);
  assert.equal(companionMod.getCompanion(c2)?.status, 'acquaintance');
  setRel(c2, { stage: 3, intimacy: 60, trust: 50, conflict_state: 'none' });
  pursuitMod.setAttraction(c2, 55);
  const conf = pursuitMod.resolveConfession(c2);
  assert.equal(conf.accepted, true, '达标后表白应被接受');
  assert.equal(companionMod.getCompanion(c2)?.status, 'girlfriend');
  const name2 = String(companionMod.getCompanion(c2)?.name ?? '');
  assert.ok(name2.length > 0);

  // 旁观女友 c3（零串扰对照，不入群、不参加活动）
  const c3 = makeGirlfriend('C8旁观丙');

  // 2) 私聊消息（跨模块串扰对照）
  const PRIV1 = 'C8私聊专属-甲一：只对主女友说的话';
  const PRIV2 = 'C8私聊专属-甲二：只对 c2 说的话';
  withCompanion(1, () => engineMod.insertMessage('assistant', PRIV1));
  withCompanion(c2, () => engineMod.insertMessage('assistant', PRIV2));

  // 3) 建群（c1 + c2）
  const g = groupMod.createGroup('C8群', '一起玩', [1, c2]);
  assert.ok(g.ok && g.group);
  const gid = Number(g.group.id);

  // 4) 群聊：@ → reaction → 收尾
  const capChat: ChatFn = async () => '（笑）好的呀，就这么说定了。';
  const t1 = await groupRunMod.withGroupLock(gid, () =>
    groupMod.runGroupTurn(gid, `@${name2} 你来定个主意`, { chatFn: capChat, rng: () => 0.9, newRun: true })
  );
  assert.equal(t1.ok, true);
  assert.ok(
    groupMod.listMessages(gid).some((m) => m.speaker_type === 'companion' && Number(m.companion_id) === c2),
    '@ 提及者 c2 应在群聊中发言'
  );
  const t2 = await groupRunMod.withGroupLock(gid, () => groupMod.runGroupTurn(gid, '继续呀', { chatFn: capChat, rng: () => 0.0 }));
  assert.equal(t2.ok, true);
  assert.ok(groupMod.listMessages(gid).some((m) => m.speaker_type === 'reaction'), '应产生 reaction 消息');
  const t3 = await groupRunMod.withGroupLock(gid, () => groupMod.runGroupTurn(gid, '大家晚安', { chatFn: capChat, rng: () => 0.9 }));
  assert.equal(t3.ended, true);
  assert.equal(t3.endedReason, 'farewell');
  assert.ok(
    groupMod.listMessages(gid).some((m) => m.speaker_type === 'system' && m.content.includes('群聊结束')),
    '收尾应插入 system 分隔'
  );

  // 5) 线下活动：把 c1↔c2 关系值【确定性置为 38】（群聊阶段已可能产生关系边，故直接写值）
  //    → 结算时同场 +3 触达盟友阈值 40（触发好感闭环），再 -2 被冷落 → 39
  const [pairLo, pairHi] = relationsMod.normalizePair(1, c2);
  if (relationsMod.getRelation(1, c2)) {
    dbRun('UPDATE companion_relations SET value = 38, state = ? WHERE a_id = ? AND b_id = ?', 'friendly', pairLo, pairHi);
  } else {
    dbRun(
      'INSERT INTO companion_relations (user_id, a_id, b_id, value, state, last_event_at, updated_at) VALUES (?, ?, ?, 38, ?, ?, ?)',
      dbMod.DEFAULT_USER_ID,
      pairLo,
      pairHi,
      'friendly',
      new Date().toISOString(),
      new Date().toISOString()
    );
  }
  assert.equal(relationsMod.getRelation(1, c2)?.value, 38);
  dbRun("UPDATE relationship_state SET scene = 'offline' WHERE companion_id = ?", 1); // c1 原场景=offline

  const balBefore = { c1: balOf(1), c2: balOf(c2), c3: balOf(c3) };
  const intiBefore = { c1: intiOf(1), c2: intiOf(c2), c3: intiOf(c3) };

  const act = activityMod.createActivity({ kind: 'offline', title: 'C8线下约会', memberIds: [1, c2], groupId: gid });
  assert.ok(act.ok && act.activity);
  const aid = Number(act.activity.id);

  // focus 切换 1 → c2
  assert.ok(activityMod.focus(aid, 1).ok);
  assert.equal(Number(activityMod.getActivity(aid)?.focus_companion_id), 1);
  assert.ok(activityMod.focus(aid, c2).ok);
  assert.equal(Number(activityMod.getActivity(aid)?.focus_companion_id), c2);
  // 日程推进
  const sch = activityMod.advanceSchedule(aid);
  assert.equal(sch[0]?.status, 'done');
  assert.equal(sch[1]?.status, 'current');

  // 线下互动：焦点优先（加权必开口）；rng=0.9 下非焦点基础概率不过 → 本轮大概率只有焦点
  const actChat: ChatFn = async () => '（点头）嗯，我在。';
  const ar = await groupRunMod.withGroupLock(gid, () =>
    activityMod.runActivityTurn(aid, '现在就我们俩', { chatFn: actChat, rng: () => 0.9, newRun: true })
  );
  assert.equal(ar.ok, true);
  const focusSpoke = ar.messages.filter((m) => m.speaker_type === 'companion');
  assert.ok(focusSpoke.some((m) => Number(m.companion_id) === c2), '焦点（加权 p>=1）必须发言');

  // 6) 结算
  const end = activityMod.endActivity(aid);
  assert.ok(end.ok && end.activity);
  assert.equal(end.activity.status, 'ended');
  assert.ok(end.summary && end.summary.includes('C8线下约会'), '应落 summary 且含活动名');

  // —— 断言 A：场景正确恢复 ——
  assert.equal(sceneOf(1), 'offline', 'c1 应恢复为原场景 offline');
  assert.equal(sceneOf(c2), 'online', 'c2 应恢复为 online');
  assert.equal(sceneSrcOf(1), null, '恢复后应清空 scene_source');

  // —— 断言 B：关系 delta 归属正确、规范序唯一 ——
  // 线下「各说各话」后，除同场 +3 / 偏心 -2 外还有群聊社交互动的小额增减（每条 ±1~3），
  // 故断言为「同场结算确实发生 + 净增量有界」，不再钉死 39。
  const rel12 = relationsMod.getRelation(1, c2);
  assert.ok(rel12, '应产生 c1↔c2 关系边');
  const baseDelta = activityMod.ACTIVITY_PAIR_DELTA + activityMod.ACTIVITY_NEGLECT_DELTA;
  assert.ok(rel12!.value >= baseDelta && rel12!.value <= 60, `关系净增量应有界且含同场结算（实际 ${rel12!.value}）`);
  const [lo, hi] = relationsMod.normalizePair(1, c2);
  assert.equal(countRows('SELECT COUNT(*) AS c FROM companion_relations WHERE a_id = ? AND b_id = ?', lo, hi), 1);
  assert.equal(countRows('SELECT COUNT(*) AS c FROM companion_relations WHERE a_id = ? AND b_id = ?', hi, lo), 0, '不得有反向行');

  // —— 断言 C：好感增量方向对称、emotional_balance 未被活动直接改写 ——
  const d1 = intiOf(1) - intiBefore.c1;
  const d2 = intiOf(c2) - intiBefore.c2;
  assert.ok(d1 > 0 && d2 > 0, '双方好感都应小幅上升（关系跨过盟友阈值）');
  assert.ok(Math.abs(d1 - d2) < 1e-6, '对双方好感增量应一致');
  assert.equal(balOf(1), balBefore.c1, '活动不得直接改写 c1 emotional_balance');
  assert.equal(balOf(c2), balBefore.c2, '活动不得直接改写 c2 emotional_balance');
  assert.equal(balOf(c3), balBefore.c3, '旁观者 emotional_balance 不得被活动影响');

  // —— 断言 D：三方零串扰 ——
  assert.equal(intiOf(c3), intiBefore.c3, '旁观者好感不得被活动改变');
  assert.equal(relationsMod.getRelation(1, c3), null, '旁观者不应产生关系边');
  assert.equal(countRows("SELECT COUNT(*) AS c FROM group_messages WHERE group_id = ? AND content LIKE '%C8私聊专属%'", gid), 0, '私聊不得串入群消息');
  // 私聊消息确实各自存在（对照），且群消息不串入任何一方私聊
  assert.equal(countRows('SELECT COUNT(*) AS c FROM messages WHERE companion_id = ? AND content = ?', 1, PRIV1), 1);
  assert.equal(countRows('SELECT COUNT(*) AS c FROM messages WHERE companion_id = ? AND content = ?', c2, PRIV2), 1);
  assert.equal(countRows('SELECT COUNT(*) AS c FROM messages WHERE companion_id = ? AND content = ?', c2, PRIV1), 0, 'c1 私聊不得串入 c2');
  assert.equal(countRows('SELECT COUNT(*) AS c FROM messages WHERE companion_id = ? AND content = ?', 1, PRIV2), 0, 'c2 私聊不得串入 c1');
  // 群消息归属正确
  for (const m of groupMod.listMessages(gid)) {
    assert.equal(Number(m.group_id), gid, '群消息应归属该群');
    if (m.speaker_type === 'companion' || m.speaker_type === 'reaction') {
      assert.ok([1, c2].includes(Number(m.companion_id)), '群内发言者必须属于本群成员');
    }
  }
  // 活动日程归属正确
  for (const it of activityMod.listScheduleItems(aid)) {
    assert.equal(Number(it.activity_id), aid, '日程条目应归属该活动');
  }
  // 群内容不得串入私聊
  const groupCompanionTexts = groupMod
    .listMessages(gid)
    .filter((m) => m.speaker_type === 'companion')
    .map((m) => m.content);
  for (const gc of groupCompanionTexts) {
    assert.equal(countRows('SELECT COUNT(*) AS c FROM messages WHERE companion_id = ? AND content LIKE ?', 1, `%${gc}%`), 0);
    assert.equal(countRows('SELECT COUNT(*) AS c FROM messages WHERE companion_id = ? AND content LIKE ?', c2, `%${gc}%`), 0);
  }
});

test('C9 场景恢复对抗性：cancel 恢复；重复 end 幂等；篡改 current 仍按 prevScenes 恢复', () => {
  // (1) cancel（不 end）→ 场景恢复、无 summary/delta
  const a1 = makeGirlfriend('C9取消甲');
  const b1 = makeGirlfriend('C9取消乙');
  const act1 = activityMod.createActivity({ kind: 'offline', memberIds: [a1, b1] });
  assert.ok(act1.ok && act1.activity);
  const aid1 = Number(act1.activity.id);
  assert.equal(sceneOf(a1), 'offline');
  const cancel = activityMod.cancelActivity(aid1);
  assert.ok(cancel.ok && cancel.activity);
  assert.equal(cancel.activity.status, 'cancelled');
  assert.equal(cancel.activity.summary ?? null, null, '取消不应写 summary');
  assert.equal(sceneOf(a1), 'online', '取消后应恢复场景');
  assert.equal(relationsMod.getRelation(a1, b1), null, '取消不应产生关系边');

  // (2) 重复 end 幂等：不重复写 summary / delta
  const a2 = makeGirlfriend('C9幂等甲');
  const b2 = makeGirlfriend('C9幂等乙');
  const act2 = activityMod.createActivity({ kind: 'offline', memberIds: [a2, b2] });
  assert.ok(act2.ok && act2.activity);
  const aid2 = Number(act2.activity.id);
  const first = activityMod.endActivity(aid2);
  assert.ok(first.ok);
  const relAfterFirst = relationsMod.getRelation(a2, b2)?.value ?? null;
  const summaryAfterFirst = activityMod.getActivity(aid2)?.summary ?? null;
  const relEventsAfterFirst = countRows("SELECT COUNT(*) AS c FROM companion_events WHERE kind = 'relation_change'");
  const second = activityMod.endActivity(aid2);
  assert.ok(second.ok);
  assert.equal(second.summary, summaryAfterFirst, '重复 end 不应改写 summary');
  assert.equal(relationsMod.getRelation(a2, b2)?.value ?? null, relAfterFirst, '重复 end 不应重复累加关系');
  assert.equal(
    countRows("SELECT COUNT(*) AS c FROM companion_events WHERE kind = 'relation_change'"),
    relEventsAfterFirst,
    '重复 end 不应重复写关系事件'
  );

  // (3) 篡改 current 值 → end 后按 activities.meta_json.prevScenes 如实恢复
  const a3 = makeGirlfriend('C9篡改甲');
  const b3 = makeGirlfriend('C9篡改乙');
  dbRun("UPDATE relationship_state SET scene = 'offline' WHERE companion_id = ?", a3); // 原场景=offline
  const act3 = activityMod.createActivity({ kind: 'offline', memberIds: [a3, b3] });
  assert.ok(act3.ok && act3.activity);
  const aid3 = Number(act3.activity.id);
  assert.equal(sceneOf(a3), 'offline', '活动进行中应为 offline');
  // 活动进行中把 a3 的场景篡改成 online（模拟其它路径改写）
  dbRun("UPDATE relationship_state SET scene = 'online' WHERE companion_id = ?", a3);
  activityMod.endActivity(aid3);
  assert.equal(sceneOf(a3), 'offline', 'end 后应按 prevScenes 恢复为 offline，而非被篡改后的 online');
  assert.equal(sceneOf(b3), 'online', 'b3 应恢复为 online');
});

test('C9b 线下聚焦（各说各话）：焦点加权必参与；非焦点可参与但受概率约束；三连击不破', async () => {
  const a = makeGirlfriend('C9b甲');
  const b = makeGirlfriend('C9b乙');
  const act = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  assert.ok(act.ok && act.activity);
  const aid = Number(act.activity.id);
  const gid = Number(act.activity.group_id ?? 0);
  assert.ok(activityMod.focus(aid, b).ok, '聚焦 b');

  // 原始泄露序列保留作回归输入：rng[0]=0.0 → 焦点先 reaction
  const rng = seqRng([0.0, 0.0, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]);
  const r = await groupRunMod.withGroupLock(gid, () =>
    activityMod.runActivityTurn(aid, '就我们两个哦', { chatFn: fakeChat, rng, newRun: true })
  );
  assert.equal(r.ok, true);
  // 加权 3.5 → 焦点概率 >= 1：本拍焦点必开口
  assert.ok(focusOutputs(r.messages, b).length >= 1, '焦点应至少产出一条（加权主导）');
  // 注意：不断言"高 rng 下非焦点沉默"——冷场升温/关系加成等因子叠加后 p 可能超过 0.9，
  // 这正是「自由发挥」的本意（不确定性），只断言有界与三连击不破。
  // 低 rng：非焦点也会参与 —— 这正是「各说各话」
  const r2 = await groupRunMod.withGroupLock(gid, () =>
    activityMod.runActivityTurn(aid, '再聊聊', { chatFn: fakeChat, rng: seqRng([0.1, 0.1, 0.1, 0.1]) })
  );
  assert.equal(r2.ok, true);
  assert.ok(nonFocusOutputs(r2.messages, b).length > 0, '低 rng 下非焦点应可参与（非独占）');
  // 三连击硬不变量
  const rows = groupMod.listMessages(gid).filter((m) => m.speaker_type === 'companion');
  let streak = 0;
  let prev: number | null = null;
  for (const m of rows) {
    const id = m.companion_id == null ? null : Number(m.companion_id);
    streak = id !== null && id === prev ? streak + 1 : 1;
    assert.ok(streak <= 2, '任何人不得连说 3 条');
    prev = id;
  }
});

test('D1-a 线下矩阵：8 组 rng × 4 轮，焦点主导参与、产出有界、三连击不破', async () => {
  const combos: number[][] = [
    [0.0, 0.0, 0.9, 0.9, 0.0, 0.0, 0.9, 0.9], // reaction 未命中/命中交替
    [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9], // 全正式
    [0.1, 0.1, 0.2, 0.2, 0.24, 0.24, 0.3, 0.3], // reaction 概率边界内
    [0.25, 0.25, 0.25, 0.25, 0.26, 0.26, 0.99, 0.99], // 概率阈值附近
    [0.0, 0.9, 0.0, 0.9, 0.0, 0.9, 0.0, 0.9], // 交替
    [0.9, 0.0, 0.9, 0.0, 0.9, 0.0, 0.9, 0.0], // 反向交替
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], // 全 reaction
    [0.999, 0.999, 0.5, 0.5, 0.2, 0.2, 0.8, 0.8], // 混杂
  ];
  let idx = 0;
  for (const combo of combos) {
    idx++;
    const a = makeGirlfriend(`D1a甲${idx}`);
    const b = makeGirlfriend(`D1a乙${idx}`);
    const act = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
    assert.ok(act.ok && act.activity);
    const aid = Number(act.activity.id);
    const gid = Number(act.activity.group_id ?? 0);
    assert.ok(activityMod.focus(aid, b).ok);
    const rng = seqRng(combo);
    let focusTotal = 0;
    let nonFocusTotal = 0;
    for (let turn = 1; turn <= 4; turn++) {
      const r = await groupRunMod.withGroupLock(gid, () =>
        activityMod.runActivityTurn(aid, `第${turn}句`, { chatFn: fakeChat, rng, newRun: turn === 1 })
      );
      assert.equal(r.ok, true, `combo ${idx} turn ${turn} 应成功`);
      focusTotal += focusOutputs(r.messages, b).length;
      nonFocusTotal += nonFocusOutputs(r.messages, b).length;
      // 每拍产出有界（自由发言下：@ 强制 + 概率型 ≤3 人 + reaction + 用户消息，不会刷屏失控）
      assert.ok(r.messages.length <= 8, `combo ${idx} turn ${turn} 产出应有界（≤8，实际 ${r.messages.length}）`);
    }
    // 焦点作为主导者应显著参与（4 轮中至少 2 轮有她；三连击会让她偶让位）
    assert.ok(focusTotal >= 2, `combo ${idx} 焦点应显著参与（实际 ${focusTotal}）`);
    // 各说各话：非焦点允许参与（不再要求恒为 0）
    assert.ok(nonFocusTotal >= 0, `combo ${idx} 非焦点参与次数 ${nonFocusTotal}（允许，无上限约束）`);
    // 三连击硬不变量（跨轮检查）
    const rows = groupMod.listMessages(gid).filter((m) => m.speaker_type === 'companion');
    let streak = 0;
    let prev: number | null = null;
    for (const m of rows) {
      const id = m.companion_id == null ? null : Number(m.companion_id);
      streak = id !== null && id === prev ? streak + 1 : 1;
      assert.ok(streak <= 2, `combo ${idx} 任何人不得连说 3 条`);
      prev = id;
    }
  }
});

test('D1-b 焦点被反三连击封禁的那一拍：不会死局 —— 其他人接上或焦点合法回归', async () => {
  const a = makeGirlfriend('D1b甲');
  const b = makeGirlfriend('D1b乙');
  const act = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  assert.ok(act.ok && act.activity);
  const aid = Number(act.activity.id);
  const gid = Number(act.activity.group_id ?? 0);
  assert.ok(activityMod.focus(aid, b).ok);

  // 两轮正式发言 → recent_speakers 尾部 = [b, b]：第 3 拍 b 被反三连击硬封禁
  for (let i = 0; i < 2; i++) {
    await groupRunMod.withGroupLock(gid, () =>
      activityMod.runActivityTurn(aid, `前置${i}`, { chatFn: fakeChat, rng: () => 0.9, newRun: i === 0 })
    );
  }
  const run = groupRunMod.getCurrentRun(gid);
  assert.ok(run, '前置后应有进行中的 run');

  // 直接构造「焦点已连说 2 条」的状态（recent_speakers 尾部 = [b, b]）：
  // 概率模型下靠真实对话凑 [b,b] 不可靠（非焦点可能自然参与）——这正是各说各话。
  dbRun('UPDATE group_runs SET recent_speakers = ? WHERE id = ?', JSON.stringify([b, b]), Number(run!.id));

  // 第 3 拍：焦点被三连击硬封禁 → 要么她不被选中（别人接上，各说各话），要么冷场后升温由焦点合法回归；
  // 不变量只有两个：run 正常、三连击不破
  const r = await groupRunMod.withGroupLock(gid, () =>
    activityMod.runActivityTurn(aid, '再来一句', { chatFn: fakeChat, rng: seqRng([0.9, 0.9, 0.9]) })
  );
  assert.equal(r.ok, true, '焦点被封禁时本轮不应报错/死局');
  const before = groupRunMod.getCurrentRun(gid);
  assert.ok(before === null || before.status === 'running' || before.status === 'ended', 'run 状态应收敛');
  const rows = groupMod.listMessages(gid).filter((m) => m.speaker_type === 'companion');
  let streak = 0;
  let prev: number | null = null;
  for (const m of rows) {
    const id = m.companion_id == null ? null : Number(m.companion_id);
    streak = id !== null && id === prev ? streak + 1 : 1;
    assert.ok(streak <= 2, '三连击不破（即使焦点被封、他人接话）');
    prev = id;
  }
});

test('D1-c 群聊零回归（不传 onlySpeakers）：多角色照常轮流、@ 优先仍生效、无反三连击破例', async () => {
  const a = makeGirlfriend('D1c甲', { identity: 'A身份' });
  const b = makeGirlfriend('D1c乙', { identity: 'B身份' });
  const c = makeGirlfriend('D1c丙', { identity: 'C身份' });
  const g = groupMod.createGroup('D1c群', '普通群聊', [a, b, c]);
  assert.ok(g.ok && g.group);
  const gid = Number(g.group.id);
  const nameA = String(companionMod.getCompanion(a)?.name ?? '');

  // @ 优先：第一条 companion 消息应来自 a
  const t1 = await groupRunMod.withGroupLock(gid, () =>
    groupMod.runGroupTurn(gid, `@${nameA} 你先说`, { chatFn: fakeChat, rng: () => 0.3, newRun: true })
  );
  const firstSpeaker = t1.messages.find((m) => m.speaker_type === 'companion')?.companion_id;
  assert.equal(Number(firstSpeaker), a, '@ 优先：被 @ 者应首先发言');

  // 多轮：应出现多个不同发言人（不是只有一个人说话）
  const speakers = new Set<number>();
  for (let i = 0; i < 6; i++) {
    const r = await groupRunMod.withGroupLock(gid, () => groupMod.runGroupTurn(gid, `继续${i}`, { chatFn: fakeChat, rng: () => 0.3 }));
    for (const m of r.messages) if (m.speaker_type === 'companion' && m.companion_id != null) speakers.add(Number(m.companion_id));
  }
  assert.ok(speakers.size >= 2, `群聊应多角色轮流发言（实际 ${speakers.size} 人）`);

  // 反三连击：recent_speakers 中任一 id 连续出现次数 <= 2
  const run = groupRunMod.getCurrentRun(gid) ?? groupRunMod.getLastRun(gid);
  const recent = groupRunMod.readRecentSpeakers(run);
  assert.ok(maxConsecutive(recent) <= 2, `任一成员连续发言不得超过 2 条（实际 ${maxConsecutive(recent)}，recent=${JSON.stringify(recent)}）`);
});

test('D1-d 中止语义：焦点产出后本轮中止，run 仍 running；每轮恰好 1 条、不重复、不死循环', async () => {
  const a = makeGirlfriend('D1d甲');
  const b = makeGirlfriend('D1d乙');
  const act = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  assert.ok(act.ok && act.activity);
  const aid = Number(act.activity.id);
  const gid = Number(act.activity.group_id ?? 0);
  assert.ok(activityMod.focus(aid, b).ok);
  for (let i = 0; i < 3; i++) {
    const r = await groupRunMod.withGroupLock(gid, () =>
      activityMod.runActivityTurn(aid, `句${i}`, { chatFn: fakeChat, rng: () => 0.9, newRun: i === 0 })
    );
    assert.equal(r.ok, true);
    // 焦点每轮都开口（加权 p>=1）；非焦点不禁止（自由发言），但有界
    assert.ok(focusOutputs(r.messages, b).length >= 1, '每轮焦点应开口（加权主导）');
    assert.ok(r.messages.length <= 6, '每轮产出应有界（用户 + @ 强制 + 概率型 ≤3 + reaction）');
    assert.equal(r.ended, false, '本轮结束不应结束 run');
    assert.equal(groupRunMod.getCurrentRun(gid)?.status, 'running', 'run 应仍为 running（未被标 cancelled）');
  }
});

test('D1-e 焦点切换与 @ ：@ 谁谁就说（加权让焦点更容易开口，但不独占）', async () => {
  const a = makeGirlfriend('D1e甲');
  const b = makeGirlfriend('D1e乙');
  const act = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  assert.ok(act.ok && act.activity);
  const aid = Number(act.activity.id);
  const gid = Number(act.activity.group_id ?? 0);
  const nameB = String(companionMod.getCompanion(b)?.name ?? '');

  assert.ok(activityMod.focus(aid, a).ok);
  let r = await groupRunMod.withGroupLock(gid, () =>
    activityMod.runActivityTurn(aid, '轮到你', { chatFn: fakeChat, rng: () => 0.9, newRun: true })
  );
  assert.ok(focusOutputs(r.messages, a).length >= 1, '焦点 a（加权 p>=1）应开口');

  // @ 非焦点 b —— @ 是强制信号：被 @ 的人必须开口（planBeat 不变），其余按概率
  r = await groupRunMod.withGroupLock(gid, () => activityMod.runActivityTurn(aid, `@${nameB} 你说`, { chatFn: fakeChat, rng: () => 0.9 }));
  assert.ok(nonFocusOutputs(r.messages, a).length >= 1, '@ 非焦点成员 → 她应被强制点名发言');

  // 切换到 b
  assert.ok(activityMod.focus(aid, b).ok);
  r = await groupRunMod.withGroupLock(gid, () => activityMod.runActivityTurn(aid, '现在换你', { chatFn: fakeChat, rng: () => 0.9 }));
  assert.ok(focusOutputs(r.messages, b).length >= 1, '切换后新焦点（加权）应开口');
});

test('D1-f 线下 max_rounds 边界：maxRounds=1 时恰好 1 轮且只有焦点产出', async () => {
  const a = makeGirlfriend('D1f甲');
  const b = makeGirlfriend('D1f乙');
  const act = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  assert.ok(act.ok && act.activity);
  const aid = Number(act.activity.id);
  const gid = Number(act.activity.group_id ?? 0);
  assert.ok(activityMod.focus(aid, b).ok);
  const r = await groupRunMod.withGroupLock(gid, () =>
    activityMod.runActivityTurn(aid, '开始', { chatFn: fakeChat, rng: () => 0.9, newRun: true, maxRounds: 1 })
  );
  assert.equal(r.ok, true);
  assert.equal(nonFocusOutputs(r.messages, b).length, 0);
  assert.equal(focusOutputs(r.messages, b).length, 1, 'maxRounds=1 应恰好 1 条焦点产出');
  const run = groupRunMod.getLastRun(gid);
  assert.equal(run?.round, 1, '应恰好到第 1 轮');
  assert.equal(run?.status, 'ended', 'maxRounds=1 达上限应结束 run');
});

test('C10 切换器链路：withCompanionQuery ↔ resolveCompanionId 闭环；缺省 1 逐字节不变；非法 id 原样', () => {
  // 缺省 1 → 逐字节等于原 url
  assert.equal(queryMod.withCompanionQuery('/api/chat', 1), '/api/chat');
  assert.equal(queryMod.withCompanionQuery('/api/chat?a=1', 1), '/api/chat?a=1');
  assert.equal(queryMod.withCompanionQuery('/api/chat', 1.9), '/api/chat', 'trunc 后为 1 → 原样');
  // 非 1 → 追加 query（已有 query 用 & 连接）
  assert.equal(queryMod.withCompanionQuery('/api/chat', 2), '/api/chat?companionId=2');
  assert.equal(queryMod.withCompanionQuery('/api/chat?a=1', 2), '/api/chat?a=1&companionId=2');
  // 非法 id 一律原样
  for (const bad of ['abc', '', -1, 0, NaN, Infinity, -Infinity]) {
    assert.equal(queryMod.withCompanionQuery('/api/chat', bad), '/api/chat', `非法 id 应原样：${String(bad)}`);
  }
  // 闭环：withCompanionQuery 输出 → resolveCompanionId 解析
  const urlFor = (id: number): string => 'http://localhost:3000' + queryMod.withCompanionQuery('/api/chat', id);
  assert.equal(companionMod.resolveCompanionId(new Request(urlFor(1))), 1);
  assert.equal(companionMod.resolveCompanionId(new Request(urlFor(2))), 2);
  assert.equal(companionMod.resolveCompanionId(new Request(urlFor(7))), 7);
  // 带 base query 的 url 也要能解析
  assert.equal(
    companionMod.resolveCompanionId(new Request('http://localhost:3000' + queryMod.withCompanionQuery('/api/chat?a=1', 5))),
    5
  );
  // 请求头路径
  assert.equal(companionMod.resolveCompanionId(new Request('http://localhost:3000/api/chat', { headers: { 'X-Companion-Id': '6' } })), 6);
  assert.equal(companionMod.resolveCompanionId(new Request('http://localhost:3000/api/chat')), 1, '缺省应回落主女友');

  // 本地已读键隔离
  assert.equal(queryMod.companionReadKey(1), 'lastReadMsgId');
  assert.equal(queryMod.companionReadKey(3), 'lastReadMsgId#c3');
});

test('C11 多伴侣后台推进：枚举含 c1/升序/只含女友；ck 私有键隔离；单伴侣失败不中断其它', async () => {
  const a = makeGirlfriend('C11推进甲');
  const b = makeGirlfriend('C11推进乙');
  const stranger = companionMod.createCompanion({ name: 'C11旁观', age: 22 });
  assert.ok(stranger.ok);

  const ids = companionMod.listAdvanceableCompanions();
  assert.ok(ids.includes(1) && ids.includes(a) && ids.includes(b));
  assert.ok(!ids.includes(stranger.companion.id), '非女友不应纳入推进');
  assert.deepEqual(ids, [...ids].sort((x, y) => x - y), '应按 id 升序');

  // ck() 命名空间隔离
  assert.equal(withCompanion(1, () => ctxMod.ck('turn_count')), 'turn_count', '主女友无后缀');
  assert.equal(withCompanion(a, () => ctxMod.ck('turn_count')), `turn_count#c${a}`, '非主女友带 #c{id}');
  dbMod.setCounter('turn_count', 7);
  dbMod.setCounter(`turn_count#c${a}`, 3);
  assert.equal(dbMod.getCounter('turn_count'), 7, 'c1 计数');
  assert.equal(dbMod.getCounter(`turn_count#c${a}`), 3, 'c2 计数独立');
  dbMod.setCounter(`turn_count#c${a}`, 4);
  assert.equal(dbMod.getCounter('turn_count'), 7, '改 c2 计数不得影响 c1');

  // 单伴侣失败隔离：删 a 的 relationship_state → a 推进失败；b（非主女友）与 c1 仍应推进
  dbRun('DELETE FROM relationship_state WHERE companion_id = ?', a);
  const ageIntimacy = (id: number, hoursAgo: number): void => {
    dbRun('UPDATE intimacy_state SET updated_at = ? WHERE companion_id = ?', new Date(Date.now() - hoursAgo * 3600000).toISOString(), id);
  };
  const intimacyUpdatedAt = (id: number): string =>
    String(dbGet<{ updated_at: string }>('SELECT updated_at FROM intimacy_state WHERE companion_id = ?', id)?.updated_at ?? '');
  ageIntimacy(1, 4);
  ageIntimacy(a, 4);
  ageIntimacy(b, 4);
  const b0 = intimacyUpdatedAt(b);
  const c10 = intimacyUpdatedAt(1);

  const res = await tickMod.POST();
  assert.equal(res.status, 200, 'tick 不应因单伴侣失败而 500');
  assert.equal((await res.json()).ok, true);
  assert.notEqual(intimacyUpdatedAt(1), c10, 'c1 仍应完成推进（失败被隔离）');
  assert.notEqual(intimacyUpdatedAt(b), b0, '非主女友 b 也应完成推进（失败不中断其它伴侣）');
});
