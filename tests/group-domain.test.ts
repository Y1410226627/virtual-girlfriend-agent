// T04 群聊域回归：
//  ① 隐私红线（buildGroupPrompt 不含私密记忆 / 向量 / 用户画像，只含公开角色卡）；
//  ② 自由发言模型 planBeat（@ 强制 / 可 0 人开口 / 冷场后升温 / 多人陆续接话 / 禁三连击）；
//  ③ reaction 替代发言 / 收尾词 & 达 12 轮自然结束并插分隔 / abort 立即停止 / 连续 2 拍冷场结束；
//  ④ 建群成员校验（stranger → PERMISSION_NOT_ACQUAINTED；≥2 且**无硬上限**）；
//  ⑤ prompt 角色卡裁剪（人数 > 12 时完整卡 ≤ 12，其余仅列名）；
//  ⑥ 并发不串扰不死锁（群聊 run 与伴侣私聊互不阻塞，叶子锁原则）。
// 隐私：使用独立的临时库（os.tmpdir），绝不触碰 data/ 下的真实数据。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-group-domain-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const ctxMod = await import('../src/lib/companion-context.ts');
const companionMod = await import('../src/lib/companion.ts');
const groupMod = await import('../src/lib/group.ts');
const groupRunMod = await import('../src/lib/group-run.ts');
const turnMod = await import('../src/lib/turn.ts');

dbMod.getDb(); // 触发建库（迁移 + 种子：companion 1 = 主女友）

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

const { dbGet, dbRun, setSetting } = dbMod;
const { withCompanion } = ctxMod;

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

/** 构造一个结构上等价于 group_runs 行的假 run（供 planSpeakers 纯函数单测） */
interface RunLike {
  id: number;
  group_id: number;
  kind: string;
  activity_id: number | null;
  status: string;
  round: number;
  max_rounds: number;
  last_speaker_id: number | null;
  recent_speakers: string | null;
  spoke_counts: string | null;
  ended_reason: string | null;
  started_at: string;
  ended_at: string | null;
}
function runLike(recent: number[], counts: Record<number, number>, round = 1): RunLike {
  return {
    id: 1,
    group_id: 1,
    kind: 'chat',
    activity_id: null,
    status: 'running',
    round,
    max_rounds: 12,
    last_speaker_id: null,
    recent_speakers: JSON.stringify(recent),
    spoke_counts: JSON.stringify(counts),
    ended_reason: null,
    started_at: new Date().toISOString(),
    ended_at: null,
  };
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

const fakeChat = async (): Promise<string> => '（笑）好呀，我也想聊这个。';

/** 注入式 chat 的函数签名（结构等价于 group.ts 的 GroupChatFn） */
type ChatFn = (messages: unknown, opts: unknown) => Promise<string>;

/* ================================================================== */
/* 1. 隐私红线（DoD 硬要求）                                            */
/* ================================================================== */
test('隐私红线：buildGroupPrompt 不含任何私密记忆 / 向量 / 用户画像，只含公开角色卡', () => {
  const a = makeGirlfriend('玲', { identity: '独立书店店员', personalityTags: ['文静', '慢读'] });
  const b = makeGirlfriend('晴', { identity: '咖啡师', personalityTags: ['元气'] });
  const created = groupMod.createGroup('隐私群', '周末去哪儿', [a, b]);
  assert.ok(created.ok && created.group);
  const gid = created.group.id;

  // —— 为成员 a 写入「私密记忆」+「向量」+「私聊消息」——
  const SECRET_MEMORY = '私密记忆-甲：玲偷偷在存钱，想给他买一块手表';
  const SECRET_VECTOR = '[0.919, 0.271, 0.888]';
  const SECRET_PRIVATE_MSG = '私聊消息-甲：只有我和他才知道的悄悄话';
  dbRun(
    `INSERT INTO memories (companion_id, user_id, type, content, importance, created_at, status, access_count)
     VALUES (?, ?, 'relationship', ?, 9, ?, 'active', 0)`,
    a,
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
  dbRun(
    "INSERT INTO messages (companion_id, user_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)",
    a,
    dbMod.DEFAULT_USER_ID,
    SECRET_PRIVATE_MSG,
    new Date().toISOString()
  );

  // —— 用户画像私密事实（全局 settings） ——
  const SECRET_PROFILE = '用户画像-私密：本名李雷，家住杭州市西湖区，怕黑';
  setSetting('user_profile', SECRET_PROFILE);
  setSetting('user_name', '李雷');

  // —— 群内历史（只来自 group_messages） ——
  dbRun(
    "INSERT INTO group_messages (group_id, companion_id, speaker_type, speaker_name, content, created_at) VALUES (?, NULL, 'user', '我', '今晚都在吗？', ?)",
    gid,
    new Date().toISOString()
  );
  dbRun(
    "INSERT INTO group_messages (group_id, companion_id, speaker_type, speaker_name, content, round, created_at) VALUES (?, ?, 'companion', '晴', '我在呀，玲姐呢？', 1, ?)",
    gid,
    b,
    new Date().toISOString()
  );
  const history = groupMod.listMessages(gid);

  const messages = groupMod.buildGroupPrompt({
    speakerId: a,
    memberIds: [a, b],
    history,
    topic: '周末去哪儿',
  });
  const text = JSON.stringify(messages);

  // —— 断言：私密内容绝不出现 ——
  assert.ok(!text.includes('私密记忆-甲'), '群上下文不得包含私密记忆内容');
  assert.ok(!text.includes(SECRET_MEMORY), '群上下文不得包含私密记忆原文');
  assert.ok(!text.includes(SECRET_VECTOR), '群上下文不得包含记忆向量');
  assert.ok(!text.includes('私聊消息-甲'), '群上下文不得包含各角色私聊消息');
  assert.ok(!text.includes(SECRET_PRIVATE_MSG), '群上下文不得包含各角色私聊原文');
  assert.ok(!text.includes('李雷'), '群上下文不得包含用户真实姓名');
  assert.ok(!text.includes(SECRET_PROFILE), '群上下文不得包含用户画像');
  assert.ok(!text.includes('怕黑'), '群上下文不得包含用户画像私密事实');

  // —— 断言：只含公开角色卡字段（name/identity/personality_tags/intro）+ 群内历史 ——
  assert.ok(text.includes('独立书店店员'), '应包含公开身份（identity）');
  assert.ok(text.includes('#文静'), '应包含公开性格标签（personality_tags）');
  assert.ok(text.includes('我在呀，玲姐呢？'), '应包含群内历史（来自 group_messages）');
  assert.ok(text.includes('当前发言人：玲'), '应指明当前发言人');
  // 用户一律以「我」称呼（不暴露姓名）
  assert.ok(text.includes('「我」'), '用户应显示为「我」');
});

test('隐私红线：buildGroupPrompt 不调用任何加载私密数据的入口（源码级断言）', () => {
  const raw = fs.readFileSync(path.join(process.cwd(), 'src/lib/group.ts'), 'utf8');
  // 先剥离注释（注释里会出于说明目的"提到"这些禁用的入口名），只看真实代码
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const forbidden of [
    'retrieveMemories',
    'stableFacts',
    'recentMessagesForPrompt',
    'buildReplySystemPrompt',
    'user_profile',
  ]) {
    assert.ok(!src.includes(forbidden), `group.ts 代码不得引用私密入口：${forbidden}`);
  }
  // 群内历史只能来自 group_messages
  assert.ok(src.includes('group_messages'), 'group.ts 应使用 group_messages 作为群内历史来源');
});

/* ================================================================== */
/* 2. 自由发言模型 planBeat + 禁三连击 + reaction                       */
/* ================================================================== */
test('planBeat：@ 强制发言（不受概率影响），且会三连击者被硬不变量剔除', () => {
  const members = [11, 22, 33];
  // 高 rng（0.99）会让所有概率型成员沉默；被 @ 者仍必须发言
  const run = runLike([11], { 11: 3, 22: 0, 33: 0 });
  assert.deepEqual(groupMod.planBeat(run, members, { rng: seqRng([0.99]), mentions: [22] }), [22], '@ 提及者应强制发言');
  assert.deepEqual(
    groupMod.planBeat(run, members, { rng: seqRng([0.99]), mentions: [22, 33] }),
    [22, 33],
    '@ 多人应全部强制发言'
  );
  // 会三连击者即便被 @ 也应被剔除（硬不变量优先于 @）
  const blockedRun = runLike([11, 11], { 11: 2 });
  assert.deepEqual(
    groupMod.planBeat(blockedRun, members, { rng: seqRng([0.99]), mentions: [11] }),
    [],
    '会三连击者即便被 @ 也应被剔除'
  );
});

test('planBeat：可 0 人开口（冷场）——固定 rng 使全员不通过', () => {
  const members = [11, 22, 33];
  // base=0.45；rng=0.99 >= p → 全部沉默；无 recent → 无 ×1.5；无 @ → 不强制
  assert.deepEqual(groupMod.planBeat(runLike([], {}), members, { rng: () => 0.99 }), [], '允许一拍 0 人开口');
});

test('planBeat：冷场后升温（上一拍 0 人 → 下一拍概率提高）', () => {
  const members = [11, 22, 33];
  const run = runLike([], {});
  // rng=0.6：base=0.45 → 0.6>=0.45 全员沉默
  assert.deepEqual(groupMod.planBeat(run, members, { rng: () => 0.6, prevSilent: false }), [], '升温前应冷场');
  // prevSilent=true → p=0.45*1.6=0.72 → 0.6<0.72 全员通过（上限 3）
  assert.deepEqual(
    groupMod.planBeat(run, members, { rng: () => 0.6, prevSilent: true }),
    [11, 22, 33],
    '冷场后应升温'
  );
});

test('planBeat：多人陆续接话（一拍可 2–3 人）+ maxSpeakers 上限', () => {
  const members = [11, 22, 33];
  const run = runLike([], {});
  // rng=0.1 < 0.45 → 全员通过 → 一拍 3 人（AI 之间陆续聊起来）
  const many = groupMod.planBeat(run, members, { rng: () => 0.1 });
  assert.equal(many.length, 3, '一拍可多人接话');
  // maxSpeakers=2 → 至多 2 人
  const capped = groupMod.planBeat(run, members, { rng: () => 0.1, maxSpeakers: 2 });
  assert.equal(capped.length, 2, 'maxSpeakers 应限制同拍人数');
  // temperature=0 → 基础概率 0 → 无人开口
  assert.deepEqual(groupMod.planBeat(run, members, { rng: () => 0.0, temperature: 0 }), [], 'temperature=0 应全员沉默');
});

test('planBeat：固定种子确定性', () => {
  const members = [11, 22, 33, 44];
  const run = runLike([11, 22], { 11: 1, 22: 1 });
  const a = groupMod.planBeat(run, members, { rng: seqRng([0.2, 0.7, 0.4, 0.5]) });
  const b = groupMod.planBeat(run, members, { rng: seqRng([0.2, 0.7, 0.4, 0.5]) });
  assert.deepEqual(a, b, '同一固定种子应产出完全一致的调度结果');
  assert.equal(new Set(a).size, a.length, '同拍内不应重复同一发言人');
});

test('禁三连击：同一人不得连说 3 条（planBeat 硬不变量）', () => {
  // 尾部已连 2 次者被禁，即便 rng 极低（其余人都想说话）
  const run = runLike([11, 11], { 11: 2, 22: 0 });
  const picked = groupMod.planBeat(run, [11, 22, 33], { rng: () => 0.0 });
  assert.ok(!picked.includes(11), '会三连击的发言者应被排除');
  assert.deepEqual(picked, [22, 33]);
  // 唯一候选会三连击 → 返回空
  assert.deepEqual(groupMod.planBeat(run, [11], { rng: () => 0.0 }), [], '唯一候选会三连击时应返回空');
});

test('planSpeakers（@deprecated 过渡）：仍可用且行为不变', () => {
  const members = [11, 22, 33];
  const run = runLike([11], { 11: 3, 22: 0, 33: 0 });
  assert.deepEqual(groupMod.planSpeakers(run, members, { rng: seqRng([0.9]), mentions: [22, 33] }), [22, 33]);
  const picked = groupMod.planSpeakers(run, members, { rng: seqRng([0.42, 0.42]) });
  assert.ok(picked.length >= 1 && picked.length <= 2, '旧调度仍返回 1–2 人');
});

test('maybeReact / pickReactionEmoji：概率与确定性', () => {
  assert.equal(groupMod.maybeReact(() => 0.1), true, '0.1 < 0.25 → 触发 reaction');
  assert.equal(groupMod.maybeReact(() => 0.9), false, '0.9 >= 0.25 → 不触发');
  assert.equal(groupMod.maybeReact(() => 0.1, 1), true, '概率 1 → 必触发');
  assert.equal(groupMod.pickReactionEmoji(() => 0), groupMod.REACTION_EMOJIS[0]);
});

/* ================================================================== */
/* 3. 收尾 / 12 轮自然结束 / abort                                      */
/* ================================================================== */
test('收尾词：命中 END_PHRASES → 立即结束并插入 system 分隔', async () => {
  const a = makeGirlfriend('收尾甲');
  const b = makeGirlfriend('收尾乙');
  const g = groupMod.createGroup('收尾群', null, [a, b]);
  const gid = g.group!.id;

  assert.equal(groupMod.hitsEndPhrase('大家晚安，我先睡了'), true);
  assert.equal(groupMod.hitsEndPhrase('今天天气不错'), false);

  const r = await groupMod.runGroupTurn(gid, '大家晚安', { chatFn: fakeChat, rng: () => 0.9, newRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.ended, true);
  assert.equal(r.endedReason, 'farewell');
  const sep = r.messages.find((m) => m.speaker_type === 'system');
  assert.ok(sep && sep.content.includes('群聊结束'), '应收尾并插入 system 分隔消息');
  assert.ok(sep!.content.includes('共'), '分隔消息应包含轮数');
});

test('达 12 轮自然结束并插入摘要分隔', async () => {
  const a = makeGirlfriend('长聊甲');
  const b = makeGirlfriend('长聊乙');
  const g = groupMod.createGroup('长聊群', null, [a, b]);
  const gid = g.group!.id;

  let ended = false;
  let guard = 0;
  while (!ended && guard++ < 60) {
    const r = await groupMod.runGroupTurn(gid, `第 ${guard} 句`, {
      chatFn: fakeChat,
      rng: () => 0.3,
      newRun: guard === 1,
    });
    ended = r.ended;
  }
  assert.equal(ended, true, '应在有限轮内自然结束');
  const last = groupRunMod.getLastRun(gid);
  assert.ok(last, '应存在 run');
  assert.equal(last!.status, 'ended');
  assert.equal(last!.round, 12, '应恰好达到 max_rounds = 12');
  const sep = dbGet<{ content: string }>(
    "SELECT content FROM group_messages WHERE group_id = ? AND speaker_type = 'system' ORDER BY id DESC LIMIT 1",
    gid
  );
  assert.ok(sep && sep.content.includes('共 12 轮'), `分隔消息应写明「共 12 轮」，实际：${sep?.content}`);
});

test('abort：立即中止后续发言，且对已中止的 run 再发言 → GROUP_ENDED', async () => {
  const a = makeGirlfriend('中止甲');
  const b = makeGirlfriend('中止乙');
  const g = groupMod.createGroup('中止群', null, [a, b]);
  const gid = g.group!.id;

  // 第一条 AI 发言后立即中止 → 后续不再发言
  let calls = 0;
  const abortAfterFirst: ChatFn = async () => {
    calls++;
    if (calls === 1) groupMod.abort(gid);
    return '（点头）嗯。';
  };
  await groupMod.runGroupTurn(gid, '开始吧', { chatFn: abortAfterFirst, rng: () => 0.3, newRun: true });
  const runRow = groupRunMod.getLastRun(gid);
  assert.equal(runRow?.status, 'cancelled', 'abort 后 run 应为 cancelled');
  assert.equal(calls, 1, '中止后不应再产生新的 AI 发言（应立即停止）');

  // 已中止的 run 再发言 → GROUP_ENDED
  const again = await groupMod.runGroupTurn(gid, '还在吗', { chatFn: fakeChat, rng: () => 0.3 });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'GROUP_ENDED');
});

test('自由发言：round>0 后连续 2 拍冷场 → 本轮自然结束（不空跑 LLM、run 保持 running）', async () => {
  const a = makeGirlfriend('冷场甲');
  const b = makeGirlfriend('冷场乙');
  const g = groupMod.createGroup('冷场群', null, [a, b]);
  const gid = g.group!.id;

  let calls = 0;
  const countingChat: ChatFn = async () => {
    calls++;
    return '（笑）嗯。';
  };
  // 先正常发言，让 run 进入 round>=1（脱离「第一拍升温」保护——新语义：刚聚起来的第一拍必有人开口）
  const warm = await groupMod.runGroupTurn(gid, '先热个场', { chatFn: countingChat, rng: () => 0.3, newRun: true });
  assert.equal(warm.ok, true);
  assert.ok((groupRunMod.getLastRun(gid)?.round ?? 0) >= 1, '预热后 run 应进入 round>=1');

  // 之后 rng=0.99：round>0 无升温 → 全员沉默 → 连续 2 拍 → 本轮自然结束
  const callsBefore = calls;
  const r = await groupMod.runGroupTurn(gid, '有人吗', { chatFn: countingChat, rng: () => 0.99 });
  assert.equal(r.ok, true);
  assert.equal(r.silent, true, '本轮应如实反映「冷场」');
  assert.equal(calls, callsBefore, '冷场不应空跑 LLM');
  assert.equal(r.messages.filter((m) => m.speaker_type === 'companion' || m.speaker_type === 'reaction').length, 0);
  const run = groupRunMod.getLastRun(gid);
  assert.equal(run?.status, 'running', '纯冷场只是本轮结束，不结束整个 run');
});

test('自由发言：新 run 的第一拍升温 —— 刚聚起来的场子必有人开口（即使 rng 很高）', async () => {
  const a = makeGirlfriend('开场甲');
  const b = makeGirlfriend('开场乙');
  const g = groupMod.createGroup('开场群', null, [a, b]);
  const gid = g.group!.id;
  // rng=0.99：旧语义（无升温）下第一拍会全员沉默；新语义 base=0.45*1.5=0.675，
  // 再叠加冷场升温 → 第二拍 p=1.08→1，必有人开口 —— 「建群即冷场」不再发生
  const r = await groupMod.runGroupTurn(gid, '有人吗', {
    chatFn: async () => '（笑）我来啦。',
    rng: () => 0.99,
    newRun: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.silent ?? false, false, '第一拍升温后不应静默冷场');
  assert.ok(
    r.messages.some((m) => m.speaker_type === 'companion' || m.speaker_type === 'reaction'),
    '第一拍升温后应有人产出'
  );
});

/* ================================================================== */
/* 3b. prompt 角色卡裁剪（人数无上限下的上下文预算）                     */
/* ================================================================== */
test('prompt 裁剪：人数 > 12 时完整角色卡 ≤ 12，其余仅列名（不阻塞参与）', () => {
  const ids: number[] = [];
  for (let i = 1; i <= 15; i++) ids.push(makeGirlfriend(`裁剪${i}`, { identity: `身份${i}` }));
  const g = groupMod.createGroup('裁剪群', '聊聊最近的电影', ids);
  assert.ok(g.ok && g.group);
  const gid = g.group!.id;
  const memberIds = groupMod.listMemberIds(gid);
  assert.equal(memberIds.length, 15);

  const messages = groupMod.buildGroupPrompt({ speakerId: memberIds[0]!, memberIds, history: [], topic: '聊聊最近的电影' });
  const text = JSON.stringify(messages);

  // 完整角色卡（形如「裁剪N：身份=...」）数量应 ≤ 12
  const fullCards = memberIds.filter((id) => {
    const name = dbGet<{ name: string }>('SELECT name FROM companions WHERE id = ?', id)?.name ?? '';
    return name && text.includes(`${name}：身份=`);
  });
  assert.ok(fullCards.length <= groupMod.GROUP_PROMPT_CARD_LIMIT, `完整角色卡应 ≤ 12（实际 ${fullCards.length}）`);
  assert.equal(fullCards.length, groupMod.GROUP_PROMPT_CARD_LIMIT, '应恰好裁剪到上限 12 张完整卡');
  // 其余成员仅列名
  assert.ok(text.includes('群成员还有：'), '其余成员应以名单形式出现');
  // 当前发言人必须有完整卡
  assert.ok(text.includes('当前发言人：'), '应指明当前发言人');
});

test('prompt 裁剪：被 @ / 最近发言者优先获得完整角色卡', () => {
  const ids: number[] = [];
  for (let i = 1; i <= 15; i++) ids.push(makeGirlfriend(`优先${i}`, { identity: `优先身份${i}` }));
  const g = groupMod.createGroup('优先群', null, ids);
  const memberIds = groupMod.listMemberIds(g.group!.id);
  const speaker = memberIds[0]!;
  const mentioned = memberIds[14]!; // 最后一名（默认按顺序会被裁掉）
  const recent = memberIds[13]!;

  const { cardIds } = groupMod.selectPromptMembers({
    memberIds,
    speakerId: speaker,
    mentionIds: [mentioned],
    recentSpeakerIds: [recent],
    topic: null,
  });
  assert.equal(cardIds.length, 12);
  assert.equal(cardIds[0], speaker, '当前发言人应第一优先');
  assert.ok(cardIds.includes(mentioned), '被 @ 者应优先获得完整卡');
  assert.ok(cardIds.includes(recent), '最近发言者应优先获得完整卡');
  // 未被优先的成员应落在「仅列名」
  const nameOnly = memberIds.filter((id) => !cardIds.includes(id));
  assert.equal(nameOnly.length, 3);
});

/* ================================================================== */
/* 4. 建群成员校验（人数无硬上限）                                       */
/* ================================================================== */
test('建群校验：stranger → PERMISSION_NOT_ACQUAINTED（v16 资格放宽）；<2 → INVALID_INPUT；>6 仍允许', () => {
  const gf = makeGirlfriend('校验女友');
  const stranger = companionMod.createCompanion({ name: '校验陌生人', age: 22 });
  assert.ok(stranger.ok);
  const sid = stranger.companion.id;

  const bad = groupMod.createGroup('含陌生人', null, [gf, sid]);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'PERMISSION_NOT_ACQUAINTED');

  const few = groupMod.createGroup('人太少', null, [gf]);
  assert.equal(few.ok, false);
  assert.equal(few.code, 'INVALID_INPUT');

  // 人数无硬上限：8 名女友应允许建群
  const many: number[] = [];
  for (let i = 1; i <= 8; i++) many.push(makeGirlfriend(`群员${i}`));
  const big = groupMod.createGroup('人很多', null, many);
  assert.ok(big.ok, '>6 名应有允许（无硬上限）');
  assert.equal(groupMod.listMemberIds(big.group!.id).length, 8);
});

test('建群/改群/解散：消息落 group_messages，成员增删下限 2（无上限）', () => {
  const a = makeGirlfriend('增删甲');
  const b = makeGirlfriend('增删乙');
  const c = makeGirlfriend('增删丙');
  const g = groupMod.createGroup('增删群', '测试', [a, b]);
  assert.ok(g.ok && g.group);
  const gid = g.group.id;
  assert.deepEqual(groupMod.listMemberIds(gid).sort(), [a, b].sort());

  // 加成员
  const add = groupMod.updateGroup(gid, { add: [c], name: '改名群' });
  assert.ok(add.ok);
  assert.equal(groupMod.listMemberIds(gid).length, 3);
  assert.equal(groupMod.getGroup(gid)?.name, '改名群');

  // 大批量加成员（>6）应允许（无硬上限）
  const extra: number[] = [];
  for (let i = 1; i <= 6; i++) extra.push(makeGirlfriend(`增删批量${i}`));
  assert.ok(groupMod.updateGroup(gid, { add: extra }).ok, '批量加成员应无上限');
  assert.equal(groupMod.listMemberIds(gid).length, 9);

  // 减到只剩 1 名 → 拒绝
  const shrink = groupMod.updateGroup(gid, { remove: [b, c, ...extra] });
  assert.equal(shrink.ok, false);
  assert.equal(shrink.code, 'INVALID_INPUT');
  // 合法减员（移除其余，回到 2 人）
  assert.ok(groupMod.updateGroup(gid, { remove: [c, ...extra] }).ok);
  assert.equal(groupMod.listMemberIds(gid).length, 2);

  // 消息落库
  assert.ok(groupMod.getGroupDetail(gid)?.messages !== undefined);

  // 解散
  assert.ok(groupMod.deleteGroup(gid).ok);
  assert.equal(groupMod.getGroup(gid), null);
  assert.equal(Number(dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?', gid)?.c ?? 0), 0);
});

/* ================================================================== */
/* 5. 并发不串扰不死锁（叶子锁原则）                                    */
/* ================================================================== */
test('并发：群聊 run 与某成员私聊并发互不阻塞、数据各自正确', async () => {
  const a = makeGirlfriend('并发甲');
  const b = makeGirlfriend('并发乙');
  const g = groupMod.createGroup('并发群', null, [a, b]);
  const gid = g.group!.id;

  // 慢 chat：第一句挂起，直到外部放行 → 群聊 run 持续持有「群锁」
  let release: (s: string) => void = () => {};
  let firstCall = true;
  const slowChat: ChatFn = () => {
    if (firstCall) {
      firstCall = false;
      return new Promise<string>((res) => {
        release = res;
      });
    }
    return Promise.resolve('（笑）好呀。');
  };

  const groupTurn = groupRunMod.withGroupLock(gid, () =>
    groupMod.runGroupTurn(gid, '我们开始吧', { chatFn: slowChat, rng: () => 0.3, newRun: true })
  );

  // 等群聊 run 真正拿到群锁并停在 LLM 调用上
  await new Promise((r) => setTimeout(r, 120));

  // 同时对成员 a 进行「私聊写入」：走会话锁 + 伴侣作用域，必须不被群锁阻塞（叶子锁原则）
  const t0 = Date.now();
  const priv = await turnMod.withConversationLock(a, async () =>
    withCompanion(a, () => {
      dbRun(
        "INSERT INTO messages (companion_id, user_id, role, content, created_at) VALUES (?, ?, 'user', '只有私聊里才有的消息', ?)",
        a,
        dbMod.DEFAULT_USER_ID,
        new Date().toISOString()
      );
      return 'ok';
    })
  );
  const elapsed = Date.now() - t0;
  assert.equal(priv, 'ok');
  assert.ok(elapsed < 2000, `私聊不应被群锁长时间阻塞（实际 ${elapsed}ms）`);

  // 放行群聊并收尾
  release('（笑）我们继续聊。');
  const gr = await groupTurn;
  assert.equal(gr.ok, true);

  // 数据各自正确：
  // - 私聊消息只落在 a 的 messages
  const privCount = Number(dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM messages WHERE companion_id = ?', a)?.c ?? 0);
  assert.ok(privCount >= 1, '私聊消息应写入该伴侣的 messages');
  // - 群消息只落在 group_messages，且绝不包含私聊内容（零串扰）
  const groupCount = Number(dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM group_messages WHERE group_id = ?', gid)?.c ?? 0);
  assert.ok(groupCount >= 1, '群消息应写入 group_messages');
  const leaked = Number(
    dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM group_messages WHERE group_id = ? AND content LIKE '%只有私聊里才有的消息%'", gid)?.c ?? 0
  );
  assert.equal(leaked, 0, '私聊内容不得串入群消息');
  // - 其它伴侣（b）未被私聊污染
  const bPriv = Number(dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM messages WHERE companion_id = ? AND content = '只有私聊里才有的消息'", b)?.c ?? 0);
  assert.equal(bPriv, 0, '私聊消息不得串扰到其它伴侣');
});
