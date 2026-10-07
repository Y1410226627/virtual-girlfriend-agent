// 候选人来源（需求变更）：① 她身边的人（cast）升格 ② 交往中自动识别 ③ 陌生人
// 隐私：使用独立临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-origin-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB;

const dbMod = await import('../src/lib/db.ts');
const ctxMod = await import('../src/lib/companion-context.ts');
const genMod = await import('../src/lib/candidate-gen.ts');
const lifeMod = await import('../src/lib/life.ts');
const lifeSharedMod = await import('../src/lib/life-shared.ts');
const compMod = await import('../src/lib/companion.ts');
const relMod = await import('../src/lib/companion-relations.ts');

const { dbRun, dbGet, DEFAULT_USER_ID } = dbMod;
const { withCompanion } = ctxMod;

dbMod.getDb();

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

function insertMessage(companionId: number, role: string, content: string): void {
  dbRun(
    `INSERT INTO messages (companion_id, user_id, role, content, is_proactive, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
    companionId,
    DEFAULT_USER_ID,
    role,
    content,
    new Date().toISOString()
  );
}

/** 主女友（companion 1）先建好生活面板，才能写 cast */
function seedPrimaryCast(cast: { name: string; role: string; note: string }[]): void {
  withCompanion(1, () => {
    lifeMod.ensureLife();
    lifeSharedMod.setCast(cast);
  });
}

/* ---------------------- ① cast 升格 ---------------------- */
test('cast 升格：她的室友 → 候选人，名字/关系角色保留，来历可追溯', async () => {
  seedPrimaryCast([
    { name: '小雨', role: '室友', note: '安静，爱看书，和她是大学同学' },
    { name: '阿岚', role: '同事', note: '外向，爱运动' },
  ]);

  const res = await genMod.generateCandidateFromCast(
    1,
    { name: '小雨', role: '室友', note: '安静，爱看书，和她是大学同学' },
    { forceTemplate: true, ownerName: '测试主女友' }
  );
  assert.ok(res.ok, res.ok ? '' : `生成失败：${res.code} ${res.error}`);

  const row = dbGet<{ name: string; identity: string; origin_kind: string; origin_companion_id: number; first_meet_scene: string; pending: number }>(
    'SELECT name, identity, origin_kind, origin_companion_id, first_meet_scene, pending FROM companions WHERE id = ?',
    Number(res.row.id)
  );
  assert.equal(row?.name, '小雨', '名字必须保留 cast 里的名字');
  assert.equal(row?.identity, '室友', '关系角色应作为身份');
  assert.equal(row?.origin_kind, 'cast');
  assert.equal(Number(row?.origin_companion_id), 1, '应记录"通过谁认识"');
  assert.ok(String(row?.first_meet_scene || '').includes('室友'), '初见场景应体现"她的室友"');
  assert.equal(Number(row?.pending), 1, '升格后进入发现区待处理');

  // 去重：同一个 cast 成员不会重复升格
  const dup = await genMod.generateCandidateFromCast(1, { name: '小雨', role: '室友', note: 'x' }, { forceTemplate: true, ownerName: '测试主女友' });
  assert.equal(dup.ok, false);
  assert.equal(dup.ok ? '' : dup.code, 'DUPLICATE');
});

/* ---------------------- ② 自动识别 ---------------------- */
test('detectCastMentions：她被反复提到的人才会浮现（确定性文本扫描）', () => {
  seedPrimaryCast([
    { name: '小雨', role: '室友', note: '' },
    { name: '阿岚', role: '同事', note: '' },
  ]);
  // 清掉上一用例可能留下的候选，避免干扰计数
  dbRun("DELETE FROM companions WHERE origin_kind IN ('cast','auto')");

  insertMessage(1, 'assistant', '小雨今天又熬夜看书了，我说了她两句。');
  insertMessage(1, 'assistant', '晚上小雨带了夜宵回来。');
  insertMessage(1, 'user', '那阿岚呢？');
  insertMessage(1, 'assistant', '她今天还好。');

  const hits = genMod.detectCastMentions(1, { minCount: 2 });
  const names = hits.map((h) => h.name);
  assert.ok(names.includes('小雨'), '被提到 2 次的人应命中');
  assert.equal(names.includes('阿岚'), false, '只提到 1 次的人不应命中');
  assert.ok((hits.find((h) => h.name === '小雨')?.count ?? 0) >= 2);
});

test('autoDiscoverFromMentions：自动浮现为候选（origin_kind=auto），已是伴侣的跳过', async () => {
  dbRun("DELETE FROM companions WHERE origin_kind IN ('cast','auto')");
  dbRun('DELETE FROM messages WHERE companion_id = 1');
  seedPrimaryCast([
    { name: '雨澄', role: '闺蜜', note: '她最好的朋友' },
    { name: '岚姐', role: '同事', note: '' },
  ]);
  for (let i = 0; i < 3; i++) insertMessage(1, 'assistant', `今天和雨澄一起吃了饭，聊了很久。`);
  // 「岚姐」已在 companions 里存在（模拟已是候选/伴侣）→ 应被跳过
  dbRun(
    `INSERT INTO companions (user_id, name, age, gender, identity, status, is_primary, is_discovered, pending, pursue_opt_in, reject_count, created_at, updated_at)
     VALUES (?, '岚姐', 26, 'female', '同事', 'girlfriend', 0, 1, 0, 1, 0, ?, ?)`,
    DEFAULT_USER_ID,
    new Date().toISOString(),
    new Date().toISOString()
  );
  insertMessage(1, 'assistant', '岚姐今天也在，雨澄和她打招呼了。');
  insertMessage(1, 'assistant', '岚姐说下周一起吃饭。');

  const r = await genMod.autoDiscoverFromMentions(1, { ownerName: '测试主女友', minCount: 2 });
  assert.equal(r.created.length, 1, '应只新建 1 名（岚姐已存在被跳过）');
  assert.ok(r.skipped.includes('岚姐'), '已存在的同名角色应被跳过');
  const created = dbGet<{ name: string; origin_kind: string }>('SELECT name, origin_kind FROM companions WHERE id = ?', r.created[0]!);
  assert.equal(created?.name, '雨澄');
  assert.equal(created?.origin_kind, 'auto', '自动识别的来历标记为 auto');
});

test('maybeAutoDiscover：6 小时节流，短时间内第二次为空', async () => {
  dbRun("DELETE FROM companions WHERE origin_kind IN ('cast','auto')");
  seedPrimaryCast([{ name: '小满', role: '邻居', note: '' }]);
  dbRun('DELETE FROM messages WHERE companion_id = 1');
  insertMessage(1, 'assistant', '小满今天来借了本书。');
  insertMessage(1, 'assistant', '小满说明天还我。');

  const t0 = Date.now();
  const first = await genMod.maybeAutoDiscover(1, { ownerName: '测试主女友', minCount: 2, now: t0 });
  assert.equal(first.length, 1, '首次应浮现 1 名');
  const second = await genMod.maybeAutoDiscover(1, { ownerName: '测试主女友', minCount: 2, now: t0 + 60_000 });
  assert.equal(second.length, 0, '节流窗口内不应重复扫描');
  const third = await genMod.maybeAutoDiscover(1, { ownerName: '测试主女友', minCount: 2, now: t0 + 7 * 3600_000 });
  assert.equal(third.length, 0, '窗口过后可再扫，但此人已存在 → 不再新建');
});

/* ---------------------- ③ 晋升：来历联动关系网 ---------------------- */
test('晋升 cast 来源的候选人：与介绍人建立初始关系边（熟人 +25）', async () => {
  dbRun("DELETE FROM companions WHERE origin_kind IN ('cast','auto')");
  dbRun('DELETE FROM companion_relations');
  const res = await genMod.generateCandidateFromCast(
    1,
    { name: '知夏', role: '室友', note: '' },
    { forceTemplate: true, ownerName: '测试主女友' }
  );
  assert.ok(res.ok);
  const id = Number(res.row.id);

  const promoted = compMod.promote(id);
  assert.ok(promoted.ok, '晋升应成功');
  const edges = relMod.listRelationsFor(id);
  assert.equal(edges.length, 1, '应建立一条与她介绍人的关系边');
  const edge = edges[0]!;
  assert.equal(Number(edge.a_id), 1, '规范序：小 id 在前');
  assert.equal(Number(edge.b_id), id);
  assert.ok(Number(edge.value) >= 20, `熟人初始关系值应为正向（实际 ${edge.value}）`);

  // 幂等：再次晋升不应重复建边
  compMod.promote(id);
  assert.equal(relMod.listRelationsFor(id).length, 1, '关系边不应重复');
});

/* ---------------------- ④ 无上限 ---------------------- */
test('数量无上限：待处理候选人可超过软上限', async () => {
  dbRun('DELETE FROM companions WHERE pending = 1');
  const now = new Date().toISOString();
  for (let i = 0; i < genMod.PENDING_SOFT_LIMIT; i++) {
    dbRun(
      `INSERT INTO companions (user_id, name, age, gender, status, is_primary, is_discovered, pending, pursue_opt_in, reject_count, created_at, updated_at)
       VALUES (?, ?, 24, 'female', 'stranger', 0, 0, 1, 0, 0, ?, ?)`,
      DEFAULT_USER_ID,
      `上限测试${i}-${Date.now()}`,
      now,
      now
    );
  }
  assert.equal(genMod.countPendingCandidates(), genMod.PENDING_SOFT_LIMIT);
  const over = await genMod.generateCandidate({ forceTemplate: true, seed: 'no-limit' });
  assert.ok(over.ok, '超过软上限仍应能生成');
  assert.ok(genMod.countPendingCandidates() > genMod.PENDING_SOFT_LIMIT);
  dbRun('DELETE FROM companions WHERE pending = 1');
});
