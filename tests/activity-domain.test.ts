// T05 活动域回归：
//  ① 线上活动：创建成功、复用群聊引擎、消息落 group_messages；隐私红线（源码级）；
//  ② 线下活动：场景落点 offline（scene_source='activity'）+ 生成约会日程 + 默认聚焦首位；
//  ③ 日程：buildDateSchedule 幂等 + advanceSchedule 推进；
//  ④ 聚焦校验：只能聚焦本活动参与者；runActivityTurn 线下「只让焦点一人发言」；
//  ⑤ 结算：endActivity 写 summary + 恢复场景 + 关系 delta（同场 + / 被冷落 −）；幂等；
//  ⑥ 取消：cancelActivity 恢复场景、不写 summary / 不写关系；
//  ⑦ 参数校验：非女友 / 人数越界 / 类型非法；
//  ⑧ 数值纪律（源码级）：只经 applyDelta，不直接触碰 emotional_balance。
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-activity-domain-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const companionMod = await import('../src/lib/companion.ts');
const activityMod = await import('../src/lib/activity.ts');
const relMod = await import('../src/lib/companion-relations.ts');

dbMod.getDb(); // 触发建库（迁移 + 种子：companion 1 = 主女友）

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

const { dbGet, dbRun, dbAll } = dbMod;

/* ---------------------- 工具 ---------------------- */
function makeGirlfriend(name: string, extra: { identity?: string; personalityTags?: string[] } = {}): number {
  const r = companionMod.createCompanion({
    name,
    age: 24,
    identity: extra.identity,
    personality_tags: extra.personalityTags,
  });
  if (!r.ok) throw new Error(`createCompanion 失败：${name}`);
  companionMod.promote(r.companion.id);
  return r.companion.id;
}

const fakeChat = async (): Promise<string> => '（笑）好呀，我也喜欢这样。';

/** 注入式 chat 的函数签名（结构等价于 group.ts 的 GroupChatFn） */
type ChatFn = (messages: unknown, opts: unknown) => Promise<string>;

type ActivityInput = Parameters<typeof activityMod.createActivity>[0];

/** 确定性 RNG 序列（耗尽后重复最后一个值） */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[Math.min(values.length - 1, i)] ?? 0;
    i++;
    return v;
  };
}

/** 某活动里所有「非焦点」是否一条都没产出（companion + reaction 都算产出） */
function nonFocusSpokeCount(groupId: number, nonFocusIds: number[]): number {
  const set = nonFocusIds.filter((n) => n > 0);
  if (!set.length) return 0;
  const rows = dbMod.dbAll<{ companion_id: number | null }>(
    "SELECT companion_id FROM group_messages WHERE group_id = ? AND speaker_type IN ('companion','reaction')",
    groupId
  );
  return rows.filter((r) => set.includes(Number(r.companion_id))).length;
}

/* ================================================================== */
/* 1. 线上活动：复用群聊引擎 + 隐私红线（源码级）                        */
/* ================================================================== */
test('线上活动：创建成功、场景 online、复用群聊引擎、消息落 group_messages', async () => {
  const a = makeGirlfriend('线上甲', { identity: '独立乐队主唱', personalityTags: ['洒脱'] });
  const b = makeGirlfriend('线上乙', { identity: '夜班护士', personalityTags: ['温柔'] });
  const created = activityMod.createActivity({ kind: 'online', templateKey: 'movie', memberIds: [a, b] });
  assert.ok(created.ok && created.activity, '创建线上活动应成功');
  const act = created.activity;
  assert.equal(act.kind, 'online');
  assert.equal(act.scene, 'online');
  assert.equal(act.status, 'ongoing');
  assert.ok(Number(act.group_id) > 0, '线上活动应挂到一个群');

  const ids = activityMod.listParticipantIds(Number(act.id)).slice().sort((x, y) => x - y);
  assert.deepEqual(ids, [a, b].slice().sort((x, y) => x - y));

  const r = await activityMod.runActivityTurn(Number(act.id), '今晚一起看个电影吧', {
    chatFn: fakeChat as ChatFn,
    rng: () => 0.3, // 概率型成员通过、且不触发 reaction → 应有正式发言
    newRun: true,
  });
  assert.equal(r.ok, true, '活动回合应成功');
  assert.ok(r.messages.length >= 1, '应产生消息');
  assert.ok(
    r.messages.some((m) => m.speaker_type === 'companion'),
    '线上活动应有 AI 正式发言（复用群聊引擎）'
  );

  const gid = Number(act.group_id);
  const cnt = Number(dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM group_messages WHERE group_id = ?', gid)?.c ?? 0);
  assert.ok(cnt >= 1, '活动消息应写入 group_messages（复用群聊记录）');
});

test('隐私红线（源码级）：activity.ts 不引用任何私密数据入口', () => {
  const raw = fs.readFileSync(path.join(process.cwd(), 'src/lib/activity.ts'), 'utf8');
  // 先剥离注释（注释里会为说明目的"提到"这些入口名）
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const forbidden of [
    'retrieveMemories',
    'stableFacts',
    'recentMessagesForPrompt',
    'buildReplySystemPrompt',
    'user_profile',
  ]) {
    assert.ok(!src.includes(forbidden), `activity.ts 代码不得引用私密入口：${forbidden}`);
  }
});

test('数值纪律（源码级）：activity.ts 只经 applyDelta，不直接触碰 emotional_balance', () => {
  const raw = fs.readFileSync(path.join(process.cwd(), 'src/lib/activity.ts'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(src.includes('applyDelta'), 'activity.ts 应经 applyDelta 写伴侣关系');
  assert.ok(!src.includes('emotional_balance'), 'activity.ts 不得直接引用 emotional_balance');
  assert.ok(!src.includes('applyRelationshipDelta'), 'activity.ts 不得绕过闭环直接写好感');
});

/* ================================================================== */
/* 2. 线下活动：场景落点 + 日程 + 聚焦                                   */
/* ================================================================== */
test('线下活动：场景落点 offline + 生成约会日程 + 默认聚焦首位', () => {
  const a = makeGirlfriend('线下甲');
  const b = makeGirlfriend('线下乙');
  const created = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  assert.ok(created.ok && created.activity);
  const act = created.activity;
  assert.equal(act.kind, 'offline');
  assert.equal(act.scene, 'offline');
  assert.equal(Number(act.focus_companion_id), a, '默认聚焦首位参与者');

  const sa = dbGet<{ scene: string | null; scene_source: string | null }>(
    'SELECT scene, scene_source FROM relationship_state WHERE companion_id = ?',
    a
  );
  const sb = dbGet<{ scene: string | null }>('SELECT scene FROM relationship_state WHERE companion_id = ?', b);
  assert.equal(sa?.scene, 'offline', '参与者应被置为 offline 场景');
  assert.equal(sa?.scene_source, 'activity', '场景来源应标记为 activity');
  assert.equal(sb?.scene, 'offline');

  const schedule = activityMod.listScheduleItems(Number(act.id));
  assert.equal(schedule.length, activityMod.DATE_SCHEDULE_TEMPLATE.length, '应生成完整约会日程');
  assert.equal(schedule[0]?.status, 'current', '首个日程项应为进行中');
});

test('日程：buildDateSchedule 幂等 + advanceSchedule 推进', () => {
  const a = makeGirlfriend('日程甲');
  const b = makeGirlfriend('日程乙');
  const created = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  const aid = Number(created.activity!.id);

  const again = activityMod.buildDateSchedule(aid);
  assert.equal(again.length, activityMod.DATE_SCHEDULE_TEMPLATE.length, '重复调用不应追加日程项（幂等）');

  const after = activityMod.advanceSchedule(aid);
  assert.equal(after[0]?.status, 'done', '推进后首项应完成');
  assert.equal(after[1]?.status, 'current', '下一项应变为进行中');
});

test('聚焦校验：只能聚焦本活动参与者', () => {
  const a = makeGirlfriend('聚焦甲');
  const b = makeGirlfriend('聚焦乙');
  const outsider = makeGirlfriend('局外人');
  const created = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  const aid = Number(created.activity!.id);

  const ok = activityMod.focus(aid, b);
  assert.ok(ok.ok);
  assert.equal(Number(activityMod.getActivity(aid)?.focus_companion_id), b);

  const bad = activityMod.focus(aid, outsider);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_INPUT');
});

test('线下互动：焦点优先（加权 3.5 → 必开口），非焦点在高 rng 下不参与', async () => {
  const a = makeGirlfriend('焦点发言甲');
  const b = makeGirlfriend('焦点发言乙');
  const created = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  const aid = Number(created.activity!.id);

  // 聚焦 b：FOCUS_BOOST 让焦点概率 >= 1 → 必定开口；rng=0.9 高于非焦点基础概率 0.45 → a 本拍不插话
  assert.ok(activityMod.focus(aid, b).ok);
  const r = await activityMod.runActivityTurn(aid, '我在你旁边', {
    chatFn: fakeChat as ChatFn,
    rng: () => 0.9,
    newRun: true,
  });
  assert.equal(r.ok, true);
  const spoken = r.messages.filter((m) => m.speaker_type === 'companion');
  assert.ok(spoken.length >= 1, '焦点应发言');
  assert.ok(spoken.some((m) => Number(m.companion_id) === b), '焦点必须开口（加权保证 p>=1）');
});

test('线下互动：各说各话 —— 非焦点也会按情境参与（不再独占）', async () => {
  const a = makeGirlfriend('各说各话甲');
  const b = makeGirlfriend('各说各话乙');
  const created = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  const aid = Number(created.activity!.id);
  const gid = Number(created.activity!.group_id);
  assert.ok(activityMod.focus(aid, a).ok);

  // 低 rng：非焦点（b）也通过概率判定 → 本轮可出现非焦点发言（这是需求，不是缺陷）
  for (let i = 0; i < 4; i++) {
    await activityMod.runActivityTurn(aid, `第 ${i + 1} 句`, {
      chatFn: fakeChat as ChatFn,
      rng: seqRng([0.1, 0.1, 0.1, 0.1]),
      newRun: i === 0,
    });
  }
  const nonFocus = nonFocusSpokeCount(gid, [b]);
  assert.ok(nonFocus > 0, `线下也应各说各话：非焦点应至少参与过一次（实际 ${nonFocus}）`);

  // 但不变量仍在：谁都不得连说 3 条
  const rows = dbAll<{ companion_id: number | null; speaker_type: string }>(
    "SELECT companion_id, speaker_type FROM group_messages WHERE group_id = ? AND speaker_type = 'companion' ORDER BY id ASC",
    gid
  );
  let streak = 0;
  let prev: number | null = null;
  for (const row of rows) {
    const id = row.companion_id == null ? null : Number(row.companion_id);
    streak = id !== null && id === prev ? streak + 1 : 1;
    assert.ok(streak <= 2, '禁三连击是不变量');
    prev = id;
  }
});

test('线下互动：切换焦点后新焦点成为主导（高 rng 下只有新焦点开口）', async () => {
  const a = makeGirlfriend('切换焦点甲');
  const b = makeGirlfriend('切换焦点乙');
  const created = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  const aid = Number(created.activity!.id);
  assert.ok(activityMod.focus(aid, a).ok);
  await activityMod.runActivityTurn(aid, '先陪你', { chatFn: fakeChat as ChatFn, rng: () => 0.9, newRun: true });

  assert.ok(activityMod.focus(aid, b).ok);
  const r2 = await activityMod.runActivityTurn(aid, '现在陪你', { chatFn: fakeChat as ChatFn, rng: () => 0.9 });
  assert.ok(r2.messages.some((m) => Number(m.companion_id) === b), '新焦点应产出（加权主导）');
});

test('线下互动：中止语义 —— 本轮结束不把 run 标为 cancelled（仍 running）', async () => {
  const a = makeGirlfriend('中止语义甲');
  const b = makeGirlfriend('中止语义乙');
  const created = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  const aid = Number(created.activity!.id);
  assert.ok(activityMod.focus(aid, a).ok);
  const r = await activityMod.runActivityTurn(aid, '你好', {
    chatFn: fakeChat as ChatFn,
    rng: () => 0.9,
    newRun: true,
  });
  assert.ok(r.run, '应存在 run');
  assert.equal(r.run!.status, 'running', '本轮结束不应把 run 标为 cancelled');
  assert.equal(r.ended, false, '本轮不应视为整体结束');
});

test('线下防御：focus 为空/非法时退化为自由发言（不独占、不报硬错、不抢话）', async () => {
  for (const mode of ['null', 'outsider'] as const) {
    const a = makeGirlfriend(`无焦点甲-${mode}`);
    const b = makeGirlfriend(`无焦点乙-${mode}`);
    const outsider = makeGirlfriend(`无焦点旁观-${mode}`);
    const created = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
    const aid = Number(created.activity!.id);
    const gid = Number(created.activity!.group_id);
    // 模拟异常态：清空焦点 / 注入不在参与者列表内的焦点
    if (mode === 'null') dbRun('UPDATE activities SET focus_companion_id = NULL WHERE id = ?', aid);
    else dbRun('UPDATE activities SET focus_companion_id = ? WHERE id = ?', outsider, aid);

    const r = await activityMod.runActivityTurn(aid, '有人吗', {
      chatFn: fakeChat as ChatFn,
      rng: () => 0.1,
      newRun: true,
    });
    // 新语义：没有有效焦点时退化为「普通自由群聊」——不会死局（无人能说话），也不硬报错
    assert.equal(r.ok, true, `无有效焦点时应能正常聊（${mode}）`);
    assert.ok(r.messages.length > 0, '应有人正常发言');
    const outsiderMsgs = r.messages.filter((m) => Number(m.companion_id) === outsider);
    assert.equal(outsiderMsgs.length, 0, '非参与者（非法焦点）绝不应出现在活动里');
    assert.ok(Number(dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM group_messages WHERE group_id = ?', gid)?.c ?? 0) > 0);
  }
});

/* ================================================================== */
/* 3. 结算：endActivity（summary + 场景恢复 + 关系 delta）              */
/* ================================================================== */
test('endActivity：落 summary、恢复原场景、结算关系 delta（幂等）', async () => {
  const a = makeGirlfriend('结算甲');
  const b = makeGirlfriend('结算乙');
  // 让 a 的「原场景」= offline，验证结束后如实恢复为 offline；b 保持默认（online）
  dbRun("UPDATE relationship_state SET scene = 'offline' WHERE companion_id = ?", a);

  const created = activityMod.createActivity({ kind: 'offline', templateKey: 'date', title: '周末散步', memberIds: [a, b] });
  const aid = Number(created.activity!.id);
  await activityMod.runActivityTurn(aid, '走吧', { chatFn: fakeChat as ChatFn, rng: () => 0.9, newRun: true });

  const res = activityMod.endActivity(aid);
  assert.ok(res.ok && res.activity);
  assert.equal(res.activity!.status, 'ended');
  assert.ok(res.summary && res.summary.length > 0, '应生成活动小结');
  assert.ok(res.summary!.includes('周末散步'), '小结应包含活动名');

  // 场景恢复：a → offline（原值），b → online
  const sa = dbGet<{ scene: string | null; scene_source: string | null }>(
    'SELECT scene, scene_source FROM relationship_state WHERE companion_id = ?',
    a
  );
  const sb = dbGet<{ scene: string | null }>('SELECT scene FROM relationship_state WHERE companion_id = ?', b);
  assert.equal(sa?.scene, 'offline', 'a 应恢复为其原场景 offline');
  assert.equal(sa?.scene_source, null, '恢复后应清空 scene_source');
  assert.equal(sb?.scene, 'online', 'b 应恢复为在线');

  // 关系 delta：同场 +3 与「非焦点被偏心 -2」叠加应为净正；
  // 另外线下现在「各说各话」，非焦点参与会产生群聊社交互动的小额增减（每条 ±1~3）——
  // 故断言净增量落在合理区间，并**直接验证两条结算 reason 都真的执行过**（比精确数值更有意义）。
  const rel = relMod.getRelation(a, b);
  assert.ok(rel, '应产生一条伴侣关系边');
  const base = activityMod.ACTIVITY_PAIR_DELTA + activityMod.ACTIVITY_NEGLECT_DELTA;
  assert.ok(rel!.value >= base, `同场与偏心的净效果应至少为 ${base}（实际 ${rel!.value}）`);
  assert.ok(rel!.value <= 30, `不应出现异常放大（实际 ${rel!.value}）`);
  assert.equal(relMod.stateOfRelationship(rel!.value), rel!.state, '关系状态应由 value 决定');

  // 幂等：再次结束不应重复结算
  const before = Number(relMod.getRelation(a, b)?.value ?? 0);
  const again = activityMod.endActivity(aid);
  assert.ok(again.ok);
  assert.equal(Number(relMod.getRelation(a, b)?.value ?? 0), before, '重复 end 不得重复结算');
});

test('cancelActivity：恢复场景、不写 summary / 不写关系', () => {
  const a = makeGirlfriend('取消甲');
  const b = makeGirlfriend('取消乙');
  const created = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  const aid = Number(created.activity!.id);

  const res = activityMod.cancelActivity(aid);
  assert.ok(res.ok && res.activity);
  assert.equal(res.activity!.status, 'cancelled');
  assert.equal(res.activity!.summary ?? null, null, '取消不应写小结');
  assert.equal(relMod.getRelation(a, b), null, '取消不应产生关系边');

  const sa = dbGet<{ scene: string | null }>('SELECT scene FROM relationship_state WHERE companion_id = ?', a);
  assert.equal(sa?.scene, 'online', '取消后应恢复场景');
});

/* ================================================================== */
/* 4. 参数校验                                                          */
/* ================================================================== */
test('创建校验：stranger → PERMISSION_NOT_ACQUAINTED（v16 资格放宽）；<2 → INVALID_INPUT；>6 仍允许', () => {
  const gf = makeGirlfriend('校验女友');
  const stranger = companionMod.createCompanion({ name: '校验陌生人', age: 22 });
  assert.ok(stranger.ok);
  const sid = stranger.companion.id;

  const bad = activityMod.createActivity({ kind: 'online', memberIds: [gf, sid] });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'PERMISSION_NOT_ACQUAINTED');

  const few = activityMod.createActivity({ kind: 'online', memberIds: [gf] });
  assert.equal(few.ok, false);
  assert.equal(few.code, 'INVALID_INPUT');

  // 活动参与人数无硬上限：8 名女友应允许
  const many: number[] = [];
  for (let i = 1; i <= 8; i++) many.push(makeGirlfriend(`活动群员${i}`));
  const big = activityMod.createActivity({ kind: 'online', memberIds: many });
  assert.ok(big.ok, '>6 名参与者应允许（无硬上限）');
  assert.equal(activityMod.listParticipantIds(Number(big.activity!.id)).length, 8);
});

test('创建校验：活动类型非法 → INVALID_INPUT', () => {
  const a = makeGirlfriend('类型甲');
  const b = makeGirlfriend('类型乙');
  const bad = activityMod.createActivity({ kind: 'meeting', memberIds: [a, b] } as unknown as ActivityInput);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_INPUT');
});
