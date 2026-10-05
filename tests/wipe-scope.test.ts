// 恢复出厂范围回归（P1-35）：wipeAllData 覆盖 life_arcs / agent_diaries / model_profiles / v12 新表
// 隐私：使用独立临时库（os.tmpdir），绝不触碰 data/ 下的真实数据
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `gf-test-wipe-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置

const dbMod = await import('../src/lib/db.ts');
const lifeMod = await import('../src/lib/life.ts');
const profilesMod = await import('../src/lib/profiles.ts');

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });
});

const U = dbMod.DEFAULT_USER_ID;
const count = (table: string): number =>
  Number(dbMod.dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id = ?`, U)?.c ?? 0);

const TABLES = [
  'life_arcs',
  'agent_diaries',
  'model_profiles',
  'conversation_turns',
  'message_generations',
  'analysis_jobs',
  'turn_operations',
  'intimacy_aftercare',
  'intimacy_preferences',
  'world_weekly_snapshots',
];

test('P1-35 wipeAllData 清空 life_arcs / agent_diaries / model_profiles / v12 新表', () => {
  lifeMod.ensureLife();
  const now = new Date().toISOString();

  dbMod.dbRun('INSERT INTO life_arcs (user_id, title, started_at, updated_at) VALUES (?, ?, ?, ?)', U, '测试生活线', now, now);
  dbMod.dbRun('INSERT INTO agent_diaries (user_id, date, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', U, '2026-10-01', '今天写日记', now, now);
  dbMod.dbRun('INSERT INTO model_profiles (user_id, label, base_url, api_key, chat_model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', U, '测试档案', 'http://localhost', 'k', 'm', now, now);
  dbMod.dbRun('INSERT INTO conversation_turns (user_id, sequence, created_at) VALUES (?, ?, ?)', U, 1, now);
  dbMod.dbRun('INSERT INTO message_generations (user_id, turn_id, generation_no, created_at) VALUES (?, ?, ?, ?)', U, 1, 1, now);
  dbMod.dbRun('INSERT INTO analysis_jobs (user_id, created_at) VALUES (?, ?)', U, now);
  dbMod.dbRun('INSERT INTO turn_operations (user_id, operation_type, target_table, created_at) VALUES (?, ?, ?, ?)', U, 'insert', 'messages', now);
  dbMod.dbRun('INSERT INTO intimacy_aftercare (user_id, aftercare_quality, created_at) VALUES (?, ?, ?)', U, 'good', now);
  dbMod.dbRun('INSERT INTO intimacy_preferences (user_id, preference_type, content, created_at) VALUES (?, ?, ?, ?)', U, 'style', '测试偏好', now);
  dbMod.dbRun('INSERT INTO world_weekly_snapshots (user_id, week, state_json, created_at) VALUES (?, ?, ?, ?)', U, '2026-W40', '{}', now);

  // 注意：ensureLife 会播种 5 条出厂亲密偏好，故这里用 >=1 断言"有数据"即可
  for (const t of TABLES) assert.ok(count(t) >= 1, `${t} 造数据后应有数据`);

  dbMod.wipeAllData(true);

  for (const t of TABLES) assert.equal(count(t), 0, `${t} 恢复出厂后应为空`);
});

test('P1-35 恢复出厂保留设置；清掉 model_profiles 后播种逻辑可重建', () => {
  // 上一步 wipe 时 keepSettings=true，设置仍在
  assert.equal(dbMod.getSetting('life_enabled'), 'true', '恢复出厂不应清掉设置');

  assert.equal(count('model_profiles'), 0);
  profilesMod.seedProfilesIfEmpty();
  assert.ok(count('model_profiles') > 0, 'profiles 播种逻辑应在清空后重建档案');
});