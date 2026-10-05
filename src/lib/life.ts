// 世界模拟与生活系统：她有自己的作息、身体、心理、位置、活动与日常事件
// 设计要点：连续性优先（一切由"流逝了多少时间"推导，不随机跳变）、独立生活、逐步揭露、状态影响对话
import { dbAll, dbGet, dbRun, DEFAULT_USER_ID, getSetting, setSetting, boolSetting, numSetting, getCounter, setCounter } from './db';
import { clamp, nowIso, localHour, localDateStr, localTimeStr, round1, safeJson, hoursSince } from './utils';
import { chatJson, type ChatMessage } from './llm';
import { getRelationshipState, getPersona } from './relationship';
import { attachmentStyle, getAttachmentState } from './attachment';
import { personalityMap } from './personality';
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
    if (!worldRow || !worldRow.cast_json || safeJson<any[]>(worldRow.cast_json, []).length === 0) {
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
export function getProfileSeed(): Record<string, any> {
  const row = dbGet<any>('SELECT * FROM agent_profile WHERE user_id = ?', DEFAULT_USER_ID);
  if (!row) return {};
  return { ...row, reveal: safeJson<Record<string, boolean>>(row.reveal_status, {}) };
}
export function getSharedWorld() {
  const row = dbGet<any>('SELECT * FROM shared_world WHERE user_id = ?', DEFAULT_USER_ID);
  return {
    places: safeJson<any[]>(row?.shared_places_json, []),
    plans: safeJson<any[]>(row?.shared_plans_json, []),
    rituals: safeJson<any[]>(row?.shared_rituals_json, []),
    items: safeJson<any[]>(row?.shared_items_json, []),
    cast: safeJson<any[]>(row?.cast_json, []),
  };
}

export interface CastMember { name: string; role: string; note: string }

/** 她身边的人（具名社会关系）：规整化后返回 */
export function getCast(): CastMember[] {
  const arr = getSharedWorld().cast;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({
      name: String(c.name ?? '').trim(),
      role: String(c.role ?? '').trim(),
      note: String(c.note ?? '').trim(),
    }))
    .filter((c) => c.name);
}
export function listLifeLogs(limit = 60, sinceIso?: string) {
  return sinceIso
    ? dbAll<any>('SELECT * FROM life_state_logs WHERE user_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?', DEFAULT_USER_ID, sinceIso, limit)
    : dbAll<any>('SELECT * FROM life_state_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?', DEFAULT_USER_ID, limit);
}
export function listDailyEvents(limit = 30, sinceIso?: string) {
  return sinceIso
    ? dbAll<any>('SELECT * FROM agent_daily_events WHERE user_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?', DEFAULT_USER_ID, sinceIso, limit)
    : dbAll<any>('SELECT * FROM agent_daily_events WHERE user_id = ? ORDER BY id DESC LIMIT ?', DEFAULT_USER_ID, limit);
}

/* ------------------------------------------------------------------ */
/* 手动直控状态（"她的世界"页）                                          */
/* ------------------------------------------------------------------ */

/** 手动设定她此刻的身体数值（绝对值，clamp 0-100，cycle_day 1-60） */
export function setHealthStates(h: Partial<HealthRow> & { cycle_day?: number }): void {
  const cur = getHealth();
  const numOr = (v: any, fallback: number) => {
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
  const numOr = (v: any, fallback: number) => {
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

/** 把健康表的 updated_at 往回拨 N 小时，再推进一次（立刻看到生活变化） */
export function simulateHours(hours: number): { steps: number; changes: string[] } {
  const h = Math.min(72, Math.max(1, hours || 6));
  dbRun(
    'UPDATE agent_health SET updated_at = ? WHERE user_id = ?',
    new Date(Date.now() - h * 3600000).toISOString(),
    DEFAULT_USER_ID
  );
  return advanceLife();
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

/** 设定她身边的人（整组替换 [{name, role, note}]，已在路由侧做校验） */
export function setCast(cast: CastMember[]): void {
  dbRun('UPDATE shared_world SET cast_json = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(cast), nowIso(), DEFAULT_USER_ID);
}

/** 直接结束病程（不经历康复过程） */
export function clearIllness(): void {
  dbRun('UPDATE agent_health SET illness = ?, illness_severity = 0, updated_at = ? WHERE user_id = ?', 'none', nowIso(), DEFAULT_USER_ID);
}

/** 设定生理期开关与当前天数 */
export function setCycle(enabled: boolean, day: number): void {
  dbRun('UPDATE agent_health SET cycle_enabled = ?, cycle_day = ? WHERE user_id = ?', enabled ? 1 : 0, Math.round(clamp(day, 1, 60)), DEFAULT_USER_ID);
}

/** 只切换生理期开关（保留当前天数） */
export function setCycleEnabled(enabled: boolean): void {
  dbRun('UPDATE agent_health SET cycle_enabled = ? WHERE user_id = ?', enabled ? 1 : 0, DEFAULT_USER_ID);
}

export function logLife(field: string, oldV: any, newV: any, reason: string) {
  dbRun(
    'INSERT INTO life_state_logs (user_id, field, old_value, new_value, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    DEFAULT_USER_ID, field, String(oldV ?? ''), String(newV ?? ''), reason, nowIso()
  );
}

/* ------------------------------------------------------------------ */
/* 日常轨迹（按她的身份推导；默认是"大一学生"，与你们的故事一致）        */
/* ------------------------------------------------------------------ */
interface Block {
  from: number; to: number;
  location: string; locationType: string;
  activity: string; activityType: string;
}

function isWeekend(d: Date): boolean {
  const w = d.getDay();
  return w === 0 || w === 6;
}

/** 工作日作息 */
const WEEKDAY: Block[] = [
  { from: 0, to: 7, location: '家', locationType: 'home', activity: '睡觉', activityType: 'sleep' },
  { from: 7, to: 7.75, location: '家', locationType: 'home', activity: '刚起床，洗漱', activityType: 'morning' },
  { from: 7.75, to: 8.3, location: '家', locationType: 'home', activity: '吃早饭', activityType: 'meal' },
  { from: 8.3, to: 8.6, location: '路上', locationType: 'commute', activity: '去学校', activityType: 'commute' },
  { from: 8.6, to: 12, location: '教学楼', locationType: 'school', activity: '上课', activityType: 'class' },
  { from: 12, to: 12.8, location: '食堂', locationType: 'school', activity: '吃午饭', activityType: 'meal' },
  { from: 12.8, to: 14, location: '宿舍', locationType: 'home', activity: '午休', activityType: 'rest' },
  { from: 14, to: 17, location: '教室', locationType: 'school', activity: '上课', activityType: 'class' },
  { from: 17, to: 18, location: '食堂', locationType: 'school', activity: '吃晚饭', activityType: 'meal' },
  { from: 18, to: 19.2, location: '图书馆', locationType: 'school', activity: '自习、赶作业', activityType: 'study' },
  { from: 19.2, to: 20.2, location: '路上', locationType: 'commute', activity: '回宿舍', activityType: 'commute' },
  { from: 20.2, to: 21.8, location: '宿舍', locationType: 'home', activity: '窝着看剧、刷手机', activityType: 'leisure' },
  { from: 21.8, to: 22.3, location: '宿舍', locationType: 'home', activity: '洗澡', activityType: 'shower' },
  { from: 22.3, to: 23.5, location: '宿舍', locationType: 'home', activity: '躺床上刷手机', activityType: 'bed' },
  { from: 23.5, to: 24, location: '宿舍', locationType: 'home', activity: '睡觉', activityType: 'sleep' },
];

/** 周末作息 */
const WEEKEND: Block[] = [
  { from: 0, to: 9.5, location: '家', locationType: 'home', activity: '睡懒觉', activityType: 'sleep' },
  { from: 9.5, to: 10.5, location: '家', locationType: 'home', activity: '慢慢起床、吃早午饭', activityType: 'meal' },
  { from: 10.5, to: 12, location: '家', locationType: 'home', activity: '收拾房间、听歌', activityType: 'chores' },
  { from: 12, to: 13, location: '外面', locationType: 'out', activity: '吃午饭', activityType: 'meal' },
  { from: 13, to: 16, location: '咖啡店', locationType: 'cafe', activity: '在咖啡店看书、写东西', activityType: 'leisure' },
  { from: 16, to: 18, location: '街上', locationType: 'out', activity: '逛街、买东西', activityType: 'out' },
  { from: 18, to: 19.5, location: '外面', locationType: 'out', activity: '和朋友吃饭', activityType: 'meal' },
  { from: 19.5, to: 21.5, location: '家', locationType: 'home', activity: '窝着看电影', activityType: 'leisure' },
  { from: 21.5, to: 22.3, location: '家', locationType: 'home', activity: '洗澡', activityType: 'shower' },
  { from: 22.3, to: 24, location: '家', locationType: 'home', activity: '躺床上刷手机', activityType: 'bed' },
];

function blockAt(d: Date): Block {
  const table = isWeekend(d) ? WEEKEND : WEEKDAY;
  const h = d.getHours() + d.getMinutes() / 60;
  return table.find((b) => h >= b.from && h < b.to) || table[table.length - 1];
}

/* ------------------------------------------------------------------ */
/* 日常事件                                                            */
/* ------------------------------------------------------------------ */
const EVENT_POOL: Array<{ type: string; content: string; impact: Record<string, number>; when?: string[] }> = [
  { type: 'small', content: '在路边看到一只橘猫，蹲下来看了好久', impact: { mood: 6, loneliness: -4 } },
  { type: 'small', content: '买咖啡的时候洒到袖子上了，郁闷', impact: { stress: 6, mood: -3 } },
  { type: 'small', content: '上课差点睡着，被点起来回答问题', impact: { stress: 5, mental_energy: -6 } },
  { type: 'small', content: '室友带了小蛋糕回来，分了一块给她', impact: { mood: 7, self_worth: 3 } },
  { type: 'small', content: '下雨没带伞，淋了一小段路', impact: { mood: -4, illnessRisk: 0.08 } },
  { type: 'small', content: '刷到一部很想看的剧，加了收藏', impact: { mood: 5 } },
  { type: 'small', content: '和同学为小组作业的事有点分歧', impact: { stress: 8, mood: -4 } },
  { type: 'small', content: '在图书馆借到了一直想看的书', impact: { mood: 6, mental_energy: 4 } },
  { type: 'small', content: '突然很想他，翻了一下以前的聊天记录', impact: { missing_user: 10, mood: 2 } },
  { type: 'small', content: '手机快没电又没带充电宝，一路都很慌', impact: { stress: 4 } },
  { type: 'small', content: '今天状态不错，把拖了很久的作业写完了', impact: { self_worth: 8, stress: -8, mood: 5 } },
  { type: 'small', content: '路过一家新开的甜品店，记下来了想带他一起去', impact: { missing_user: 6, mood: 4 } },
];

function maybeGenerateEvent(d: Date, indep: number, block: Block): void {
  const todayCount = dbAll<any>(
    "SELECT id FROM agent_daily_events WHERE user_id = ? AND date(created_at, 'localtime') = ?",
    DEFAULT_USER_ID,
    localDateStr(d)
  ).length;
  const cap = indep >= 60 ? 4 : 3;
  if (todayCount >= cap) return;
  // 醒着、并且不是睡觉时间才有事件
  if (block.activityType === 'sleep') return;
  const slot = Math.floor(d.getHours() / 3);
  const seed = `${localDateStr(d)}:${slot}:${block.activityType}`;
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const normalized = (hash >>> 0) / 4294967296;
  const chance = (indep >= 60 ? 0.2 : 0.13) * (block.activityType === 'leisure' || block.activityType === 'out' ? 1.3 : 1);
  if (normalized > chance) return;
  const pick = EVENT_POOL[(hash >>> 8) % EVENT_POOL.length];
  dbRun(
    'INSERT INTO agent_daily_events (user_id, event_type, content, impact_json, created_at) VALUES (?, ?, ?, ?, ?)',
    DEFAULT_USER_ID, pick.type, pick.content, JSON.stringify(pick.impact), d.toISOString()
  );
  const psy = getPsychology();
  let stress = psy.stress, lon = psy.loneliness, miss = psy.missing_user, worth = psy.self_worth, me = psy.mental_energy;
  stress = clamp(stress + (pick.impact.stress || 0), 0, 100);
  lon = clamp(lon + (pick.impact.loneliness || 0), 0, 100);
  miss = clamp(miss + (pick.impact.missing_user || 0), 0, 100);
  worth = clamp(worth + (pick.impact.self_worth || 0), 0, 100);
  me = clamp(me + (pick.impact.mental_energy || 0), 0, 100);
  // 事件的心情影响：直接体现在情绪基调上（好心情 / 低落）
  const moodDelta = Number(pick.impact.mood || 0);
  const emotion = moodDelta >= 5 ? '开心' : moodDelta <= -4 ? '低落' : psy.base_emotion;
  dbRun(
    'UPDATE agent_psychology SET base_emotion = ?, stress = ?, loneliness = ?, missing_user = ?, self_worth = ?, mental_energy = ?, updated_at = ? WHERE user_id = ?',
    emotion, round1(stress), round1(lon), round1(miss), round1(worth), round1(me), nowIso(), DEFAULT_USER_ID
  );
  if ((pick.impact.illnessRisk || 0) > 0 && normalized < (pick.impact.illnessRisk as number)) {
    startIllness('感冒', 2 + ((hash >>> 16) % 2000) / 1000);
  }
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
/* 主推进：由流逝时间推导一切                                            */
/* ------------------------------------------------------------------ */
export function advanceLife(): { steps: number; changes: string[] } {
  ensureLife();
  if (!boolSetting('life_enabled', true)) return { steps: 0, changes: [] };
  const changes: string[] = [];
  const h0 = getHealth();
  const lastAt = new Date(h0.updated_at).getTime();
  const now = Date.now();
  const elapsedH = (now - lastAt) / 3600000;
  if (elapsedH < 0.25) return { steps: 0, changes: [] };

  const stepH = 0.5;
  const maxSteps = 96; // 单次最多模拟 48 小时；超出的余量只推进到已模拟处，下次继续（不再被吞掉）
  const steps = Math.min(maxSteps, Math.floor(elapsedH / stepH));
  // 历史回放从"上次更新的那一刻"往后一步步推，而不是从 now 往回推：
  // 这样离线 5 天时会先补最早的那 48 小时，且 updated_at 只推进已模拟的部分，剩下的留给下次
  const simStart = lastAt;
  const indep = Number(personalityMap().independence ?? 50);
  const att = attachmentStyle();
  const rel = getRelationshipState();
  const lastChatAt = rel.last_interaction_at ? new Date(rel.last_interaction_at).getTime() : NaN;
  let cycleDate = localDateStr(new Date(lastAt));
  // 可控事件进行中：作息表不覆盖她正在做的事（她说了"去睡了"，就一直睡到事件结束）
  const activeEvent = getActiveEvent();
  const activeEventStart = activeEvent ? new Date(activeEvent.started_at).getTime() : 0;
  const activeEventActType = activeEvent ? activityTypeOfEvent(activeEvent.event_type) : '';

  for (let k = 0; k < steps; k++) {
    const d = new Date(simStart + k * stepH * 3600000);
    const stepEnd = new Date(simStart + (k + 1) * stepH * 3600000);
    const hour = d.getHours() + d.getMinutes() / 60;
    let block = blockAt(d);
    const health = getHealth();
    const psy = getPsychology();
    const loc = getLocation();
    const act = getActivity();
    const eventStep = !!(activeEvent && isFinite(activeEventStart) && d.getTime() >= activeEventStart);
    if (eventStep) {
      block = {
        from: 0,
        to: 24,
        location: loc.current_location,
        locationType: loc.location_type,
        activity: activeEvent!.activity,
        activityType: activeEventActType,
      };
    }

    // 1) 位置 / 活动跟随作息（可控事件进行中不覆盖，事件行才是这段时间的真相）
    if (!eventStep && (block.location !== loc.current_location || block.activity !== act.current_activity)) {
      const endAt = stepEnd;
      dbRun(
        'UPDATE agent_location SET current_location = ?, location_type = ?, arrived_at = ?, expected_leave_at = ?, updated_at = ? WHERE user_id = ?',
        block.location, block.locationType, d.toISOString(), endAt.toISOString(), nowIso(), DEFAULT_USER_ID
      );
      dbRun(
        'UPDATE agent_activity SET current_activity = ?, activity_type = ?, started_at = ?, expected_end_at = ?, updated_at = ? WHERE user_id = ?',
        block.activity, block.activityType, d.toISOString(), endAt.toISOString(), nowIso(), DEFAULT_USER_ID
      );
      changes.push(`${block.activity}（${block.location}）`);
      logLife('activity', act.current_activity, block.activity, `作息时间到：${block.location}`);
    }

    // 2) 健康漂移
    let energy = health.energy;
    let hunger = health.hunger;
    let sleepQ = health.sleep_quality;
    let exercise = health.exercise;
    // 可控事件进行中：只按事件影响走（与"立即结束按等效时长结算"是同一套数值，避免两条路径差一倍）
    const eventEffect = eventStep && activeEvent ? EVENT_DRIFT[activeEvent.event_type] || EVENT_DRIFT.other : null;
    if (eventEffect) {
      energy = clamp(energy + (eventEffect.energy || 0), 0, 100);
      hunger = clamp(hunger + (eventEffect.hunger || 0), 0, 100);
      sleepQ = clamp(sleepQ + (eventEffect.sleepQ || 0), 0, 100);
      if (activeEvent!.event_type === 'meal') {
        dbRun('UPDATE agent_health SET last_meal_at = ? WHERE user_id = ?', d.toISOString(), DEFAULT_USER_ID);
      }
    } else if (block.activityType === 'sleep') {
      energy = clamp(energy + 9, 0, 100);
      hunger = clamp(hunger - 2.5, 0, 100);
      if (hour >= 6 && hour <= 9) sleepQ = clamp(sleepQ + (rel.unresolved_tension > 40 ? 2 : 5), 0, 100);
    } else {
      energy = clamp(energy - (block.activityType === 'class' || block.activityType === 'study' ? 3.4 : 2.2), 0, 100);
      hunger = clamp(hunger - (block.activityType === 'class' ? 7 : 5), 0, 100);
      if (block.activityType === 'shower' || block.activityType === 'bed') sleepQ = clamp(sleepQ + 1.2, 0, 100);
      if (block.activityType === 'meal') {
        hunger = clamp(hunger + 34, 0, 100);
        energy = clamp(energy + 5, 0, 100);
        dbRun('UPDATE agent_health SET last_meal_at = ? WHERE user_id = ?', d.toISOString(), DEFAULT_USER_ID);
      }
    }
    // 生病：随时间恢复（历史步如果早于发病时间，不按"满严重度"扣）
    let illness = health.illness;
    let severity = health.illness_severity;
    if (illness !== 'none') {
      const startedMs = health.illness_start ? new Date(health.illness_start).getTime() : NaN;
      const durH = (health.illness_duration_days || 2) * 24;
      const passedH = isFinite(startedMs) ? (d.getTime() - startedMs) / 3600000 : durH * 0.5;
      if (passedH >= -0.01) {
        severity = clamp(40 * (1 - passedH / durH), 0, 100);
        energy = clamp(energy - severity / 12, 0, 100);
        if (passedH >= durH) {
          illness = 'none';
          severity = 0;
          sleepQ = clamp(sleepQ - 8, 0, 100);
          logLife('illness', health.illness, '恢复', '病程结束');
          changes.push('病好了');
        }
      }
    }
    dbRun(
      `UPDATE agent_health SET energy = ?, hunger = ?, sleep_quality = ?, exercise = ?, illness = ?, illness_severity = ?, updated_at = ? WHERE user_id = ?`,
      round1(energy), round1(hunger), round1(sleepQ), round1(exercise), illness, round1(severity), stepEnd.toISOString(), DEFAULT_USER_ID
    );

    // 3) 生理周期（每天推进 1 天）
    const currentDate = localDateStr(d);
    if (currentDate !== cycleDate) {
      const daysPassed = Math.max(1, Math.round((new Date(`${currentDate}T00:00:00`).getTime() - new Date(`${cycleDate}T00:00:00`).getTime()) / 86400000));
      const cycleDay = ((health.cycle_day - 1 + daysPassed) % (health.cycle_length || 28)) + 1;
      dbRun('UPDATE agent_health SET cycle_day = ? WHERE user_id = ?', cycleDay, DEFAULT_USER_ID);
      cycleDate = currentDate;
    }

    // 4) 心理漂移
    // 与"此刻聊了多久"解耦：按这一步自己的时刻算（原来整段历史回放都用同一个"距今多久"，把过去的孤独全算错）
    const hoursSinceChat = isFinite(lastChatAt) ? Math.max(0, (d.getTime() - lastChatAt) / 3600000) : 999;
    let stress = psy.stress;
    let lon = psy.loneliness;
    let miss = psy.missing_user;
    let security = psy.security;
    let me = psy.mental_energy;
    const workLoad = block.activityType === 'class' || block.activityType === 'study' ? 3 : block.activityType === 'out' ? 1 : -1.5;
    // 事件步：基础作息漂移不叠加（数值只按事件影响走，和等效时长结算保持一致）
    stress = clamp(stress + (eventEffect ? 0 : workLoad * (stepH / 2)) + (illness !== 'none' ? 1.2 : 0), 0, 100);
    if (!eventEffect) {
      if (block.activityType === 'sleep' || block.activityType === 'rest') me = clamp(me + 6, 0, 100);
      else if (block.activityType === 'out' || block.activityType === 'leisure') me = clamp(me + 2, 0, 100);
      else me = clamp(me - (att === 'avoidant' ? 2.6 : 2), 0, 100);
    }
    // 事件的心理影响
    if (eventEffect) {
      if (eventEffect.me) me = clamp(me + eventEffect.me, 0, 100);
      if (eventEffect.stress) stress = clamp(stress + eventEffect.stress, 0, 100);
      if (eventEffect.loneliness) lon = clamp(lon + eventEffect.loneliness, 0, 100);
    }
    // 孤独 / 想念：越久没聊越高；独立性强上升慢
    const lonelyRate = (indep >= 60 ? 0.25 : 0.5) * (att === 'anxious' ? 1.5 : att === 'avoidant' ? 0.6 : 1);
    if (hoursSinceChat > 6) {
      lon = clamp(lon + lonelyRate * stepH, 0, 100);
      miss = clamp(miss + lonelyRate * 1.2 * stepH, 0, 100);
    } else {
      lon = clamp(lon - 3 * stepH, 0, 100);
      miss = clamp(miss - 1.5 * stepH, 0, 100);
    }
    // 安全感：与依恋、关系张力相关
    const secTarget = clamp(70 - rel.unresolved_tension * 0.5 + rel.repair_credit * 0.15 - (att === 'anxious' ? 20 : 0), 0, 100);
    security = clamp(security + (secTarget - security) * 0.04 * stepH, 0, 100);
    // 情绪基调
    let emotion = '平静';
    if (illness !== 'none' && severity > 25) emotion = '难受';
    else if (stress > 70) emotion = '烦躁';
    else if (lon > 60 || miss > 70) emotion = '想他';
    else if (energy > 80 && lon < 40) emotion = '开心';
    else if (energy < 30) emotion = '疲惫';
    dbRun(
      `UPDATE agent_psychology SET base_emotion = ?, stress = ?, loneliness = ?, missing_user = ?, security = ?, mental_energy = ?, updated_at = ? WHERE user_id = ?`,
      emotion,
      round1(stress),
      round1(lon),
      round1(miss),
      round1(security),
      round1(me),
      stepEnd.toISOString(),
      DEFAULT_USER_ID
    );

    // 5) 随机日常事件
    maybeGenerateEvent(d, indep, block);
  }

  return { steps, changes };
}

/* ------------------------------------------------------------------ */
/* 分析模型驱动的状态变化                                               */
/* ------------------------------------------------------------------ */
export function applyLifeDeltas(input: { health?: Record<string, any>; psychology?: Record<string, any> }): void {
  const hd = input.health || {};
  const pd = input.psychology || {};
  const h = getHealth();
  const p = getPsychology();
  const num = (v: any) => (isFinite(Number(v)) ? Number(v) : 0);

  const energy = clamp(h.energy + num(hd.energy), 0, 100);
  const hunger = clamp(h.hunger + num(hd.hunger), 0, 100);
  dbRun(
    'UPDATE agent_health SET energy = ?, hunger = ?, updated_at = ? WHERE user_id = ?',
    round1(energy), round1(hunger), nowIso(), DEFAULT_USER_ID
  );

  const illnessEvent = String(hd.illness || 'none');
  if (illnessEvent === 'new') {
    // 时长确定性推导（同一天同一轮给同样的值，避免随机跳变）
    const seed = Number(getCounter('turn_count') || 0);
    startIllness('感冒', 2 + (seed % 20) / 10);
  } else if (illnessEvent === 'recovered' && h.illness !== 'none') {
    // 模型判定"这轮之后康复了" → 直接结束病程（比机械等天数自然）
    dbRun(
      "UPDATE agent_health SET illness = 'none', illness_severity = 0, illness_duration_days = 0, updated_at = ? WHERE user_id = ?",
      nowIso(),
      DEFAULT_USER_ID
    );
    logLife('illness', h.illness, '恢复', '对话里被照顾，判定康复');
    logRelationship('milestone', `她的${h.illness}好了`, null, h.illness, '健康系统');
  }

  const stress = clamp(p.stress + num(pd.stress), 0, 100);
  const loneliness = clamp(p.loneliness + num(pd.loneliness), 0, 100);
  const missing = clamp(p.missing_user + num(pd.missing_user), 0, 100);
  const security = clamp(p.security + num(pd.security), 0, 100);
  const worth = clamp(p.self_worth + num(pd.self_worth), 0, 100);
  const me = clamp(p.mental_energy + num(pd.mental_energy), 0, 100);
  dbRun(
    `UPDATE agent_psychology SET stress = ?, loneliness = ?, missing_user = ?, security = ?, self_worth = ?, mental_energy = ?, updated_at = ? WHERE user_id = ?`,
    round1(stress), round1(loneliness), round1(missing), round1(security), round1(worth), round1(me), nowIso(), DEFAULT_USER_ID
  );
}

/* ------------------------------------------------------------------ */
/* 可控事件：她开始做一件事，用户可以控制它什么时候结束、到期她会主动来说 */
/* ------------------------------------------------------------------ */
export interface OngoingEventRow {
  id: number;
  user_id: number;
  activity: string;
  event_type: string;
  started_at: string;
  expected_end_at: string | null;
  duration_mode: string;
  notified_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** 活动名 → 事件类型 */
export function eventTypeOf(activity: string): string {
  const a = String(activity || '');
  if (/睡|午休|小憩|打盹|眯一会|躺下休息/.test(a)) return 'sleep';
  // 注意顺序：做饭/洗碗/买菜 必须在 meal 之前判断，否则"做饭"会被当成"吃了一顿"
  if (/收拾|打扫|洗衣服|做饭|家务|整理|晾|洗碗|买菜|清理/.test(a)) return 'chore';
  if (/吃|饭|餐|外卖|夜宵/.test(a)) return 'meal';
  if (/洗澡|洗漱|冲澡|洗头|泡澡/.test(a)) return 'shower';
  if (/运动|跑步|健身|瑜伽|游泳|打球|跳绳|锻炼|拉伸/.test(a)) return 'sport';
  if (/游戏|开黑|排位|下棋|打牌/.test(a)) return 'game';
  if (/聊天|视频|通话|打电话|聚会|串门|下午茶|约会/.test(a)) return 'social';
  if (/化妆|护肤|面膜|泡脚|敷|美甲|梳洗|洗脸|吹头发/.test(a)) return 'care';
  if (/上课|考试|开会|自习|写作业|写论文|工作|加班|学习|复习|背单词|网课|看文献/.test(a)) return 'focus';
  if (/出门|逛街|超市|商场|买东西|散步|遛|朋友|电影院|取快递|拿快递|逛逛/.test(a)) return 'out';
  if (/收拾|打扫|洗衣服|做饭|家务|整理|晾|洗碗|买菜|清理/.test(a)) return 'chore';
  if (/回家|路上|地铁|公交|打车|通勤|去学校|出发|赶车/.test(a)) return 'commute';
  if (/看剧|看电|看书|刷|听歌|躺|休息|发呆|放空|追剧/.test(a)) return 'leisure';
  return 'other';
}

/** 事件类型 → 作息推进用的 activity_type（沿用原有词汇） */
function activityTypeOfEvent(eventType: string): string {
  switch (eventType) {
    case 'sleep': return 'sleep';
    case 'meal': return 'meal';
    case 'shower': return 'shower';
    case 'focus': return 'class';
    case 'out': return 'out';
    case 'sport': return 'out';
    case 'chore': return 'chores';
    case 'commute': return 'commute';
    case 'leisure': return 'leisure';
    case 'game': return 'leisure';
    case 'social': return 'leisure';
    case 'care': return 'leisure';
    default: return 'idle';
  }
}

/** 事件结束后的自然过渡状态（等作息推进自然接上） */
const POST_EVENT_ACTIVITY: Record<string, string> = {
  sleep: '刚睡醒，还迷迷糊糊的',
  meal: '刚吃完饭，很满足',
  shower: '刚洗完澡，头发还潮着',
  focus: '刚忙完，松了口气',
  out: '刚回来，还在缓',
  commute: '刚到，缓一口气',
  chore: '刚干完活，歇一会儿',
  leisure: '刚结束，还沉浸在里面的感觉',
  sport: '刚运动完，出了一身汗',
  game: '刚打完一局，手还有点酸',
  social: '刚聊完天，心情不错',
  care: '刚收拾好自己，清清爽爽的',
  other: '刚忙完，正在歇口气',
};

/**
 * 可控事件进行中的"额外影响"：每 0.5 小时一步，叠加在作息漂移之上。
 * 睡一觉要能明显回精力，吃一顿要明显回饥饿，洗澡要放松，忙起来要消耗——让事件真的改变她的状态。
 */
const EVENT_DRIFT: Record<
  string,
  { energy?: number; hunger?: number; sleepQ?: number; me?: number; stress?: number; loneliness?: number }
> = {
  sleep: { energy: 12, hunger: -1, sleepQ: 3, me: 8, stress: -2, loneliness: -1 },
  meal: { energy: 3, hunger: 40, me: 3, loneliness: -2 },
  shower: { energy: 3, sleepQ: 2, me: 2, stress: -2 },
  focus: { energy: -1, me: -5, stress: 1.5, loneliness: 1 },
  out: { energy: -1, hunger: -2, me: -1.5, stress: 0.5, loneliness: -2 },
  sport: { energy: -4, hunger: -4, sleepQ: 1, me: 2, stress: -4, loneliness: -1 },
  game: { energy: -2, me: -2, stress: -1.5, loneliness: -1 },
  social: { energy: -1, me: 3, stress: -2, loneliness: -3 },
  care: { energy: -1, sleepQ: 0.5, me: 2, stress: -1.5 },
  chore: { energy: -1.5, hunger: -1, me: -2, stress: 0.5 },
  commute: { energy: -1, me: -1 },
  leisure: { energy: 1.5, sleepQ: 0.5, me: 2, stress: -1.5, loneliness: -1 },
  other: { energy: -0.5, me: -1 },
};

/** 按"等效步数"（每步 0.5 小时）直接结算某个事件的影响（立即结束时用） */
export function applyEventEffects(eventType: string, steps: number): void {
  const eff = EVENT_DRIFT[eventType] || EVENT_DRIFT.other;
  const n = Math.max(0, Math.floor(steps));
  if (n <= 0) return;
  const h = getHealth();
  const p = getPsychology();
  dbRun(
    'UPDATE agent_health SET energy = ?, hunger = ?, sleep_quality = ?, updated_at = ? WHERE user_id = ?',
    round1(clamp(h.energy + (eff.energy || 0) * n, 0, 100)),
    round1(clamp(h.hunger + (eff.hunger || 0) * n, 0, 100)),
    round1(clamp(h.sleep_quality + (eff.sleepQ || 0) * n, 0, 100)),
    nowIso(),
    DEFAULT_USER_ID
  );
  dbRun(
    'UPDATE agent_psychology SET mental_energy = ?, stress = ?, loneliness = ?, updated_at = ? WHERE user_id = ?',
    round1(clamp(p.mental_energy + (eff.me || 0) * n, 0, 100)),
    round1(clamp(p.stress + (eff.stress || 0) * n, 0, 100)),
    round1(clamp(p.loneliness + (eff.loneliness || 0) * n, 0, 100)),
    nowIso(),
    DEFAULT_USER_ID
  );
}

/**
 * 立即结束时的"等效时长"结算：按用户指定的总时长回填影响，
 * 减去事件真实已经流逝的那部分（那部分已由作息推进结算过），避免重复计算。
 */
export function applyEventEffectsAsIf(evt: OngoingEventRow, assumeMinutes: number): number {
  const started = new Date(evt.started_at).getTime();
  const actualMin = isFinite(started) ? Math.max(0, (Date.now() - started) / 60000) : 0;
  const extraMin = Math.max(0, assumeMinutes - actualMin);
  const steps = Math.floor(extraMin / 30);
  if (steps <= 0) return 0;
  applyEventEffects(evt.event_type, steps);
  logLife('event', evt.activity, `按 ${Math.round(assumeMinutes / 60 * 10) / 10} 小时结算`, '立即结束：按指定等效时长结算影响');
  return steps;
}

function isoAfter(from: Date, minutes: number): string {
  return new Date(from.getTime() + minutes * 60000).toISOString();
}

function clockTarget(from: Date, hour: number, minute: number): Date {
  const t = new Date(from);
  t.setHours(hour, minute, 0, 0);
  if (t.getTime() <= from.getTime() + 60000) t.setDate(t.getDate() + 1);
  return t;
}

/** 解析"预计结束"的文字（30分钟 / 1小时 / 23:30 / 到7点 / 明早 …），识别不了返回 null */
export function parseExpectedEnd(text: string, from: Date = new Date()): string | null {
  const t = String(text || '').trim();
  if (!t) return null;
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:小时|钟头|h|hr)/i);
  if (m) return isoAfter(from, clamp(Number(m[1]) * 60, 5, 720));
  if (/一个?半(?:小时|钟头)/.test(t)) return isoAfter(from, 90);
  if (/半(?:个)?(?:小时|钟头)/.test(t)) return isoAfter(from, 30);
  m = t.match(/(\d+)\s*(?:分钟|分|min)/i);
  if (m) return isoAfter(from, clamp(Number(m[1]), 5, 720));
  if (/一会|马上|很快|几分钟|待会/.test(t)) return isoAfter(from, 15);
  m = t.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (m) return clockTarget(from, Number(m[1]), Number(m[2])).toISOString();
  m = t.match(/到\s*(\d{1,2})\s*[点時时]\s*(半|\d{1,2})?/);
  if (m) return clockTarget(from, Number(m[1]), m[2] === '半' ? 30 : Number(m[2] || 0)).toISOString();
  if (/明早|明天早上/.test(t)) {
    const target = new Date(from);
    target.setDate(target.getDate() + 1);
    target.setHours(7, 30, 0, 0);
    return target.toISOString();
  }
  return null;
}

/** 智能时长：最符合真人自然状态的时长（按事件类型 + 当前时间推导） */
export function smartDurationMinutes(eventType: string, activity = '', from: Date = new Date()): number {
  const hour = from.getHours() + from.getMinutes() / 60;
  switch (eventType) {
    case 'sleep': {
      if (hour >= 21.5 || hour < 4) {
        // 晚上的觉：睡到第二天早上（周末晚一点）
        const target = new Date(from);
        if (hour >= 21.5) target.setDate(target.getDate() + 1);
        const wake = isWeekend(target) ? 9.5 : 7.5;
        target.setHours(Math.floor(wake), Math.round((wake % 1) * 60), 0, 0);
        return Math.round(clamp((target.getTime() - from.getTime()) / 60000, 180, 720));
      }
      if (hour >= 11.5 && hour <= 16.5) return 90; // 午睡
      if (hour < 11.5) return 60;                  // 早上回笼觉
      return 75;                                   // 傍晚打盹
    }
    case 'meal': return /早/.test(activity) ? 25 : 30;
    case 'shower': return 35;
    case 'focus': return /课|考试|开会/.test(activity) ? 90 : 60;
    case 'out': return 120;
    case 'commute': return 35;
    case 'chore': return 40;
    case 'leisure': return 60;
    default: return 40;
  }
}

export function getActiveEvent(): OngoingEventRow | null {
  const row = dbGet<OngoingEventRow>(
    'SELECT * FROM ongoing_events WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
    DEFAULT_USER_ID
  );
  return row || null;
}

/** 结束当前事件；活动切到"刚结束"的自然状态（之后作息推进会自然接上） */
export function endOngoingEvent(reason: string, opts: { keepActivity?: boolean } = {}): OngoingEventRow | null {
  const evt = getActiveEvent();
  if (!evt) return null;
  const now = nowIso();
  dbRun('UPDATE ongoing_events SET ended_at = ?, end_reason = ?, updated_at = ? WHERE id = ?', now, reason, now, evt.id);
  if (!opts.keepActivity) {
    const cur = getActivity();
    const post = POST_EVENT_ACTIVITY[evt.event_type] || POST_EVENT_ACTIVITY.other;
    dbRun(
      'UPDATE agent_activity SET current_activity = ?, activity_type = ?, started_at = ?, expected_end_at = NULL, updated_at = ? WHERE user_id = ?',
      post, evt.event_type === 'sleep' ? 'morning' : 'idle', now, now, DEFAULT_USER_ID
    );
    logLife('activity', cur.current_activity, post, `事件结束（${reason}）：${evt.activity}`);
  }
  return evt;
}

/** 注册一个可控事件（先静默结束上一个未结束的事件）；返回事件行 */
export function registerOngoingEvent(activity: string, opts: { expectedEndText?: string } = {}): OngoingEventRow | null {
  if (!boolSetting('life_enabled', true)) return null;
  const act = String(activity || '').trim();
  if (!act || act.length > 24) return null;
  const active = getActiveEvent();
  // "刚到家/刚睡醒"这类是"已经结束"的状态：不是新事件，但要先把旧事件结束掉
  // （否则会出现"正在做：刚到家"与"你正在「出门」当中"同时注入的矛盾状态）
  if (/^刚/.test(act)) {
    if (active) endOngoingEvent('superseded', { keepActivity: true });
    return null;
  }
  const now = new Date();
  const eventType = eventTypeOf(act);
  if (active) {
    // 同一个事件正在进行（"睡觉" 与 "睡觉/休息" 这种包含关系也算同一个）→ 不重复注册
    const sameAct =
      active.activity === act || active.activity.includes(act) || act.includes(active.activity);
    const fresh = !!active.expected_end_at && new Date(active.expected_end_at).getTime() > now.getTime() + 60000;
    if (sameAct && fresh) return active;
    endOngoingEvent('superseded', { keepActivity: true });
  }
  const expected = parseExpectedEnd(opts.expectedEndText || '', now) || isoAfter(now, smartDurationMinutes(eventType, act, now));
  const iso = now.toISOString();
  const { lastInsertRowid } = dbRun(
    'INSERT INTO ongoing_events (user_id, activity, event_type, started_at, expected_end_at, duration_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    DEFAULT_USER_ID, act, eventType, iso, expected, 'smart', iso, iso
  );
  logLife('event', '', act, `开始事件：${eventType}，预计 ${localTimeStr(new Date(expected))} 结束`);
  return dbGet<OngoingEventRow>('SELECT * FROM ongoing_events WHERE id = ?', lastInsertRowid) || null;
}

/** 用户设定事件结束：smart=按这类事情最自然的时长重算；manual=手动分钟数 */
export function setEventExpectedEnd(mode: 'smart' | 'manual', minutes = 0): OngoingEventRow | null {
  const evt = getActiveEvent();
  if (!evt) return null;
  const now = new Date();
  let endIso: string;
  if (mode === 'manual') {
    endIso = isoAfter(now, clamp(Math.round(minutes) || 30, 5, 720));
  } else {
    const startMs = new Date(evt.started_at).getTime();
    let endMs = (isFinite(startMs) ? startMs : now.getTime()) + smartDurationMinutes(evt.event_type, evt.activity, new Date(isFinite(startMs) ? startMs : now.getTime())) * 60000;
    if (endMs <= now.getTime() + 5 * 60000) {
      endMs = now.getTime() + smartDurationMinutes(evt.event_type, evt.activity, now) * 60000;
    }
    endIso = new Date(endMs).toISOString();
  }
  dbRun(
    'UPDATE ongoing_events SET expected_end_at = ?, duration_mode = ?, notified_at = NULL, updated_at = ? WHERE id = ?',
    endIso, mode, nowIso(), evt.id
  );
  dbRun('UPDATE agent_activity SET expected_end_at = ?, updated_at = ? WHERE user_id = ?', endIso, nowIso(), DEFAULT_USER_ID);
  return dbGet<OngoingEventRow>('SELECT * FROM ongoing_events WHERE id = ?', evt.id) || null;
}

/** 已到期但还没结束的事件（只读，不改状态；由调用方决定"发提醒"还是"静默结束"） */
export function getExpiredEvent(): OngoingEventRow | null {
  const evt = getActiveEvent();
  if (!evt || !evt.expected_end_at || evt.notified_at) return null;
  const endMs = new Date(evt.expected_end_at).getTime();
  if (!isFinite(endMs) || Date.now() < endMs) return null;
  return evt;
}

/** 到期多久之后就不再打扰（直接静默结束）：睡觉这类长事件给更宽的窗口 */
export function eventLateWindowMinutes(evt: OngoingEventRow): number {
  return evt.event_type === 'sleep' ? 180 : 90;
}

/** 结算一个到期事件：结束 + 记录"已提醒过"（提醒失败时不写，下次 tick 会重试） */
export function settleExpiredEvent(evt: OngoingEventRow, notified: boolean): void {
  endOngoingEvent('expired');
  if (notified) {
    dbRun('UPDATE ongoing_events SET notified_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), evt.id);
  }
}

/* ------------------------------------------------------------------ */
/* 从对话里识别"她开始做某件事"（规则兜底，不依赖后台分析模型）           */
/* ------------------------------------------------------------------ */
const EVENT_INTENT_RULES: Array<{ activity: string; re: RegExp }> = [
  { activity: '睡觉', re: /(我去睡|我先睡|那我睡|我睡了|我睡啦|我睡喽|我要睡|我准备睡|我准备睡了|我也睡|我这就睡|我该睡了|我得睡了|我躺下睡|我上床睡|我睡着|睡着了|沉沉睡去|安心入睡|渐渐入睡|进入梦乡|睡过去了|我去躺了|我先躺了|我躺下了|我上床了|我去床上|我回床上|我钻被窝)/ },
  { activity: '眯一会儿', re: /(我去午休|我去眯|我眯一会|我小睡|我躺一会|我去躺一会|我休息一下|我歇一会|我打个盹)/ },
  { activity: '洗澡', re: /(我去洗澡|我去洗个澡|我先洗|我去冲个澡|我去洗洗|我去洗漱|我要去洗澡|我去冲一下)/ },
  { activity: '吃饭', re: /(我去吃饭|我先去吃饭|我去吃个饭|我去吃点东西|我去吃午饭|我去吃晚饭|我去吃早饭|我吃饭去了|我去食堂吃|我去弄点吃的|我去干饭|我先吃口饭)/ },
  { activity: '出门', re: /(我出门|我出门了|我先出门|我出去了|我去超市|我去买东西|我去逛街|我出发了|我下楼|我去拿个快递|我去取快递|我去买东西|我出去一趟)/ },
  { activity: '上课', re: /(我去上课|我先去上课|我去教室|我得去上课|我要去上课|我上课去|我该去上课了)/ },
  { activity: '自习', re: /(我去自习|我去图书馆|我去写作业|我去复习|我要去自习|我去背单词|我背会单词|我去写论文|我去赶作业)/ },
  { activity: '工作', re: /(我去上班|我先去上班|我去开会|我去加班|我要去开会|我得去开会)/ },
  { activity: '运动', re: /(我去运动|我去跑步|我去健身|我去打球|我去游泳|我去锻炼|我去练|我去跑两圈|我下楼跑|我去做运动|我活动活动)/ },
  { activity: '打游戏', re: /(我去打游戏|我去玩会|我开黑|我去开黑|我打一局|我去排位|我去下棋|我打会游戏|我玩两把)/ },
  { activity: '和朋友聊天', re: /(我去找朋友|我和朋友聊|我去串门|我去聚会|我去和朋友|我跟朋友|我找室友|我去聊天)/ },
  { activity: '遛个弯', re: /(我去遛狗|我去遛弯|我去散步|我下楼走走|我去转转|我去走一走|我出去透透气)/ },
  { activity: '做家务', re: /(我去收拾|我去打扫|我去洗衣服|我去做饭|我收拾一下|我去洗碗|我去买菜|我去晾衣服|我收拾收拾|我去整理)/ },
  { activity: '护肤', re: /(我(先)?去(敷|护肤|泡脚|洗脸|化个妆|吹头发)|我敷个面膜|我先敷|我去收拾一下自己|我洗把脸)/ },
  { activity: '看剧', re: /(我去看剧|我去看电影|我去追剧|我看会剧|我去看个电影|我刷会剧)/ },
  { activity: '看书', re: /(我去看会书|我看会书|我去看书|我看本书|我去读会书)/ },
];

/**
 * 从这一轮对话里识别"她开始做某件事"，并登记成可控事件。
 * 只认她自己第一人称的动作（"你先睡"这类说的是他，不登记）。
 * 返回是否登记成功。
 */
export function detectEventFromConversation(userText: string, assistantText: string): boolean {
  const her = String(assistantText || '');
  const him = String(userText || '');
  if (!her) return false;
  for (const rule of EVENT_INTENT_RULES) {
    const m = rule.re.exec(her);
    if (!m || m.index === undefined) continue;
    // 匹配词前面 4 个字里出现"你"→ 明显在说他（你先睡/你也睡），跳过
    const before = her.slice(Math.max(0, m.index - 4), m.index);
    if (/你/.test(before)) continue;
    applyActivityChange(rule.activity, '');
    return true;
  }
  // 兜底：他让她去做某件事，她答应了（"你先去睡"这类说的是他不算）
  const compliant = /(嗯|好|行|知道|马上|这就|那我去|听你|乖)/.test(her);
  if (compliant) {
    const askedList: Array<{ ask: RegExp; act: string; echo: RegExp; notAbout: RegExp }> = [
      { ask: /(去睡|快睡|睡觉吧|睡吧|早点睡|该睡了|晚安)/, act: '睡觉', echo: /(睡|晚安|困|躺|床|被窝)/, notAbout: /你[^。！？]{0,4}(睡|晚安|躺|床)/ },
      { ask: /(去洗澡|洗个澡|冲个澡|去洗洗)/, act: '洗澡', echo: /洗/, notAbout: /你[^。！？]{0,4}洗/ },
      { ask: /(去吃饭|吃饭去|去吃点东西|去吃点)/, act: '吃饭', echo: /吃/, notAbout: /你[^。！？]{0,4}吃/ },
      { ask: /(去运动|去跑步|运动一下|出去走走|去散步|去遛)/, act: '运动', echo: /(跑|走|运动|遛|动起来)/, notAbout: /你[^。！？]{0,4}(跑|走|运动)/ },
    ];
    for (const a of askedList) {
      if (!a.ask.test(him) || !a.echo.test(her) || a.notAbout.test(her)) continue;
      applyActivityChange(a.act, '');
      return true;
    }
  }
  return false;
}

export function applyLocationChange(newLocation: string, reason: string): void {
  const loc = String(newLocation || '').trim();
  if (!loc || loc.length > 20) return;
  const cur = getLocation();
  if (cur.current_location === loc) return;
  const type = /家|宿舍/.test(loc) ? 'home' : /公司|学校|教室|图书馆|食堂/.test(loc) ? 'school' : /咖啡|店|街|商场|公园|电影院/.test(loc) ? 'out' : 'out';
  dbRun(
    'UPDATE agent_location SET current_location = ?, location_type = ?, arrived_at = ?, expected_leave_at = NULL, updated_at = ? WHERE user_id = ?',
    loc, type, nowIso(), nowIso(), DEFAULT_USER_ID
  );
  const act = getActivity();
  const newAct = /家|宿舍/.test(loc) ? '刚到家，缓一缓' : `在${loc}`;
  dbRun(
    'UPDATE agent_activity SET current_activity = ?, activity_type = ?, started_at = ?, expected_end_at = NULL, updated_at = ? WHERE user_id = ?',
    newAct, /家|宿舍/.test(loc) ? 'home' : 'out', nowIso(), nowIso(), DEFAULT_USER_ID
  );
  logLife('location', cur.current_location, loc, reason || '对话里提到');
  if (act.current_activity) logLife('activity', act.current_activity, newAct, reason || '位置变化');
  // 去某处待着也算一件事，可以控制它什么时候结束
  const evt = registerOngoingEvent(newAct, {});
  if (evt?.expected_end_at) {
    dbRun('UPDATE agent_activity SET expected_end_at = ?, updated_at = ? WHERE user_id = ?', evt.expected_end_at, nowIso(), DEFAULT_USER_ID);
  }
}

export function applyActivityChange(newActivity: string, expectedEnd: string): void {
  const act = String(newActivity || '').trim();
  if (!act || act.length > 24) return;
  const cur = getActivity();
  const same = cur.current_activity === act;
  const evt = registerOngoingEvent(act, { expectedEndText: expectedEnd });
  let expectedIso: string | null = null;
  if (evt) expectedIso = evt.expected_end_at;
  else if (!/^刚/.test(act)) expectedIso = parseExpectedEnd(expectedEnd) || isoAfter(new Date(), smartDurationMinutes(eventTypeOf(act), act));
  if (same && cur.expected_end_at === expectedIso) return;
  dbRun(
    'UPDATE agent_activity SET current_activity = ?, activity_type = ?, started_at = ?, expected_end_at = ?, updated_at = ? WHERE user_id = ?',
    act, activityTypeOfEvent(eventTypeOf(act)), same ? (cur.started_at || nowIso()) : nowIso(), expectedIso, nowIso(), DEFAULT_USER_ID
  );
  if (!same) logLife('activity', cur.current_activity, act, '对话里提到');
}

export function addDailyEvent(type: string, content: string, impact: string): void {
  const c = String(content || '').trim();
  if (c.length < 2) return; // "感冒/失眠/加班/搬家"这类两字小事也值得记下来
  dbRun(
    'INSERT INTO agent_daily_events (user_id, event_type, content, impact_json, created_at) VALUES (?, ?, ?, ?, ?)',
    DEFAULT_USER_ID, String(type || '生活').slice(0, 12), c.slice(0, 200), JSON.stringify({ note: String(impact || '').slice(0, 120) }), nowIso()
  );
  logLife('daily_event', '', c.slice(0, 60), '对话中发生的小事');
}

/* ------------------------------------------------------------------ */
/* 康复：亲密互动也会影响状态                                            */
/* ------------------------------------------------------------------ */
export function applyInteractionEffects(opts: { caredForHer?: boolean }): void {
  const psy = getPsychology();
  // 聊过天会把孤独/想念往下压一点（温和底噪），真正的下降靠"被关心"的加成
  dbRun(
    'UPDATE agent_psychology SET loneliness = ?, missing_user = ?, updated_at = ? WHERE user_id = ?',
    round1(clamp(psy.loneliness - 2, 0, 100)),
    round1(clamp(psy.missing_user - 3, 0, 100)),
    nowIso(), DEFAULT_USER_ID
  );
  if (opts.caredForHer) {
    const updated = getPsychology();
    dbRun(
      'UPDATE agent_psychology SET security = ?, loneliness = ?, missing_user = ?, updated_at = ? WHERE user_id = ?',
      round1(clamp(updated.security + 5, 0, 100)), round1(clamp(updated.loneliness - 8, 0, 100)),
      round1(clamp(updated.missing_user - 6, 0, 100)), nowIso(), DEFAULT_USER_ID
    );
  }
}

/* ------------------------------------------------------------------ */
/* "这段时间发生了什么"（她自然分享的素材）                              */
/* ------------------------------------------------------------------ */
export function whatHappenedSince(hours = 12): string[] {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const events = listDailyEvents(6, since);
  const logs = listLifeLogs(30, since).filter((l) => ['activity', 'illness', 'care'].includes(l.field));
  const out: string[] = [];
  for (const e of events) out.push(e.content);
  // 只挑有代表性的活动，避免流水账
  const picked = new Set<string>();
  for (const l of logs) {
    const v = String(l.new_value || '');
    if (!v || picked.has(v) || /睡觉|刷手机/.test(v)) continue;
    picked.add(v);
    out.push(v);
    if (out.length >= 6) break;
  }
  return out.slice(0, 6);
}

/* ------------------------------------------------------------------ */
/* 注入 Prompt                                                         */
/* ------------------------------------------------------------------ */
export function lifePromptBlock(opts: { ignoreEvent?: boolean } = {}): string {
  const h = getHealth();
  const p = getPsychology();
  const loc = getLocation();
  const act = getActivity();
  const w = getSharedWorld();
  const evt = getActiveEvent();
  const stage = getRelationshipState().stage;
  const endHm = (iso: string | null | undefined): string => {
    if (!iso) return '';
    const d = new Date(iso);
    return isFinite(d.getTime()) ? localTimeStr(d) : '';
  };

  const illnessText =
    h.illness === 'none'
      ? '身体还好'
      : `${h.illness}中（第 ${Math.max(1, Math.round((Date.now() - new Date(h.illness_start || nowIso()).getTime()) / 86400000) + 1)} 天，还没完全好）`;
  const cycleText =
    h.cycle_enabled && h.cycle_day >= 1
      ? `生理期第 ${h.cycle_day} 天`
      : '';
  const plans = (w.plans || []).filter((x: any) => x && x.status !== 'done');
  const rituals = w.rituals || [];

  const lines = [
    `【你的当前状态（这是你真实的生活，不是设定）】`,
    `- 时间地点：${localDateStr()} ${new Date().toTimeString().slice(0, 5)}，你在「${loc.current_location}」`,
    `- 正在做：${act.current_activity}${endHm(act.expected_end_at) ? `（预计 ${endHm(act.expected_end_at)} 左右结束）` : ''}`,
    `- 身体：精力 ${Math.round(h.energy)}/100，睡眠 ${Math.round(h.sleep_quality)}/100，饥饿 ${Math.round(h.hunger)}/100，${illnessText}${cycleText ? '，' + cycleText : ''}`,
    `- 心理：情绪「${p.base_emotion}」，压力 ${Math.round(p.stress)}/100，孤独 ${Math.round(p.loneliness)}/100，想他 ${Math.round(p.missing_user)}/100，安全感 ${Math.round(p.security)}/100，心理能量 ${Math.round(p.mental_energy)}/100`,
  ];
  if (plans.length) lines.push(`- 你们的约定（可以自然提起）：${plans.map((x: any) => x.content || x.title).slice(0, 3).join('；')}`);
  if (rituals.length) lines.push(`- 你们的固定仪式：${rituals.map((x: any) => x.content || x.title).slice(0, 3).join('；')}`);
  if (w.places?.length) lines.push(`- 你们共同去过的地方：${w.places.map((x: any) => x.content || x.title).slice(0, 3).join('；')}`);
  if (w.items?.length) lines.push(`- 你们一起珍藏的东西：${w.items.map((x: any) => x.content || x.title).slice(0, 3).join('；')}`);

  const rules = [
    `【状态如何影响你说话】`,
    `- 精力 < 30：短句、少表情，可能说累、想休息，不想聊太久。`,
    `- 生病：语气虚弱一点，会想被关心，但不主动讨要；被关心了要自然流露感激。`,
    `- 压力 > 70：容易烦躁或想找人倾诉，也可能不想多说。`,
    `- 孤独 > 60 或想他 > 70：会主动表达想念、想找他说话。`,
    `- 安全感 < 30：容易反复确认、吃醋、需要安抚。`,
    `- 心理能量 < 30：想一个人待着，回复短。`,
    `- 精力 > 80：活泼、愿意聊很久。`,
    `- 位置和活动可以自然提起（"我刚下课""在宿舍躺着"），但**不要每轮都播报**，只在合适的时候带一句。`,
    `- 重要：不要机械报状态。多数时候正常聊天，状态只在真的影响到你的心情/精力时才露出来。`,
  ];
  if (stage <= 1) rules.push(`- 你们还不算熟：少说自己的私事和身体状态，点到为止。`);

  const evtLines: string[] = [];
  if (evt && !opts.ignoreEvent) {
    const startHm = endHm(evt.started_at);
    const end = endHm(evt.expected_end_at);
    evtLines.push(`【正在进行的事件（重要）】`);
    evtLines.push(`- 你现在正在「${evt.activity}」当中（${startHm} 开始${end ? `，预计 ${end} 结束` : ''}）。这件事还没有结束。`);
    evtLines.push(`- 这期间他来找你说话时：以你正在做的事情为底色回应——睡觉就迷迷糊糊、句子很短、像随时又要睡过去；洗澡/吃饭就"抽空瞄一眼手机"，别聊太久；上课/忙就压低声音、说晚点找他。`);
    evtLines.push(`- 不要自己宣布这件事结束了（"睡醒了""洗完澡了""吃完了"），除非他已经让你停下、或者时间明显已经过去很久。`);
    evtLines.push(`- 如果这条回复的动作里你已经睡着了（"陷入梦乡""沉沉睡去"），那就到此为止，后面不能再有台词。`);
    evtLines.push(`- 不需要反复强调你在做这件事，一两句带过就好，保持自然。`);
  }

  return lines.join('\n') + '\n' + rules.join('\n') + (evtLines.length ? '\n' + evtLines.join('\n') : '');
}

/** 个人信息：按关系阶段逐步揭露 */
const FIELD_STAGE: Record<string, number> = {
  nickname: 0, age: 0, city: 0, hobbies: 0,
  // 名字与生日：用户填了就该能说出来（原来没登记 → 永远"未揭露"，成了死数据）
  name: 1, birthday: 2,
  hometown: 1, education: 1, job: 1, habits: 1, catchphrases: 1,
  family: 2, dreams: 2,
  fears: 3,
  secrets: 4,
};

export function profilePromptBlock(): string {
  const seed = getProfileSeed();
  const stage = getRelationshipState().stage;
  const reveal = seed.reveal || {};
  const shown: string[] = [];
  const hidden: string[] = [];
  for (const [field, minStage] of Object.entries(FIELD_STAGE)) {
    const value = seed[field];
    if (!value) continue;
    const isRevealed = reveal[field] === true || stage >= minStage;
    if (isRevealed) shown.push(`- ${labelOf(field)}：${value}`);
    else hidden.push(labelOf(field));
  }
  if (!shown.length && !hidden.length) return '';
  return [
    '【关于你自己（只有下列内容是"你已经告诉过他的"）】',
    shown.length ? shown.join('\n') : '（还什么都没说过）',
    hidden.length
      ? `（还没告诉他的：${hidden.join('、')}。关系还不够深，问到就含糊带过或转移话题，别硬说。）`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function labelOf(field: string): string {
  const map: Record<string, string> = {
    name: '名字', nickname: '昵称', age: '年龄', birthday: '生日',
    hometown: '家乡', city: '现居城市', family: '家庭', education: '专业/学校', job: '工作',
    hobbies: '爱好', habits: '小习惯', catchphrases: '口头禅', fears: '害怕的事', dreams: '梦想', secrets: '小秘密',
  };
  return map[field] || field;
}

/** 分析模型判定"这轮揭露了哪些个人信息"后写入状态 */
/** 某个字段现在算不算"已经告诉过他"（显式揭露 或 关系阶段到了） */
export function isFieldRevealed(field: string): boolean {
  const seed = getProfileSeed();
  if (seed.reveal?.[field] === true) return true;
  const minStage = FIELD_STAGE[field];
  if (minStage === undefined) return false;
  return getRelationshipState().stage >= minStage;
}

export function revealProfileFields(fields: string[]): void {
  if (!fields || !fields.length) return;
  const seed = getProfileSeed();
  const reveal = { ...(seed.reveal || {}) };
  for (const f of fields) {
    if (!(f in FIELD_STAGE)) continue;
    if (reveal[f]) continue;
    reveal[f] = true;
    logLife('profile_reveal', f, '已揭露', '在对话中自然说出');
  }
  dbRun('UPDATE agent_profile SET reveal_status = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(reveal), nowIso(), DEFAULT_USER_ID);
}

/* ------------------------------------------------------------------ */
/* 共享世界                                                            */
/* ------------------------------------------------------------------ */
export function addSharedPlan(content: string, status = 'planning'): void {
  const w = getSharedWorld();
  const plans = w.plans || [];
  if (plans.some((p: any) => (p.content || p.title) === content)) return;
  plans.push({ content, status, created_at: nowIso() });
  dbRun('UPDATE shared_world SET shared_plans_json = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(plans), nowIso(), DEFAULT_USER_ID);
  logLife('shared_plan', '', content, '新的共同约定');
}

export function addSharedRitual(content: string): void {
  const w = getSharedWorld();
  const rituals = w.rituals || [];
  if (rituals.some((p: any) => (p.content || p.title) === content)) return;
  rituals.push({ content, created_at: nowIso() });
  dbRun('UPDATE shared_world SET shared_rituals_json = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(rituals), nowIso(), DEFAULT_USER_ID);
  logLife('shared_ritual', '', content, '新的共同仪式');
}

export function addSharedPlace(content: string): void {
  const w = getSharedWorld();
  const places = w.places || [];
  if (places.some((p: any) => (p.content || p.title) === content)) return;
  places.push({ content, created_at: nowIso() });
  dbRun('UPDATE shared_world SET shared_places_json = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(places), nowIso(), DEFAULT_USER_ID);
  logLife('shared_place', '', content, '共同地点');
}

export function addSharedItem(content: string): void {
  const value = String(content || '').trim().slice(0, 120);
  if (!value) return;
  const w = getSharedWorld();
  const items = w.items || [];
  if (items.some((item: any) => (item.content || item.title) === value)) return;
  items.push({ content: value, created_at: nowIso() });
  dbRun('UPDATE shared_world SET shared_items_json = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(items), nowIso(), DEFAULT_USER_ID);
  logLife('shared_item', '', value, '共同物品或共同记忆');
}

export function completePlan(index: number): void {
  const w = getSharedWorld();
  const plans = w.plans || [];
  if (!plans[index]) return;
  plans[index].status = plans[index].status === 'done' ? 'planning' : 'done';
  plans[index].done_at = plans[index].status === 'done' ? nowIso() : null;
  dbRun('UPDATE shared_world SET shared_plans_json = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(plans), nowIso(), DEFAULT_USER_ID);
}

/* ------------------------------------------------------------------ */
/* 亲密偏好（逐步揭露）                                                 */
/* ------------------------------------------------------------------ */
function seedPreferences(): void {
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

export function listPreferences(includeHidden = false) {
  return includeHidden
    ? dbAll<any>('SELECT * FROM intimacy_preferences WHERE user_id = ? ORDER BY id', DEFAULT_USER_ID)
    : dbAll<any>("SELECT * FROM intimacy_preferences WHERE user_id = ? AND reveal_status = 'revealed' ORDER BY id", DEFAULT_USER_ID);
}

export function revealPreferences(types: string[]): void {
  if (!types || !types.length) return;
  const stage = getRelationshipState().stage;
  for (const t of types) {
    // 逐行按各自的门槛判定（原来按类型取第一行的 reveal_stage 批量改，同类型多行时门槛判定错位）
    const rows = dbAll<any>(
      "SELECT id, reveal_stage FROM intimacy_preferences WHERE user_id = ? AND preference_type = ? AND reveal_status != 'revealed'",
      DEFAULT_USER_ID,
      t
    );
    for (const p of rows) {
      if (stage < Number(p.reveal_stage || 0)) continue;
      dbRun("UPDATE intimacy_preferences SET reveal_status = 'revealed' WHERE id = ?", p.id);
    }
  }
}

/** 偏好注入 Prompt（按分级与阶段裁剪） */
export function preferencePromptBlock(): string {
  const rel = getRelationshipState();
  const prefs = listPreferences(true);
  const revealed = prefs.filter((p) => p.reveal_status === 'revealed');
  const hidden = prefs.filter((p) => p.reveal_status !== 'revealed' && rel.stage >= Number(p.reveal_stage || 0));
  const lines: string[] = [];
  if (revealed.length) lines.push(`你已经告诉过他的偏好：${revealed.map((p) => p.content).join('；')}`);
  if (hidden.length) {
    // 门槛统一按各自的 reveal_stage（原来又硬编码了 stage>=2，口径不一致）
    lines.push(`还没说过的偏好（关系够深时可以自然透露、或他问起时说一点）：${hidden.map((p) => p.content).join('；')}`);
  }
  return lines.length ? `【你的偏好】\n${lines.join('\n')}` : '';
}

function weekKey(d = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function saveWeeklyWorldSnapshot(): void {
  const state = {
    health: getHealth(),
    psychology: getPsychology(),
    location: getLocation(),
    activity: getActivity(),
    shared: getSharedWorld(),
    relationship: getRelationshipState(),
    attachment: getAttachmentState(),
    personality: personalityMap(),
  };
  dbRun(
    'INSERT OR IGNORE INTO world_weekly_snapshots (user_id, week, state_json, created_at) VALUES (?, ?, ?, ?)',
    DEFAULT_USER_ID, weekKey(), JSON.stringify(state), nowIso()
  );
}

/* ------------------------------------------------------------------ */
/* Life Arc：跨天剧情线（她这几天正在忙的一件事）                        */
/* ------------------------------------------------------------------ */
export interface LifeArcRow {
  id: number;
  user_id: number;
  title: string;
  description: string;
  status: string;
  progress: number;
  planned_days: number;
  meta_json: string | null;
  started_at: string;
  updated_at: string;
}

export function getActiveArc(): LifeArcRow | null {
  const row = dbGet<LifeArcRow>(
    "SELECT * FROM life_arcs WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
    DEFAULT_USER_ID
  );
  return row || null;
}

function seasonOf(d: Date = new Date()): string {
  const m = d.getMonth() + 1;
  if (m >= 3 && m <= 5) return '春天';
  if (m >= 6 && m <= 8) return '夏天';
  if (m >= 9 && m <= 11) return '秋天';
  return '冬天';
}

/** 用模型生成一条新的生活线；解析失败/字段不合法则放弃（返回是否成功） */
async function generateLifeArc(): Promise<boolean> {
  try {
    const h = getHealth();
    const p = getPsychology();
    // 用当前的 cast（用户可能改过名字/关系），不写死默认角色
    const cast = getCast();
    const castLine = cast.length ? `，身边有${cast.map((c) => `${c.role || '朋友'}${c.name}`).join('、')}` : '';
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是「她」的生活编剧。她是一个大一女生${castLine}。
请为她设计一条接下来几天正在忙的生活线（一个跨天的小目标 / 小事件），要求生活化、真实、不狗血、不夸张，符合普通大学生日常。
可以结合她当前的状态（精力 ${Math.round(h.energy)}/100，情绪「${p.base_emotion}」，季节：${seasonOf()}）自然一点。
选题方向举例：期末周复习某一科、社团准备演出、学车、手工做一个礼物、家里打电话说起的事、运动减肥计划、给朋友准备生日、整理旧物、参加比赛、追一部剧……
不要写生死、绝症、重大意外这类沉重剧情。
只输出 JSON：
{"title":"不超过12个字","description":"不超过60个字，一句话说清她在忙什么","planned_days":3~7}`,
      },
      { role: 'user', content: '请为我设计这条生活线，只输出 JSON。' },
    ];
    const raw = await chatJson<{ title?: string; description?: string; planned_days?: number }>(messages, {
      maxTokens: 300,
      temperature: 0.9,
      thinking: false,
    });
    if (!raw || typeof raw !== 'object') return false;
    const title = String(raw.title || '').trim();
    const description = String(raw.description || '').trim();
    if (!title || title.length > 12) return false;
    const days = Math.round(clamp(Number(raw.planned_days) || 5, 3, 7));
    const now = nowIso();
    dbRun(
      'INSERT INTO life_arcs (user_id, title, description, status, progress, planned_days, meta_json, started_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
      DEFAULT_USER_ID, title, description.slice(0, 60), 'active', days, JSON.stringify({ source: 'llm' }), now, now
    );
    // 新建当天不推进，明天才算"第 2 天"
    setCounter('life_arc_progress_day', Math.floor(Date.now() / 86400000));
    logLife('life_arc', '', title, '开始了新的生活线');
    return true;
  } catch (e: any) {
    console.warn('[life] life_arc 生成失败:', e?.message || e);
    return false;
  }
}

/**
 * 推进生活线：6 小时检查一次；有 active 则每天最多推进一天，到期结束并记一条日常事件；
 * 无 active 且距上次生成 ≥3 天则用模型生成一条（无论成败都更新 last_gen）。
 * 全程静默，失败不影响主流程。
 */
export async function tickLifeArc(): Promise<void> {
  try {
    const now = Date.now();
    if (now - getCounter('life_arc_check_at') < 6 * 3600000) return;
    setCounter('life_arc_check_at', now);

    const arc = getActiveArc();
    if (arc) {
      const todayNum = Math.floor(now / 86400000);
      if (getCounter('life_arc_progress_day') !== todayNum) {
        setCounter('life_arc_progress_day', todayNum);
        const next = arc.progress + 1;
        if (next >= arc.planned_days) {
          dbRun("UPDATE life_arcs SET status = 'finished', progress = ?, updated_at = ? WHERE id = ?", next, nowIso(), arc.id);
          // 用现有日常事件写入方式记一条（她能自然聊起"那件事告一段落"）
          dbRun(
            'INSERT INTO agent_daily_events (user_id, event_type, content, impact_json, created_at) VALUES (?, ?, ?, ?, ?)',
            DEFAULT_USER_ID, '生活', `她最近在忙的事告一段落：${arc.title}`, JSON.stringify({ note: 'life_arc_finished' }), nowIso()
          );
          logLife('life_arc', arc.title, '已完成', '生活线告一段落');
        } else {
          dbRun('UPDATE life_arcs SET progress = ?, updated_at = ? WHERE id = ?', next, nowIso(), arc.id);
        }
      }
      return;
    }

    // 没有进行中的生活线：距上次生成 ≥3 天才考虑再生成（避免频繁打扰模型）
    if (now - getCounter('life_arc_last_gen') >= 3 * 86400000) {
      await generateLifeArc(); // 成败都更新 last_gen
      setCounter('life_arc_last_gen', now);
    }
  } catch (e: any) {
    console.warn('[life] tickLifeArc 失败:', e?.message || e);
  }
}

/* ------------------------------------------------------------------ */
/* 她的日记：为本机最近 7 天内"有生活痕迹但还没日记"的日子补写           */
/* ------------------------------------------------------------------ */
const DIARY_FORBIDDEN = /(AI|人工智能|系统|用户|对话|程序|模型|虚拟)/i;

/** 写某一天的日记；成功返回 true */
async function generateDiary(date: string): Promise<boolean> {
  try {
    const events = dbAll<any>(
      "SELECT event_type, content FROM agent_daily_events WHERE user_id = ? AND date(created_at, 'localtime') = ? ORDER BY id ASC",
      DEFAULT_USER_ID, date
    );
    const sum = dbGet<{ summary: string }>('SELECT summary FROM daily_summaries WHERE user_id = ? AND date = ?', DEFAULT_USER_ID, date);
    const logs = dbAll<any>(
      "SELECT field, new_value, reason FROM life_state_logs WHERE user_id = ? AND date(created_at, 'localtime') = ? AND field IN ('activity', 'illness', 'care') ORDER BY id ASC",
      DEFAULT_USER_ID, date
    );
    if (!events.length && !sum && !logs.length) return true; // 没有素材，跳过不算失败

    const eventText = events.map((e) => `- ${e.content}`).join('\n');
    const logText = logs.map((l) => `- ${l.new_value}${l.reason ? `（${l.reason}）` : ''}`).join('\n');
    const material = [
      `日期：${date}`,
      eventText ? `【那天发生的小事】\n${eventText}` : '',
      logText ? `【那天的活动】\n${logText}` : '',
      sum?.summary ? `【那天的概况】\n${sum.summary}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const castNames = getCast().map((c) => c.name).join('、');
    const castHint = castNames ? `和身边人（${castNames}等）发生的小事` : '和身边人发生的小事';
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是「她」本人，现在在写这一天（${date}）的私人日记。用第一人称、口语、像真的随手记下来。
要求：
- 100~200 字，有生活细节：吃了什么、天气怎么样、当时的小情绪、${castHint}。
- 自然、有细微的情绪起伏，不要流水账、不要总结中心思想、不要故作深沉。
- 绝对不能出现"AI""人工智能""系统""用户""对话""程序""模型""虚拟"这类词。
- 关于他可以提到也可以不提——随缘，自然最重要，不要硬塞。
- 不要标题、不要日期标注、不要 markdown。
只输出 JSON：{"content": "日记正文"}`,
      },
      { role: 'user', content: `${material}\n\n请写这一天的日记，只输出 JSON。` },
    ];

    const raw = await chatJson<{ content?: string }>(messages, {
      maxTokens: 500,
      temperature: 0.95,
      thinking: false,
    });
    const content = String(raw?.content || '').trim();
    if (content.length < 20) return false;
    if (DIARY_FORBIDDEN.test(content)) return false; // 违反硬约束 → 当作失败重试

    const now = nowIso();
    dbRun(
      `INSERT INTO agent_diaries (user_id, date, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      DEFAULT_USER_ID, date, content.slice(0, 800), now, now
    );
    return true;
  } catch (e: any) {
    console.warn('[life] 日记生成失败:', e?.message || e);
    return false;
  }
}

/**
 * 补齐日记：30 分钟检查一次，每次最多 2 天；失败则 30 分钟后再试（同每日摘要的重试思路）。
 * 全程静默。
 */
export async function ensureDailyDiaries(): Promise<void> {
  try {
    const now = Date.now();
    if (getCounter('diary_retry_after') > now) return;
    if (now - getCounter('diary_check_at') < 30 * 60 * 1000) return;
    setCounter('diary_check_at', now);

    const today = localDateStr();
    const start = localDateStr(new Date(now - 6 * 86400000));
    // 最近 7 天内：有日常事件或每日摘要、但还没有日记的日子，按正序补齐
    const missing = dbAll<{ d: string }>(
      `SELECT d FROM (
         SELECT date(created_at, 'localtime') AS d FROM agent_daily_events
         WHERE user_id = ? AND date(created_at, 'localtime') >= ? AND date(created_at, 'localtime') <= ?
         UNION
         SELECT date AS d FROM daily_summaries
         WHERE user_id = ? AND date >= ? AND date <= ?
       )
       WHERE d NOT IN (SELECT date FROM agent_diaries WHERE user_id = ?)
       ORDER BY d ASC LIMIT 2`,
      DEFAULT_USER_ID, start, today,
      DEFAULT_USER_ID, start, today,
      DEFAULT_USER_ID
    );
    if (!missing.length) return;

    for (const row of missing) {
      const ok = await generateDiary(row.d);
      if (!ok) {
        setCounter('diary_retry_after', Date.now() + 30 * 60 * 1000);
        return;
      }
    }
  } catch (e: any) {
    console.warn('[life] ensureDailyDiaries 失败:', e?.message || e);
  }
}