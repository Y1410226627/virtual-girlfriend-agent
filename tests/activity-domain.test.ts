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

const { dbGet, dbRun } = dbMod;

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

/** 群内消息总数（用于断言防御路径「零写入」） */
function groupMsgCount(groupId: number): number {
  return Number(dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM group_messages WHERE group_id = ?', groupId)?.c ?? 0);
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
    rng: () => 0.9,
    newRun: true,
  });
  assert.equal(r.ok, true, '活动回合应成功');
  assert.ok(r.messages.length >= 1, '应产生消息');

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

test('线下互动：runActivityTurn「只让焦点一人发言」', async () => {
  const a = makeGirlfriend('焦点发言甲');
  const b = makeGirlfriend('焦点发言乙');
  const created = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  const aid = Number(created.activity!.id);

  // 聚焦 b，用户发一句话：本轮应仅 b 发言，a 不插话
  assert.ok(activityMod.focus(aid, b).ok);
  const r = await activityMod.runActivityTurn(aid, '我在你旁边', {
    chatFn: fakeChat as ChatFn,
    rng: () => 0.9, // 不触发 reaction
    newRun: true,
  });
  assert.equal(r.ok, true);
  const companionMsgs = r.messages.filter((m) => m.speaker_type === 'companion');
  assert.ok(companionMsgs.length >= 1, '焦点应发言');
  for (const m of companionMsgs) {
    assert.equal(Number(m.companion_id), b, '线下互动里只应有焦点在发言');
  }
  assert.ok(!companionMsgs.some((m) => Number(m.companion_id) === a), '非焦点不应发言');
});

test('线下互动（D1 修复）：焦点走 reaction 时非焦点仍零产出', async () => {
  const a = makeGirlfriend('D1甲');
  const b = makeGirlfriend('D1乙');
  const created = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  const aid = Number(created.activity!.id);
  const gid = Number(created.activity!.group_id);
  assert.ok(activityMod.focus(aid, a).ok);

  // rng[0]=0.0 → maybeReact 命中 → 焦点只发一条 reaction（旧实现此时不 abort → 下一轮轮转到非焦点）
  const r = await activityMod.runActivityTurn(aid, '我在', {
    chatFn: fakeChat as ChatFn,
    rng: seqRng([0.0, 0.5]),
    newRun: true,
  });
  assert.equal(r.ok, true);
  assert.ok(r.messages.some((m) => Number(m.companion_id) === a), '焦点应产出（reaction 亦可）');
  assert.equal(nonFocusSpokeCount(gid, [b]), 0, '焦点走 reaction 时非焦点必须零产出');
  assert.ok(!r.messages.some((m) => Number(m.companion_id) === b), '本轮不得出现非焦点任何消息');
});

test('线下互动（D1 修复）：多组 rng 覆盖 —— 非焦点零产出是不变量', async () => {
  const seqs: number[][] = [
    [0.0, 0.0], // reaction 命中
    [0.9], // 不 reaction → 正式发言
    [0.1, 0.9], // reaction 命中 + 换 emoji
    [0.5], // 不 reaction
    [0.0, 0.0, 0.9], // QA 复现序列（旧实现会轮转到非焦点）
  ];
  for (const seq of seqs) {
    const a = makeGirlfriend(`不变量甲${seq.join('')}`);
    const b = makeGirlfriend(`不变量乙${seq.join('')}`);
    const created = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
    const aid = Number(created.activity!.id);
    const gid = Number(created.activity!.group_id);
    assert.ok(activityMod.focus(aid, a).ok);
    // 连续 4 轮（越过反三连击阈值 2 轮）——旧实现第 3 轮会轮到非焦点
    for (let i = 0; i < 4; i++) {
      await activityMod.runActivityTurn(aid, `第 ${i + 1} 句`, {
        chatFn: fakeChat as ChatFn,
        rng: seqRng(seq),
        newRun: i === 0,
      });
    }
    assert.equal(nonFocusSpokeCount(gid, [b]), 0, `rng=${JSON.stringify(seq)} 时非焦点必须零产出`);
  }
});

test('线下互动（D1 修复）：切换焦点后仍只有新焦点产出', async () => {
  const a = makeGirlfriend('切换焦点甲');
  const b = makeGirlfriend('切换焦点乙');
  const created = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  const aid = Number(created.activity!.id);
  assert.ok(activityMod.focus(aid, a).ok);
  await activityMod.runActivityTurn(aid, '先陪你', { chatFn: fakeChat as ChatFn, rng: () => 0.9, newRun: true });

  assert.ok(activityMod.focus(aid, b).ok);
  const r2 = await activityMod.runActivityTurn(aid, '现在陪你', { chatFn: fakeChat as ChatFn, rng: () => 0.9 });
  assert.ok(r2.messages.some((m) => Number(m.companion_id) === b), '新焦点应产出');
  assert.ok(!r2.messages.some((m) => Number(m.companion_id) === a), '切换后旧焦点本轮不得产出');
});

test('线下互动（D1 修复）：中止本轮不把 run 标为 cancelled（仍 running）', async () => {
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
  assert.equal(r.run!.status, 'running', 'signal 中止本轮不应把 run 标为 cancelled');
  assert.equal(r.ended, false, '本轮不应视为整体结束');
});

test('线下防御（加固）：focus 为空时本轮零产出，不退化成群聊', async () => {
  const a = makeGirlfriend('无焦点甲');
  const b = makeGirlfriend('无焦点乙');
  const created = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  const aid = Number(created.activity!.id);
  const gid = Number(created.activity!.group_id);
  // 模拟异常态：直接清空库内 focus_companion_id（API 不可达，纯防御）
  dbRun('UPDATE activities SET focus_companion_id = NULL WHERE id = ?', aid);
  const before = groupMsgCount(gid);

  const r = await activityMod.runActivityTurn(aid, '有人吗', {
    chatFn: fakeChat as ChatFn,
    rng: () => 0.9,
    newRun: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_FOCUS');
  assert.equal(r.messages.length, 0, '本轮不应产生任何消息');
  assert.equal(groupMsgCount(gid), before, '不应写入任何 group_messages（不退化、不抢话）');
  assert.equal(r.ended, false);
  assert.ok(r.run === null || r.run.status === 'running', 'run 状态应保持合理（未创建 / 仍 running）');
});

test('线下防御（加固）：focus 不在参与者内时同样零产出', async () => {
  const a = makeGirlfriend('非法焦点甲');
  const b = makeGirlfriend('非法焦点乙');
  const outsider = makeGirlfriend('非法焦点旁观');
  const created = activityMod.createActivity({ kind: 'offline', memberIds: [a, b] });
  const aid = Number(created.activity!.id);
  const gid = Number(created.activity!.group_id);
  // 注入一个不在参与者列表内的「焦点」
  dbRun('UPDATE activities SET focus_companion_id = ? WHERE id = ?', outsider, aid);
  const before = groupMsgCount(gid);

  const r = await activityMod.runActivityTurn(aid, '有人吗', {
    chatFn: fakeChat as ChatFn,
    rng: () => 0.9,
    newRun: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_FOCUS');
  assert.equal(groupMsgCount(gid), before, '不应写入任何消息');
  assert.equal(r.ended, false);
  assert.ok(r.run === null || r.run.status === 'running');
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

  // 关系 delta：同场 +3，非焦点(b)对被偏心者(a) -2 → 净 +1
  const rel = relMod.getRelation(a, b);
  assert.ok(rel, '应产生一条伴侣关系边');
  assert.equal(
    rel!.value,
    activityMod.ACTIVITY_PAIR_DELTA + activityMod.ACTIVITY_NEGLECT_DELTA,
    '同场 +3 与线下被冷落 -2 应叠加为 +1'
  );

  // 幂等：再次结束不应重复结算
  const again = activityMod.endActivity(aid);
  assert.ok(again.ok);
  assert.equal(relMod.getRelation(a, b)?.value, activityMod.ACTIVITY_PAIR_DELTA + activityMod.ACTIVITY_NEGLECT_DELTA);
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
test('创建校验：非女友 → PERMISSION_ONLY_GIRLFRIEND；人数越界 → INVALID_INPUT / GROUP_MEMBER_LIMIT', () => {
  const gf = makeGirlfriend('校验女友');
  const stranger = companionMod.createCompanion({ name: '校验陌生人', age: 22 });
  assert.ok(stranger.ok);
  const sid = stranger.companion.id;

  const bad = activityMod.createActivity({ kind: 'online', memberIds: [gf, sid] });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'PERMISSION_ONLY_GIRLFRIEND');

  const few = activityMod.createActivity({ kind: 'online', memberIds: [gf] });
  assert.equal(few.ok, false);
  assert.equal(few.code, 'INVALID_INPUT');

  const many: number[] = [];
  for (let i = 1; i <= 7; i++) many.push(makeGirlfriend(`活动群员${i}`));
  const tooMany = activityMod.createActivity({ kind: 'online', memberIds: many });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, 'GROUP_MEMBER_LIMIT');
});

test('创建校验：活动类型非法 → INVALID_INPUT', () => {
  const a = makeGirlfriend('类型甲');
  const b = makeGirlfriend('类型乙');
  const bad = activityMod.createActivity({ kind: 'meeting', memberIds: [a, b] } as unknown as ActivityInput);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_INPUT');
});
