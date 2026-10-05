// 性格周快照：保存 / 列出 / 回滚（从 personality.ts 拆出，单向依赖 personality-core）
import { dbAll, dbRun, dbGet, DEFAULT_USER_ID, setCounter } from './db';
import { nowIso } from './utils';
import { personalityMap, manualAdjust } from './personality-core';

export interface PersonalitySnapshotRow {
  id: number;
  user_id: number;
  week: string;
  values_json: string;
  created_at: string;
}

function weekKey(d = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function saveWeeklySnapshot(): void {
  const week = weekKey();
  // 同一周存在则更新（UPSERT），保证周内多次调整后快照反映最新状态
  dbRun(
    `INSERT INTO personality_snapshots (user_id, week, values_json, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, week) DO UPDATE SET values_json = excluded.values_json`,
    DEFAULT_USER_ID,
    week,
    JSON.stringify(personalityMap()),
    nowIso()
  );
}

export function listSnapshots(limit = 30) {
  return dbAll<PersonalitySnapshotRow>(
    'SELECT * FROM personality_snapshots WHERE user_id = ? ORDER BY week DESC LIMIT ?',
    DEFAULT_USER_ID,
    limit
  );
}

export function rollbackToSnapshot(snapshotId: number): boolean {
  const snap = dbGet<PersonalitySnapshotRow>('SELECT * FROM personality_snapshots WHERE id = ? AND user_id = ?', snapshotId, DEFAULT_USER_ID);
  if (!snap) return false;
  const values = JSON.parse(snap.values_json) as Record<string, number>;
  for (const [dim, v] of Object.entries(values)) {
    manualAdjust(dim, Number(v), `回滚到 ${snap.week} 的性格快照`);
    // 回滚同时重置固化状态与变化速率计时，否则旧值上仍挂着"半固化"
    dbRun(
      'UPDATE personality_state SET solidified = 0, last_adjusted_turn = 0, updated_at = ? WHERE user_id = ? AND dimension = ?',
      nowIso(),
      DEFAULT_USER_ID,
      dim
    );
    setCounter(`solidify_streak_${dim}`, 0);
  }
  return true;
}