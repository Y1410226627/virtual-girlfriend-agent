// 世界模拟与生活系统：她有自己的作息、身体、心理、位置、活动与日常事件
// 设计要点：连续性优先（一切由"流逝了多少时间"推导，不随机跳变）、独立生活、逐步揭露、状态影响对话
import { dbAll, dbGet, dbRun, DEFAULT_USER_ID, getSetting, boolSetting, numSetting } from './db';
import { clamp, nowIso, localHour, localDateStr, round1, safeJson, hoursSince } from './utils';
import { getRelationshipState, getPersona } from './relationship';
import { attachmentStyle, getAttachmentState } from './attachment';
import { personalityMap } from './personality';
import { logRelationship } from './relationship';

/* ------------------------------------------------------------------ */
/* 表初始化                                                            */
/* ------------------------------------------------------------------ */
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
  dbRun('INSERT OR IGNORE INTO intimacy_state (user_id, updated_at) VALUES (?, ?)', DEFAULT_USER_ID, now);
  dbRun('INSERT OR IGNORE INTO intimacy_content_level (user_id, level, updated_at) VALUES (?, 0, ?)', DEFAULT_USER_ID, now);
  if (!dbGet('SELECT id FROM intimacy_preferences WHERE user_id = ? LIMIT 1', DEFAULT_USER_ID)) {
    seedPreferences();
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
  return dbGet<HealthRow>('SELECT * FROM agent_health WHERE user_id = ?', DEFAULT_USER_ID)!;
}
export function getPsychology(): PsychRow {
  return dbGet<PsychRow>('SELECT * FROM agent_psychology WHERE user_id = ?', DEFAULT_USER_ID)!;
}
export function getLocation(): LocationRow {
  return dbGet<LocationRow>('SELECT * FROM agent_location WHERE user_id = ?', DEFAULT_USER_ID)!;
}
export function getActivity(): ActivityRow {
  return dbGet<ActivityRow>('SELECT * FROM agent_activity WHERE user_id = ?', DEFAULT_USER_ID)!;
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
  };
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

function logLife(field: string, oldV: any, newV: any, reason: string) {
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

function maybeGenerateEvent(d: Date, indep: number): void {
  const block = blockAt(d);
  const todayCount = dbAll<any>(
    "SELECT id FROM agent_daily_events WHERE user_id = ? AND substr(created_at,1,10) = ?",
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
  const moodMap: Record<string, [keyof PsychRow, number]> = {};
  let stress = psy.stress, lon = psy.loneliness, miss = psy.missing_user, worth = psy.self_worth, me = psy.mental_energy;
  stress = clamp(stress + (pick.impact.stress || 0), 0, 100);
  lon = clamp(lon + (pick.impact.loneliness || 0), 0, 100);
  miss = clamp(miss + (pick.impact.missing_user || 0), 0, 100);
  worth = clamp(worth + (pick.impact.self_worth || 0), 0, 100);
  me = clamp(me + (pick.impact.mental_energy || 0), 0, 100);
  dbRun(
    'UPDATE agent_psychology SET stress = ?, loneliness = ?, missing_user = ?, self_worth = ?, mental_energy = ?, updated_at = ? WHERE user_id = ?',
    round1(stress), round1(lon), round1(miss), round1(worth), round1(me), nowIso(), DEFAULT_USER_ID
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
  const maxSteps = 96; // 最多往回推 48 小时，避免长时间未开机时的巨量循环
  const steps = Math.min(maxSteps, Math.floor(elapsedH / stepH));
  const indep = Number(personalityMap().independence ?? 50);
  const att = attachmentStyle();
  const rel = getRelationshipState();
  let cycleDate = localDateStr(new Date(lastAt));

  for (let i = steps; i >= 1; i--) {
    const d = new Date(now - i * stepH * 3600000);
    const hour = d.getHours() + d.getMinutes() / 60;
    const block = blockAt(d);
    const health = getHealth();
    const psy = getPsychology();
    const loc = getLocation();
    const act = getActivity();

    // 1) 位置 / 活动跟随作息
    if (block.location !== loc.current_location || block.activity !== act.current_activity) {
      const endAt = new Date(now - (i - 1) * stepH * 3600000);
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
    if (block.activityType === 'sleep') {
      energy = clamp(energy + 9, 0, 100);
      hunger = clamp(hunger - 2.5, 0, 100);
      if (hour >= 6 && hour <= 9) sleepQ = clamp(sleepQ + (rel.unresolved_tension > 40 ? 2 : 5), 0, 100);
    } else {
      energy = clamp(energy - (block.activityType === 'class' || block.activityType === 'study' ? 3.4 : 2.2), 0, 100);
      hunger = clamp(hunger - (block.activityType === 'class' ? 7 : 5), 0, 100);
      if (block.activityType === 'shower' || block.activityType === 'bed') sleepQ = clamp(sleepQ + 1.2, 0, 100);
    }
    if (block.activityType === 'meal') {
      hunger = clamp(hunger + 34, 0, 100);
      energy = clamp(energy + 5, 0, 100);
      dbRun('UPDATE agent_health SET last_meal_at = ? WHERE user_id = ?', d.toISOString(), DEFAULT_USER_ID);
    }
    // 生病：随时间恢复
    let illness = health.illness;
    let severity = health.illness_severity;
    if (illness !== 'none') {
      const started = health.illness_start ? new Date(health.illness_start).getTime() : now;
      const durH = (health.illness_duration_days || 2) * 24;
      const passedH = (d.getTime() - started) / 3600000;
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
    // 吃饭后 slight mood 恢复
    dbRun(
      `UPDATE agent_health SET energy = ?, hunger = ?, sleep_quality = ?, exercise = ?, illness = ?, illness_severity = ?, updated_at = ? WHERE user_id = ?`,
      round1(energy), round1(hunger), round1(sleepQ), round1(exercise), illness, round1(severity), nowIso(), DEFAULT_USER_ID
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
    const hoursSinceChat = hoursSince(rel.last_interaction_at);
    let stress = psy.stress;
    let lon = psy.loneliness;
    let miss = psy.missing_user;
    let security = psy.security;
    let me = psy.mental_energy;
    const workLoad = block.activityType === 'class' || block.activityType === 'study' ? 3 : block.activityType === 'out' ? 1 : -1.5;
    stress = clamp(stress + workLoad * (stepH / 2) + (illness !== 'none' ? 1.2 : 0), 0, 100);
    if (block.activityType === 'sleep' || block.activityType === 'rest') me = clamp(me + 6, 0, 100);
    else if (block.activityType === 'out' || block.activityType === 'leisure') me = clamp(me + 2, 0, 100);
    else me = clamp(me - (att === 'avoidant' ? 2.6 : 2), 0, 100);
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
      emotion, round1(stress), round1(lon), round1(miss), round1(security), round1(me), nowIso(), DEFAULT_USER_ID
    );

    // 5) 随机日常事件
    maybeGenerateEvent(d, indep);
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
  if (illnessEvent === 'new') startIllness('感冒', 2 + Math.random() * 2);

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
  dbRun(
    'UPDATE agent_activity SET current_activity = ?, activity_type = ?, started_at = ?, expected_end_at = NULL, updated_at = ? WHERE user_id = ?',
    /家|宿舍/.test(loc) ? '刚到家，缓一缓' : `在${loc}`, /家|宿舍/.test(loc) ? 'home' : 'out', nowIso(), nowIso(), DEFAULT_USER_ID
  );
  logLife('location', cur.current_location, loc, reason || '对话里提到');
  if (act.current_activity) logLife('activity', act.current_activity, '跟随位置变化', reason || '');
}

export function applyActivityChange(newActivity: string, expectedEnd: string): void {
  const act = String(newActivity || '').trim();
  if (!act || act.length > 24) return;
  const cur = getActivity();
  if (cur.current_activity === act) return;
  const type = /睡/.test(act) ? 'sleep' : /上课|自习|写作业|开会|工作/.test(act) ? 'class' : /吃/.test(act) ? 'meal' : /洗澡/.test(act) ? 'shower' : /看剧|看电|看书|游戏|刷/.test(act) ? 'leisure' : 'idle';
  const end = expectedEnd && expectedEnd.length <= 20 ? expectedEnd : null;
  dbRun(
    'UPDATE agent_activity SET current_activity = ?, activity_type = ?, started_at = ?, expected_end_at = ?, updated_at = ? WHERE user_id = ?',
    act, type, nowIso(), end, nowIso(), DEFAULT_USER_ID
  );
  logLife('activity', cur.current_activity, act, '对话里提到');
}

export function addDailyEvent(type: string, content: string, impact: string): void {
  const c = String(content || '').trim();
  if (c.length < 3) return;
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
  dbRun(
    'UPDATE agent_psychology SET loneliness = ?, missing_user = ?, updated_at = ? WHERE user_id = ?',
    round1(clamp(psy.loneliness - 5, 0, 100)),
    round1(clamp(psy.missing_user - 7, 0, 100)),
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
export function lifePromptBlock(): string {
  const h = getHealth();
  const p = getPsychology();
  const loc = getLocation();
  const act = getActivity();
  const w = getSharedWorld();
  const stage = getRelationshipState().stage;

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
    `- 正在做：${act.current_activity}${act.expected_end_at ? `（大约到 ${new Date(act.expected_end_at).toTimeString().slice(0, 5)} 结束）` : ''}`,
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

  return lines.join('\n') + '\n' + rules.join('\n');
}

/** 个人信息：按关系阶段逐步揭露 */
const FIELD_STAGE: Record<string, number> = {
  nickname: 0, age: 0, city: 0, hobbies: 0,
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
  for (const t of types) {
    const preference = dbGet<any>(
      'SELECT reveal_stage FROM intimacy_preferences WHERE user_id = ? AND preference_type = ? LIMIT 1',
      DEFAULT_USER_ID, t
    );
    if (!preference || getRelationshipState().stage < Number(preference.reveal_stage || 0)) continue;
    dbRun(
      "UPDATE intimacy_preferences SET reveal_status = 'revealed' WHERE user_id = ? AND preference_type = ? AND reveal_status != 'revealed'",
      DEFAULT_USER_ID, t
    );
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
  if (hidden.length && rel.stage >= 2) {
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