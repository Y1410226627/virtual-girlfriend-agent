// 她写日记时的"破壁词"兜底回归（P3）：
// 关键是不能误杀正常日记（含 aim/rain/wait 与"系统解剖学"这类把禁用词嵌进更长词的表达），
// 同时真正把 AI/系统设定写进日记的内容仍要被拦下。
// 隐私：按仓库约定用独立临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-diary-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const lifeMod = await import('../src/lib/life-arc.ts');

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

test('正常日记不被误杀：含 aim / rain / wait 的英文片段', () => {
  assert.equal(
    lifeMod.hasForbiddenDiaryTerm('today it rained, I was waiting for him, my aim was to finish my homework'),
    false
  );
});

test('正常日记不被误杀：把禁用词嵌进更长词的正常中文表达', () => {
  assert.equal(
    lifeMod.hasForbiddenDiaryTerm('上午背系统解剖学，下午在图书馆翻虚拟现实的书，晚上回宿舍。'),
    false
  );
});

test('真正破壁词被拦下：独立出现的 AI', () => {
  assert.equal(lifeMod.hasForbiddenDiaryTerm('今天AI帮我写了作业，感觉好神奇。'), true);
  assert.equal(lifeMod.hasForbiddenDiaryTerm('我是一个 AI'), true);
});

test('真正破壁词被拦下：独立出现的中文禁用词', () => {
  assert.equal(lifeMod.hasForbiddenDiaryTerm('奇怪的日记：模型。'), true);
});