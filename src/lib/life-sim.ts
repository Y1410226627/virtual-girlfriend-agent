// 生活系统 · 模拟推进层：主推进 advanceLife / 状态增量 / 互动康复 / 周快照
// 由 life.ts 拆分而来（原样搬移，行为不变）
import { dbRun, DEFAULT_USER_ID, getCounter, bumpCounter, boolSetting, customModeOn, cAll, cRun } from './db';
import { cId } from './companion-context';
import { shouldApplyPokeEffect } from './interactions';
import { clamp, nowIso, localDateStr, round1 } from './utils';
import { getRelationshipState, logRelationship } from './relationship';
import { attachmentStyle, getAttachmentState } from './attachment';
import { personalityMap } from './personality';
import {
  ensureLife, getHealth, getPsychology, getLocation, getActivity, logLife, startIllness, isWeekend,
  currentLifeTemplate, type LifeTemplate,
  listDailyEvents, listLifeLogs, type DailyEventRow,
} from './life-core';
import { EVENT_DRIFT, getActiveEvent, activityTypeOfEvent } from './life-events';
import { getSharedWorld } from './life-shared';

/* ------------------------------------------------------------------ */
/* 日常轨迹（按她的身份模板推导；默认 student，与"大一学生"旧行为一致）  */
/* ------------------------------------------------------------------ */
export interface Block {
  from: number; to: number;
  location: string; locationType: string;
  activity: string; activityType: string;
}

/** student：工作日作息（保持既有数据不变） */
const STUDENT_WEEKDAY: Block[] = [
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

/** student：周末作息（保持既有数据不变） */
const STUDENT_WEEKEND: Block[] = [
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

/** 把"学校作息"改写成"研究生作息"：教学楼/教室 → 实验室，上课 → 做实验/看文献 */
function graduateify(blocks: Block[]): Block[] {
  return blocks.map((b) => {
    if (b.locationType !== 'school') return b;
    if (b.activityType === 'meal') return b; // 食堂吃饭保持不变
    return { ...b, location: '实验室', activity: '做实验、看文献', activityType: 'study' };
  });
}

/** 把"学校作息"改写成"上班作息"：学校相关地点 → 公司，上课/自习 → 上班/加班 */
function workify(blocks: Block[]): Block[] {
  return blocks.map((b) => {
    if (b.activityType === 'commute') {
      return { ...b, location: '路上', activity: /回/.test(b.activity) ? '下班回家' : '通勤上班' };
    }
    if (b.locationType === 'school') {
      return { ...b, location: '公司', activity: b.activityType === 'study' ? '加班、处理工作' : '上班、处理工作', activityType: 'work' };
    }
    return { ...b, location: /宿舍/.test(b.location) ? '家' : b.location };
  });
}

/** 自由职业：不打卡，作息更松散（地点多在家/咖啡店） */
const FREELANCER_WEEKDAY: Block[] = [
  { from: 0, to: 8, location: '家', locationType: 'home', activity: '睡觉', activityType: 'sleep' },
  { from: 8, to: 9, location: '家', locationType: 'home', activity: '慢慢起床、吃早饭', activityType: 'meal' },
  { from: 9, to: 12, location: '家', locationType: 'home', activity: '在家工作、写东西', activityType: 'work' },
  { from: 12, to: 13, location: '家', locationType: 'home', activity: '吃午饭', activityType: 'meal' },
  { from: 13, to: 15.5, location: '咖啡店', locationType: 'cafe', activity: '在咖啡店赶稿', activityType: 'work' },
  { from: 15.5, to: 18, location: '家', locationType: 'home', activity: '在家工作、写东西', activityType: 'work' },
  { from: 18, to: 19.5, location: '家', locationType: 'home', activity: '吃晚饭', activityType: 'meal' },
  { from: 19.5, to: 22, location: '家', locationType: 'home', activity: '看剧、刷手机', activityType: 'leisure' },
  { from: 22, to: 22.5, location: '家', locationType: 'home', activity: '洗澡', activityType: 'shower' },
  { from: 22.5, to: 24, location: '家', locationType: 'home', activity: '躺床上刷手机', activityType: 'bed' },
];

export interface LifeSchedule { weekday: Block[]; weekend: Block[] }

/** 身份模板 → 作息表（student 与旧数据完全一致，保持向后兼容） */
export function scheduleOf(t: LifeTemplate): LifeSchedule {
  switch (t) {
    case 'graduate':
      return { weekday: graduateify(STUDENT_WEEKDAY), weekend: graduateify(STUDENT_WEEKEND) };
    case 'worker':
      return { weekday: workify(STUDENT_WEEKDAY), weekend: STUDENT_WEEKEND };
    case 'intern': {
      const base = workify(STUDENT_WEEKDAY).map((b) => (b.activityType === 'work' ? { ...b, activity: '实习、跟着做项目' } : b));
      return { weekday: base, weekend: STUDENT_WEEKEND };
    }
    case 'freelancer':
      return { weekday: FREELANCER_WEEKDAY, weekend: STUDENT_WEEKEND };
    default:
      return { weekday: STUDENT_WEEKDAY, weekend: STUDENT_WEEKEND };
  }
}

function blockAt(d: Date, t: LifeTemplate): Block {
  const sched = scheduleOf(t);
  const table = isWeekend(d) ? sched.weekend : sched.weekday;
  const h = d.getHours() + d.getMinutes() / 60;
  return table.find((b) => h >= b.from && h < b.to) || table[table.length - 1]!;
}

/* ------------------------------------------------------------------ */
/* 日常事件                                                            */
/* ------------------------------------------------------------------ */
interface EventPoolEntry {
  type: string;
  content: string;
  impact: Record<string, number>;
  when?: string[];
  /** 硬约束：仅在这些 activity_type 下发生（空 = 不限） */
  activities?: string[];
  /** 硬约束：仅在这些 location_type 下发生 */
  locations?: string[];
  /** 硬约束：仅在此时间段发生（含 from、不含 to，单位小时 0-24） */
  hours?: [number, number];
  /** 生病时是否仍可能发生（默认 true） */
  whenIll?: boolean;
  /** 相对权重（默认 1），用于风格偏好 */
  weight?: number;
}

const EVENT_POOL: EventPoolEntry[] = [
  { type: 'small', content: '在路边看到一只橘猫，蹲下来看了好久', impact: { mood: 6, loneliness: -4 }, locations: ['out'], whenIll: false, weight: 1.2 },
  { type: 'small', content: '买咖啡的时候洒到袖子上了，郁闷', impact: { stress: 6, mood: -3 }, locations: ['out', 'school', 'cafe'], weight: 1 },
  { type: 'small', content: '上课差点睡着，被点起来回答问题', impact: { stress: 5, mental_energy: -6 }, activities: ['class'], weight: 1 },
  { type: 'small', content: '室友带了小蛋糕回来，分了一块给她', impact: { mood: 7, self_worth: 3 }, locations: ['home'], weight: 1.1 },
  { type: 'small', content: '下雨没带伞，淋了一小段路', impact: { mood: -4, illnessRisk: 0.08 }, locations: ['out', 'school', 'commute', 'cafe'], whenIll: false, weight: 1 },
  { type: 'small', content: '刷到一部很想看的剧，加了收藏', impact: { mood: 5 }, weight: 1 },
  { type: 'small', content: '和同学为小组作业的事有点分歧', impact: { stress: 8, mood: -4 }, activities: ['class', 'study'], weight: 1 },
  { type: 'small', content: '在图书馆借到了一直想看的书', impact: { mood: 6, mental_energy: 4 }, activities: ['study'], locations: ['school'], weight: 1.1 },
  { type: 'small', content: '突然很想他，翻了一下以前的聊天记录', impact: { missing_user: 10, mood: 2 }, weight: 1.2 },
  { type: 'small', content: '手机快没电又没带充电宝，一路都很慌', impact: { stress: 4 }, weight: 1 },
  { type: 'small', content: '今天状态不错，把拖了很久的作业写完了', impact: { self_worth: 8, stress: -8, mood: 5 }, activities: ['class', 'study', 'work'], weight: 1 },
  { type: 'small', content: '路过一家新开的甜品店，记下来了想带他一起去', impact: { missing_user: 6, mood: 4 }, locations: ['out'], whenIll: false, weight: 1.1 },
];

/** 事件生成的上下文（时间/身份/地点/健康） */
export interface EventContext {
  hour: number;
  activityType: string;
  locationType: string;
  illness: string;
}

/** 硬约束过滤：先去掉不符合当前身份/地点/时段/健康状态的事件 */
export function eligibleEvents(ctx: EventContext, pool: EventPoolEntry[] = EVENT_POOL): EventPoolEntry[] {
  return pool.filter((e) => {
    if (ctx.activityType === 'sleep') return false; // 睡觉时不会有日常小事
    if (e.activities && !e.activities.includes(ctx.activityType)) return false;
    if (e.locations && !e.locations.includes(ctx.locationType)) return false;
    if (e.hours && !(ctx.hour >= e.hours[0] && ctx.hour < e.hours[1])) return false;
    if (ctx.illness !== 'none' && e.whenIll === false) return false;
    return true;
  });
}

/** 风格偏好权重：深夜更安静、出门更容易遇到户外小事、生病时更低产 */
function eventWeight(e: EventPoolEntry, ctx: EventContext): number {
  let w = e.weight ?? 1;
  const lateNight = ctx.hour >= 23 || ctx.hour < 6;
  if (lateNight) w *= e.locations && e.locations.includes('out') ? 0.3 : 0.6;
  if ((ctx.activityType === 'out' || ctx.locationType === 'out') && e.locations?.includes('out')) w *= 1.6;
  if (ctx.illness !== 'none') w *= 0.7;
  return w > 0 ? w : 0;
}

/** 按权重抽一个候选：roll ∈ [0,1)（调用方用确定性哈希生成，回放结果稳定） */
export function pickEvent(ctx: EventContext, roll: number, pool: EventPoolEntry[] = EVENT_POOL): EventPoolEntry | null {
  const cands = eligibleEvents(ctx, pool);
  if (!cands.length) return null;
  const weights = cands.map((e) => eventWeight(e, ctx));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return cands[0]!;
  let target = Math.min(Math.max(roll, 0), 0.999999) * total;
  for (let i = 0; i < cands.length; i++) {
    target -= weights[i]!;
    if (target < 0) return cands[i]!;
  }
  return cands[cands.length - 1]!;
}

/** 生病触发门限：正在生病、或距上次生病不足 7 天，都不再触发 */
const ILLNESS_COOLDOWN_MS = 7 * 86400000;
export function illnessTriggerAllowed(health: { illness: string }, nowMs: number): boolean {
  if (health.illness !== 'none') return false;
  const last = getCounter('illness_last_at');
  if (last > 0 && nowMs - last < ILLNESS_COOLDOWN_MS) return false;
  return true;
}

function maybeGenerateEvent(d: Date, indep: number, block: Block): void {
  const todayCount = cAll<DailyEventRow>(
    "SELECT id FROM agent_daily_events WHERE companion_id = ? AND date(created_at, 'localtime') = ?",
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
  const health = getHealth();
  const ctx: EventContext = {
    hour: d.getHours() + d.getMinutes() / 60,
    activityType: block.activityType,
    locationType: block.locationType,
    illness: health.illness,
  };
  const roll = ((hash >>> 8) % 1000) / 1000;
  const pick = pickEvent(ctx, roll);
  if (!pick) return;
  cRun(
    'INSERT INTO agent_daily_events (companion_id, user_id, event_type, content, impact_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
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
    'UPDATE agent_psychology SET base_emotion = ?, stress = ?, loneliness = ?, missing_user = ?, self_worth = ?, mental_energy = ?, updated_at = ? WHERE companion_id = ?',
    emotion, round1(stress), round1(lon), round1(miss), round1(worth), round1(me), nowIso(), cId()
  );
  if ((pick.impact.illnessRisk || 0) > 0 && normalized < (pick.impact.illnessRisk as number)) {
    // 已经在生病 / 距上次生病不足 7 天 → 跳过，避免病程叠加
    if (illnessTriggerAllowed(health, d.getTime())) {
      startIllness('感冒', 2 + ((hash >>> 16) % 2000) / 1000, d.toISOString());
    }
  }
}

/* ------------------------------------------------------------------ */
/* 主推进：由流逝时间推导一切                                            */
/* ------------------------------------------------------------------ */
export function advanceLife(): { steps: number; changes: string[] } {
  ensureLife();
  // 自定义模式：冻结一切自动数值漂移（数值由用户直控；记忆/日记/叙事不受影响）
  if (customModeOn()) return { steps: 0, changes: [] };
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
  const template = currentLifeTemplate();
  const indep = Number(personalityMap().independence ?? 50);
  const att = attachmentStyle();
  const rel = getRelationshipState();
  const lastChatAt = rel.last_interaction_at ? new Date(rel.last_interaction_at).getTime() : NaN;
  let cycleDate = localDateStr(new Date(lastAt));
  // 可控事件进行中：作息表不覆盖她正在做的事（她说了"去睡了"，就一直睡到事件结束）
  const activeEvent = getActiveEvent();
  const activeEventStart = activeEvent ? new Date(activeEvent.started_at).getTime() : NaN;
  // 事件结束边界：过了 expected_end_at 就不再算"正在进行"（否则过期事件会一直覆盖后续时段的作息）
  const activeEventEnd = activeEvent?.expected_end_at ? new Date(activeEvent.expected_end_at).getTime() : NaN;
  const activeEventActType = activeEvent ? activityTypeOfEvent(activeEvent.event_type) : '';

  for (let k = 0; k < steps; k++) {
    const d = new Date(simStart + k * stepH * 3600000);
    const stepEnd = new Date(simStart + (k + 1) * stepH * 3600000);
    const hour = d.getHours() + d.getMinutes() / 60;
    let block = blockAt(d, template);
    const health = getHealth();
    const psy = getPsychology();
    const loc = getLocation();
    const act = getActivity();
    const eventStep = !!(
      activeEvent &&
      isFinite(activeEventStart) &&
      d.getTime() >= activeEventStart &&
      (!isFinite(activeEventEnd) || d.getTime() < activeEventEnd)
    );
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
        'UPDATE agent_location SET current_location = ?, location_type = ?, arrived_at = ?, expected_leave_at = ?, updated_at = ? WHERE companion_id = ?',
        block.location, block.locationType, d.toISOString(), endAt.toISOString(), nowIso(), cId()
      );
      dbRun(
        'UPDATE agent_activity SET current_activity = ?, activity_type = ?, started_at = ?, expected_end_at = ?, updated_at = ? WHERE companion_id = ?',
        block.activity, block.activityType, d.toISOString(), endAt.toISOString(), nowIso(), cId()
      );
      changes.push(`${block.activity}（${block.location}）`);
      // 日志时间用"这一步的模拟时刻"，历史回放时不能再落成"今天"
      logLife('activity', act.current_activity, block.activity, `作息时间到：${block.location}`, d.toISOString());
    }

    // 2) 健康漂移
    let energy = health.energy;
    let hunger = health.hunger;
    let sleepQ = health.sleep_quality;
    const exercise = health.exercise;
    // 可控事件进行中：只按事件影响走（与"立即结束按等效时长结算"是同一套数值，避免两条路径差一倍）
    const eventEffect = eventStep && activeEvent ? EVENT_DRIFT[activeEvent.event_type] || EVENT_DRIFT.other : null;
    if (eventEffect) {
      energy = clamp(energy + (eventEffect.energy || 0), 0, 100);
      hunger = clamp(hunger + (eventEffect.hunger || 0), 0, 100);
      sleepQ = clamp(sleepQ + (eventEffect.sleepQ || 0), 0, 100);
      if (activeEvent!.event_type === 'meal') {
        dbRun('UPDATE agent_health SET last_meal_at = ? WHERE companion_id = ?', d.toISOString(), cId());
      }
    } else if (block.activityType === 'sleep') {
      energy = clamp(energy + 9, 0, 100);
      hunger = clamp(hunger - 2.5, 0, 100);
      if (hour >= 6 && hour <= 9) sleepQ = clamp(sleepQ + (rel.unresolved_tension > 40 ? 2 : 5), 0, 100);
    } else {
      const focus = block.activityType === 'class' || block.activityType === 'study' || block.activityType === 'work';
      energy = clamp(energy - (focus ? 3.4 : 2.2), 0, 100);
      hunger = clamp(hunger - (block.activityType === 'class' || block.activityType === 'work' ? 7 : 5), 0, 100);
      if (block.activityType === 'shower' || block.activityType === 'bed') sleepQ = clamp(sleepQ + 1.2, 0, 100);
      if (block.activityType === 'meal') {
        hunger = clamp(hunger + 34, 0, 100);
        energy = clamp(energy + 5, 0, 100);
        dbRun('UPDATE agent_health SET last_meal_at = ? WHERE companion_id = ?', d.toISOString(), cId());
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
          logLife('illness', health.illness, '恢复', '病程结束', d.toISOString());
          changes.push('病好了');
        }
      }
    }
    dbRun(
      `UPDATE agent_health SET energy = ?, hunger = ?, sleep_quality = ?, exercise = ?, illness = ?, illness_severity = ?, updated_at = ? WHERE companion_id = ?`,
      round1(energy), round1(hunger), round1(sleepQ), round1(exercise), illness, round1(severity), stepEnd.toISOString(), cId()
    );

    // 3) 生理周期（每天推进 1 天）
    const currentDate = localDateStr(d);
    if (currentDate !== cycleDate) {
      const daysPassed = Math.max(1, Math.round((new Date(`${currentDate}T00:00:00`).getTime() - new Date(`${cycleDate}T00:00:00`).getTime()) / 86400000));
      const cycleDay = ((health.cycle_day - 1 + daysPassed) % (health.cycle_length || 28)) + 1;
      dbRun('UPDATE agent_health SET cycle_day = ? WHERE companion_id = ?', cycleDay, cId());
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
    const workLoad = block.activityType === 'class' || block.activityType === 'study' || block.activityType === 'work' ? 3 : block.activityType === 'out' ? 1 : -1.5;
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
      `UPDATE agent_psychology SET base_emotion = ?, stress = ?, loneliness = ?, missing_user = ?, security = ?, mental_energy = ?, updated_at = ? WHERE companion_id = ?`,
      emotion,
      round1(stress),
      round1(lon),
      round1(miss),
      round1(security),
      round1(me),
      stepEnd.toISOString(),
      cId()
    );

    // 5) 随机日常事件
    maybeGenerateEvent(d, indep, block);
  }

  return { steps, changes };
}

/** 把健康表的 updated_at 往回拨 N 小时，再推进一次（立刻看到生活变化） */
export function simulateHours(hours: number): { steps: number; changes: string[] } {
  const h = Math.min(72, Math.max(1, hours || 6));
  dbRun(
    'UPDATE agent_health SET updated_at = ? WHERE companion_id = ?',
    new Date(Date.now() - h * 3600000).toISOString(),
    cId()
  );
  return advanceLife();
}

/* ------------------------------------------------------------------ */
/* 分析模型驱动的状态变化                                               */
/* ------------------------------------------------------------------ */
/** 分析模型给出的身体增量（health_delta） */
export interface LifeHealthDelta { energy?: number; hunger?: number; illness?: string }
/** 分析模型给出的心理增量（psychology_delta） */
export interface LifePsychologyDelta {
  stress?: number; loneliness?: number; missing_user?: number;
  security?: number; self_worth?: number; mental_energy?: number;
}

export function applyLifeDeltas(input: { health?: LifeHealthDelta; psychology?: LifePsychologyDelta }): void {
  // 自定义模式：身体/心理数值不自动漂移
  if (customModeOn()) return;
  const hd = input.health || {};
  const pd = input.psychology || {};
  const h = getHealth();
  const p = getPsychology();
  const num = (v: unknown) => (isFinite(Number(v)) ? Number(v) : 0);

  const energy = clamp(h.energy + num(hd.energy), 0, 100);
  const hunger = clamp(h.hunger + num(hd.hunger), 0, 100);
  dbRun(
    'UPDATE agent_health SET energy = ?, hunger = ?, updated_at = ? WHERE companion_id = ?',
    round1(energy), round1(hunger), nowIso(), cId()
  );

  const illnessEvent = String(hd.illness || 'none');
  if (illnessEvent === 'new') {
    // 时长确定性推导（同一天同一轮给同样的值，避免随机跳变）
    const seed = Number(getCounter('turn_count') || 0);
    startIllness('感冒', 2 + (seed % 20) / 10);
  } else if (illnessEvent === 'recovered' && h.illness !== 'none') {
    // 模型判定"这轮之后康复了" → 直接结束病程（比机械等天数自然）
    dbRun(
      "UPDATE agent_health SET illness = 'none', illness_severity = 0, illness_duration_days = 0, updated_at = ? WHERE companion_id = ?",
      nowIso(),
      cId()
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
    `UPDATE agent_psychology SET stress = ?, loneliness = ?, missing_user = ?, security = ?, self_worth = ?, mental_energy = ?, updated_at = ? WHERE companion_id = ?`,
    round1(stress), round1(loneliness), round1(missing), round1(security), round1(worth), round1(me), nowIso(), cId()
  );
}

/* ------------------------------------------------------------------ */
/* 康复：亲密互动也会影响状态                                            */
/* ------------------------------------------------------------------ */
export function applyInteractionEffects(_opts: { caredForHer?: boolean }): void {
  // 自定义模式：聊天的自动康复也冻结（数值由用户直控）
  if (customModeOn()) return;
  // P1-04：被关心的额外加成已统一到 life-core.applyCareEvent，此处不再重复加成，
  // 参数仅为向后兼容保留（caredForHer 被忽略），避免同一次"被关心"走两套效果。
  const psy = getPsychology();
  // 聊过天会把孤独/想念往下压一点（温和底噪），真正的下降靠 applyCareEvent
  dbRun(
    'UPDATE agent_psychology SET loneliness = ?, missing_user = ?, updated_at = ? WHERE companion_id = ?',
    round1(clamp(psy.loneliness - 2, 0, 100)),
    round1(clamp(psy.missing_user - 3, 0, 100)),
    nowIso(), cId()
  );
}

/* ------------------------------------------------------------------ */
/* 触摸互动：照片 / 头像上的"摸头 / 戳脸 / 牵手 / 抱抱"的轻效果          */
/* ------------------------------------------------------------------ */
/** 一次互动的数值效果（很小，只为"真实感"，不刷数值） */
const POKE_EFFECT: Record<string, { security: number; loneliness: number; label: string }> = {
  pat: { security: 1.5, loneliness: -2, label: '摸头' },
  poke_cheek: { security: 1, loneliness: -2, label: '戳脸颊' },
  hold_hand: { security: 2, loneliness: -2.5, label: '牵手' },
  hug: { security: 2, loneliness: -3, label: '抱抱' },
};

export interface PokeEffectResult {
  applied: boolean;
  reason: 'ok' | 'custom' | 'cap' | 'unknown';
}

/**
 * 触摸互动的小效果：孤独↓、安全感↑，量级很小。
 * 自定义模式冻结数值、超过每日上限 → 只回文案不改数值；数值一律 clamp 到 0..100。
 */
export function applyPokeEffect(kind: string): PokeEffectResult {
  const eff = POKE_EFFECT[kind];
  if (!eff) return { applied: false, reason: 'unknown' };
  // 每天记一次（跨天自动重置，key 带本地日期）
  const used = getCounter(`poke_daily_${localDateStr()}`);
  bumpCounter(`poke_daily_${localDateStr()}`);
  const custom = customModeOn();
  if (!shouldApplyPokeEffect(used, custom)) {
    return { applied: false, reason: custom ? 'custom' : 'cap' };
  }
  const p = getPsychology();
  const security = clamp(p.security + eff.security, 0, 100);
  const loneliness = clamp(p.loneliness + eff.loneliness, 0, 100);
  dbRun(
    'UPDATE agent_psychology SET security = ?, loneliness = ?, updated_at = ? WHERE companion_id = ?',
    round1(security), round1(loneliness), nowIso(), cId()
  );
  logRelationship('interaction', `被你${eff.label}`, round1(p.loneliness), round1(loneliness), '触摸互动');
  return { applied: true, reason: 'ok' };
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
  cRun(
    'INSERT OR IGNORE INTO world_weekly_snapshots (companion_id, user_id, week, state_json, created_at) VALUES (?, ?, ?, ?, ?)',
    DEFAULT_USER_ID, weekKey(), JSON.stringify(state), nowIso()
  );
}