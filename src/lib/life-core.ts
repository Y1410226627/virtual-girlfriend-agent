// 生活系统 · 核心层：表初始化 / 基础读写 / 日志 / 手动直控状态 / 生病与生理周期
// 由 life.ts 拆分而来（原样搬移，行为不变）
import { dbAll, dbGet, dbRun, DEFAULT_USER_ID, getSetting, setSetting } from './db';
import { clamp, nowIso, round1, safeJson } from './utils';
import { logRelationship } from './relationship';

/* ------------------------------------------------------------------ */
/* 表初始化                                                            */
/* ------------------------------------------------------------------ */
/** 她身边的人：默认两位角色（cast 为空时播种，性质上只播一次） */
export const DEFAULT_CAST: Array<{ name: string; role: string; note: string }> = [
  { name: '小夏', role: '室友', note: '同一个宿舍，爱睡懒觉，常一起点外卖' },
  { name: '阿悦', role: '闺蜜', note: '隔壁班，从高中就认识，爱拉着她逛街' },
];

export function ensureLife(): void {
  const now = nowIso();
  dbRun('INSERT OR IGNORE INTO agent_health (user_id, updated_at) VALUES (?, ?)', DEFAULT_USER_ID, now);
  dbRun('INSERT OR IGNORE INTO agent_psychology (user_id, updated_at) VALUES (?, ?)', DEFAULT_USER_ID, now);
  dbRun('INSERT OR IGNORE INTO agent_location (user_id, current_location, location_type, arrived_at, updated_at) VALUES (?, ?, ?, ?, ?)', DEFAULT_USER_ID, '家', 'home', now, now);
  dbRun('INSERT OR IGNORE INTO agent_activity (user_id, current_activity, activity_type, started_at, updated_at) VALUES (?, ?, ?, ?, ?)', DEFAULT_USER_ID, '发呆', 'idle', now, now);
  dbRun('INSERT OR IGNORE INTO agent_profile (user_id, reveal_status, updated_at) VALUES (?, ?, ?)', DEFAULT_USER_ID, '{}', now);
  dbRun(
    'INSERT OR IGNORE INTO shared_world (user_id, shared_places_json, shared_plans_json, shared_rituals_json, shared_items_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    DEFAULT_USER_ID, '[]', '[]', '[]', '[]', now
  );
  // 她身边的人：只在"从未播种过"时种一次（用户把 cast 清空/删光后，重启不该被种回来）
  if (getSetting('cast_seeded') !== '1') {
    setSetting('cast_seeded', '1');
    const worldRow = dbGet<{ cast_json: string | null }>('SELECT cast_json FROM shared_world WHERE user_id = ?', DEFAULT_USER_ID);
    if (!worldRow || !worldRow.cast_json || safeJson<CastMember[]>(worldRow.cast_json, []).length === 0) {
      dbRun('UPDATE shared_world SET cast_json = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(DEFAULT_CAST), nowIso(), DEFAULT_USER_ID);
    }
  }
  dbRun('INSERT OR IGNORE INTO intimacy_state (user_id, updated_at) VALUES (?, ?)', DEFAULT_USER_ID, now);
  dbRun('INSERT OR IGNORE INTO intimacy_content_level (user_id, level, updated_at) VALUES (?, 0, ?)', DEFAULT_USER_ID, now);
  // 只在"从未播种过"时种一次：用户删掉自己的偏好后，重启不该被种回来
  if (getSetting('prefs_seeded') !== '1') {
    setSetting('prefs_seeded', '1');
    if (!dbGet('SELECT id FROM intimacy_preferences WHERE user_id = ? LIMIT 1', DEFAULT_USER_ID)) {
      seedPreferences();
    }
  }
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */
export interface HealthRow {
  energy: number; sleep_quality: number; hunger: number; illness: string;
  illness_start: string | null; illness_duration_days: number | null; illness_severity: number;
  cared_count: number; cycle_enabled: number; cycle_day: number; cycle_length: number;
  exercise: number; last_meal_at: string | null; woke_at: string | null; updated_at: string;
}
export interface PsychRow {
  base_emotion: string; stress: number; loneliness: number; missing_user: number;
  security: number; self_worth: number; mental_energy: number; updated_at: string;
}
export interface LocationRow { current_location: string; location_type: string; arrived_at: string | null; expected_leave_at: string | null; updated_at: string }
export interface ActivityRow { current_activity: string; activity_type: string; started_at: string | null; expected_end_at: string | null; updated_at: string }

export function getHealth(): HealthRow {
  let row = dbGet<HealthRow>('SELECT * FROM agent_health WHERE user_id = ?', DEFAULT_USER_ID);
  if (!row) {
    ensureLife();
    row = dbGet<HealthRow>('SELECT * FROM agent_health WHERE user_id = ?', DEFAULT_USER_ID);
  }
  return row!;
}
export function getPsychology(): PsychRow {
  let row = dbGet<PsychRow>('SELECT * FROM agent_psychology WHERE user_id = ?', DEFAULT_USER_ID);
  if (!row) {
    ensureLife();
    row = dbGet<PsychRow>('SELECT * FROM agent_psychology WHERE user_id = ?', DEFAULT_USER_ID);
  }
  return row!;
}
export function getLocation(): LocationRow {
  let row = dbGet<LocationRow>('SELECT * FROM agent_location WHERE user_id = ?', DEFAULT_USER_ID);
  if (!row) {
    ensureLife();
    row = dbGet<LocationRow>('SELECT * FROM agent_location WHERE user_id = ?', DEFAULT_USER_ID);
  }
  return row!;
}
export function getActivity(): ActivityRow {
  let row = dbGet<ActivityRow>('SELECT * FROM agent_activity WHERE user_id = ?', DEFAULT_USER_ID);
  if (!row) {
    ensureLife();
    row = dbGet<ActivityRow>('SELECT * FROM agent_activity WHERE user_id = ?', DEFAULT_USER_ID);
  }
  return row!;
}
/** agent_profile 行（SELECT *；各字段均为 TEXT） */
export interface ProfileSeed {
  reveal: Record<string, boolean>;
  [field: string]: string | null | Record<string, boolean>;
}

export function getProfileSeed(): ProfileSeed {
  const row = dbGet<Record<string, string | null>>('SELECT * FROM agent_profile WHERE user_id = ?', DEFAULT_USER_ID);
  if (!row) return { reveal: {} };
  return { ...row, reveal: safeJson<Record<string, boolean>>(row.reveal_status, {}) };
}

export interface CastMember { name: string; role: string; note: string }

/** life_state_logs 行 */
export interface LifeLogRow { id: number; field: string; old_value: string | null; new_value: string | null; reason: string | null; created_at: string }
/** agent_daily_events 行 */
export interface DailyEventRow { id: number; event_type: string; content: string; impact_json: string | null; created_at: string }

export function listLifeLogs(limit = 60, sinceIso?: string) {
  return sinceIso
    ? dbAll<LifeLogRow>('SELECT * FROM life_state_logs WHERE user_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?', DEFAULT_USER_ID, sinceIso, limit)
    : dbAll<LifeLogRow>('SELECT * FROM life_state_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?', DEFAULT_USER_ID, limit);
}
export function listDailyEvents(limit = 30, sinceIso?: string) {
  return sinceIso
    ? dbAll<DailyEventRow>('SELECT * FROM agent_daily_events WHERE user_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?', DEFAULT_USER_ID, sinceIso, limit)
    : dbAll<DailyEventRow>('SELECT * FROM agent_daily_events WHERE user_id = ? ORDER BY id DESC LIMIT ?', DEFAULT_USER_ID, limit);
}
/** 日常事件真实总数（接口返回最多 30 条明细时，用真实总数给前端显示"共 N 条"） */
export function countDailyEvents(): number {
  const row = dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM agent_daily_events WHERE user_id = ?', DEFAULT_USER_ID);
  return Number(row?.c || 0);
}

/* ------------------------------------------------------------------ */
/* 手动直控状态（"她的世界"页）                                          */
/* ------------------------------------------------------------------ */

/** 手动设定她此刻的身体数值（绝对值，clamp 0-100，cycle_day 1-60） */
export function setHealthStates(h: Partial<HealthRow> & { cycle_day?: number }): void {
  const cur = getHealth();
  const numOr = (v: unknown, fallback: number) => {
    const n = Number(v);
    return isFinite(n) ? n : fallback;
  };
  dbRun(
    'UPDATE agent_health SET energy = ?, sleep_quality = ?, hunger = ?, exercise = ?, cycle_day = ?, updated_at = ? WHERE user_id = ?',
    round1(clamp(numOr(h.energy, cur.energy), 0, 100)),
    round1(clamp(numOr(h.sleep_quality, cur.sleep_quality), 0, 100)),
    round1(clamp(numOr(h.hunger, cur.hunger), 0, 100)),
    round1(clamp(numOr(h.exercise, cur.exercise), 0, 100)),
    Math.round(clamp(numOr(h.cycle_day, cur.cycle_day), 1, 60)),
    nowIso(),
    DEFAULT_USER_ID
  );
}

/** 手动设定她此刻的心理数值（绝对值，clamp 0-100） */
export function setPsychologyStates(p: Partial<PsychRow>): void {
  const cur = getPsychology();
  const numOr = (v: unknown, fallback: number) => {
    const n = Number(v);
    return isFinite(n) ? n : fallback;
  };
  dbRun(
    'UPDATE agent_psychology SET stress = ?, loneliness = ?, missing_user = ?, security = ?, self_worth = ?, mental_energy = ?, updated_at = ? WHERE user_id = ?',
    round1(clamp(numOr(p.stress, cur.stress), 0, 100)),
    round1(clamp(numOr(p.loneliness, cur.loneliness), 0, 100)),
    round1(clamp(numOr(p.missing_user, cur.missing_user), 0, 100)),
    round1(clamp(numOr(p.security, cur.security), 0, 100)),
    round1(clamp(numOr(p.self_worth, cur.self_worth), 0, 100)),
    round1(clamp(numOr(p.mental_energy, cur.mental_energy), 0, 100)),
    nowIso(),
    DEFAULT_USER_ID
  );
}

/** 手动设定档案字段（昵称/年龄/职业/故事等） */
export function setProfileField(field: string, value: string): void {
  dbRun(`UPDATE agent_profile SET ${field} = ?, updated_at = ? WHERE user_id = ?`, value, nowIso(), DEFAULT_USER_ID);
}

/** 隐藏一个已揭露的档案字段（从 reveal_status 里移除） */
export function hideProfileField(field: string): void {
  const seed = getProfileSeed();
  const reveal = { ...(seed.reveal || {}) };
  delete reveal[String(field || '')];
  dbRun('UPDATE agent_profile SET reveal_status = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(reveal), nowIso(), DEFAULT_USER_ID);
}

/** 直接结束病程（不经历康复过程） */
export function clearIllness(): void {
  dbRun('UPDATE agent_health SET illness = ?, illness_severity = 0, updated_at = ? WHERE user_id = ?', 'none', nowIso(), DEFAULT_USER_ID);
}

/** 设定生理期开关与当前天数 */
export function setCycle(enabled: boolean, day: number): void {
  dbRun('UPDATE agent_health SET cycle_enabled = ?, cycle_day = ? WHERE user_id = ?', enabled ? 1 : 0, Math.round(clamp(day, 1, 60)), DEFAULT_USER_ID);
}

/**
 * 只切换生理期开关。
 * 重新开启（此前是关闭状态）视为新周期开始，cycle_day 重置为 1——
 * 否则关闭数周后再打开会显示"第 28 天"，intimacy.ts 的周期系数也会按错误天数生效。
 */
export function setCycleEnabled(enabled: boolean): void {
  const cur = getHealth();
  if (enabled && cur.cycle_enabled !== 1) {
    dbRun('UPDATE agent_health SET cycle_enabled = 1, cycle_day = 1 WHERE user_id = ?', DEFAULT_USER_ID);
    return;
  }
  dbRun('UPDATE agent_health SET cycle_enabled = ? WHERE user_id = ?', enabled ? 1 : 0, DEFAULT_USER_ID);
}

export function logLife(field: string, oldV: unknown, newV: unknown, reason: string) {
  dbRun(
    'INSERT INTO life_state_logs (user_id, field, old_value, new_value, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    DEFAULT_USER_ID, field, String(oldV ?? ''), String(newV ?? ''), reason, nowIso()
  );
}

/* ------------------------------------------------------------------ */
/* 生病 / 生理周期                                                      */
/* ------------------------------------------------------------------ */
export function startIllness(kind = '感冒', days = 2): void {
  const h = getHealth();
  dbRun(
    'UPDATE agent_health SET illness = ?, illness_start = ?, illness_duration_days = ?, illness_severity = ?, energy = ?, updated_at = ? WHERE user_id = ?',
    kind, nowIso(), round1(days), 40, clamp(h.energy - 25, 5, 100), nowIso(), DEFAULT_USER_ID
  );
  logLife('illness', h.illness, kind, `生病了（预计 ${round1(days)} 天）`);
  logRelationship('milestone', `她的状态：开始${kind}（预计 ${round1(days)} 天恢复）`, null, kind, '健康系统');
}

export function careBoost(kind: 'illness' | 'sick' | 'care'): void {
  const h = getHealth();
  dbRun('UPDATE agent_health SET cared_count = cared_count + 1, updated_at = ? WHERE user_id = ?', nowIso(), DEFAULT_USER_ID);
  if (h.illness !== 'none') {
    // 被关心 → 恢复加快（最多提前 40%）
    const dur = h.illness_duration_days || 2;
    const newDur = Math.max(0.5, dur * 0.85);
    dbRun('UPDATE agent_health SET illness_duration_days = ? WHERE user_id = ?', round1(newDur), DEFAULT_USER_ID);
  }
  const psy = getPsychology();
  dbRun(
    'UPDATE agent_psychology SET security = ?, self_worth = ?, loneliness = ?, updated_at = ? WHERE user_id = ?',
    round1(clamp(psy.security + 8, 0, 100)), round1(clamp(psy.self_worth + 6, 0, 100)),
    round1(clamp(psy.loneliness - 12, 0, 100)), nowIso(), DEFAULT_USER_ID
  );
  logLife('care', kind, '被关心', '用户关心行为加速恢复、提升安全感');
}

/* ------------------------------------------------------------------ */
/* 日常轨迹（按她的身份推导；默认是"大一学生"，与你们的故事一致）        */
/* ------------------------------------------------------------------ */
export function isWeekend(d: Date): boolean {
  const w = d.getDay();
  return w === 0 || w === 6;
}

/* ------------------------------------------------------------------ */
/* 亲密偏好的默认播种（供 ensureLife 首次调用）                          */
/* ------------------------------------------------------------------ */
export function seedPreferences(): void {
  const now = nowIso();
  const items: Array<[string, string, string, number]> = [
    ['atmosphere', '喜欢安静、灯光柔和的环境，说话要慢', 'hidden', 2],
    ['style', '更喜欢温柔和慢慢来，不喜欢太急', 'hidden', 1],
    ['address', '被叫亲昵称呼会觉得害羞', 'hidden', 2],
    ['place', '喜欢被摸头发', 'hidden', 2],
    ['aftercare', '结束后想被抱着说会儿话，不要马上去做别的', 'hidden', 2],
  ];
  for (const [type, content, status, revealStage] of items) {
    dbRun(
      'INSERT INTO intimacy_preferences (user_id, preference_type, content, reveal_status, reveal_stage, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      DEFAULT_USER_ID, type, content, status, revealStage, now
    );
  }
}