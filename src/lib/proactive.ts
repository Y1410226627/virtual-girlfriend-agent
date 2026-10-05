// 主动消息：定时任务检查是否该由她先开口（不骚扰、有节制、引用记忆、符合阶段）
import { dbAll, dbGet, dbRun, getSetting, getCounter, setCounter, bumpCounter, DEFAULT_USER_ID } from './db';
import { hoursSince, localDateStr, localHour, minutesSince, nowIso, errMsg, truncate } from './utils';
import { chat } from './llm';
import { buildProactiveMessages, type ProactiveWhyNow } from './prompts';
import { retrieveMemories, formatMemoryBlock } from './memory';
import { getRelationshipState, agentName, userName } from './relationship';
import { saveAssistantMessage, recentActionPhrases, recentReplies } from './engine';
import { personalityMap } from './personality';
import { attachmentStyle } from './attachment';
import { humanizeReply } from './humanize';
import { ensureLife, advanceLife, getActivity, getPsychology, getSharedWorld, getActiveEvent, getExpiredEvent, eventLateWindowMinutes, settleExpiredEvent, listDailyEvents, type OngoingEventRow } from './life';
import { advanceIntimacy } from './intimacy';
import { maybeGenerateDailySummary } from './analysis';
import { fadeTension } from './conflict';
import { analyzeProactiveMessage } from './proactive-analysis';

export type ProactiveKind = 'greeting' | 'memory' | 'event' | 'relationship_talk' | 'stage_confirm' | 'ritual' | 'miss' | 'event_end';

export interface ProactiveMessageRow {
  id: number;
  user_id: number;
  kind: string;
  content: string;
  message_id: number | null;
  created_at: string;
}

interface EventRow {
  id: number;
  user_id: number;
  title: string;
  event_date: string;
  repeat_yearly: number;
  kind: string;
  description: string | null;
  created_at: string;
}

/** 早安 / 晚安仪式：早 6-10 点、晚 21-23 点各最多一次（now 作为参数便于测试） */
function ritualSlotNow(now: Date = new Date()): 'morning' | 'night' | null {
  const hour = localHour(now);
  const slot: 'morning' | 'night' | null = hour >= 6 && hour < 10 ? 'morning' : hour >= 21 && hour < 23 ? 'night' : null;
  if (!slot) return null;
  const w = getSharedWorld();
  const hasRitual = (w.rituals || []).some((r: { content?: string; title?: string }) =>
    /早安|晚安|早上|睡前/.test(String(r.content || r.title || ''))
  );
  if (!hasRitual) return null;
  const today = localDateStr(now);
  const sent = dbAll<{ created_at: string }>(
    "SELECT created_at FROM proactive_messages WHERE user_id = ? AND kind = 'ritual' AND date(created_at, 'localtime') = ?",
    DEFAULT_USER_ID,
    today
  );
  const sentHours = sent.map((s) => new Date(s.created_at).getHours());
  if (slot === 'morning' && sentHours.some((h) => h >= 6 && h < 12)) return null;
  if (slot === 'night' && sentHours.some((h) => h >= 20)) return null;
  return slot;
}

const FREQ_LIMITS: Record<string, { perDay: number; minGapHours: number }> = {
  off: { perDay: 0, minGapHours: 999 },
  low: { perDay: 1, minGapHours: 12 },
  medium: { perDay: 2, minGapHours: 6 },
  high: { perDay: 3, minGapHours: 3 },
};

function parseHm(hm: string): number {
  const [h, m] = String(hm || '0:0').split(':').map((x) => Number(x) || 0);
  return h! * 60 + m!;
}

function inQuietHours(now: Date = new Date()): boolean {
  const start = parseHm(getSetting('quiet_start') || '23:00');
  const end = parseHm(getSetting('quiet_end') || '08:00');
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

function todayEvent(now: Date = new Date()): EventRow | null {
  const today = localDateStr(now);
  const md = today.slice(5); // MM-DD
  const rows = dbAll<EventRow>(
    'SELECT * FROM events WHERE user_id = ? ORDER BY event_date ASC',
    DEFAULT_USER_ID
  );
  for (const e of rows) {
    const d = String(e.event_date || '');
    if (d === today) return e;
    if (Number(e.repeat_yearly) === 1 && d.slice(5) === md) return e;
  }
  return null;
}

/** 最后一次用户消息之后是否有她的"主动搭话"没被回应（"她的事结束了"这类例行提醒不算） */
function unansweredProactiveCount(): number {
  const rows = dbAll<{ message_id: number | null }>(
    "SELECT message_id FROM proactive_messages WHERE user_id = ? AND kind != 'event_end' ORDER BY id DESC LIMIT 3",
    DEFAULT_USER_ID
  );
  let count = 0;
  for (const p of rows) {
    const mid = Number(p.message_id || 0);
    if (!mid) {
      count++;
      continue;
    }
    const replied = dbGet<{ c: number }>(
      "SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND id > ? AND role = 'user'",
      DEFAULT_USER_ID,
      mid
    );
    if (Number(replied?.c || 0) > 0) break;
    count++;
  }
  return count;
}

/* ================================================================== */
/* 主动消息资格判定（纯逻辑：给定状态 + 时间 → 各类型独立判定）           */
/* 各类型有自己的触发条件与最小间隔，不再让所有类型共享同一个全局 gap。   */
/* ================================================================== */
export interface ProactiveState {
  /** 当前时刻（由调用方传入，便于测试） */
  now: Date;
  /** 手动触发：跳过静默 / 间隔 / 额度限制（仍保留各类型的语义条件） */
  force: boolean;
  // 关系 / 心理
  stage: number;
  unresolvedTension: number;
  pendingStageConfirm: boolean;
  pendingRelationshipTalk: boolean;
  missingUser: number;
  loneliness: number;
  // 时间 / 频率
  hasLastInteraction: boolean;
  hoursSinceLastMessage: number;
  hoursSinceLastProactive: number;
  todayCount: number;
  perDay: number;
  baseMinGapHours: number;
  unanswered: number;
  // 开关 / 场景
  frequencyOff: boolean;
  dnd: boolean;
  quiet: boolean;
  offline: boolean;
  offlineRecent: boolean;
  busy: boolean;
  // 仪式 / 特殊日子
  ritualSlot: 'morning' | 'night' | null;
  eventToday: boolean;
  /** 用于"要不要发 memory 类"的随机数（0~1） */
  random: number;
}

export interface KindEligibility {
  eligible: boolean;
  reason: string;
}

interface KindRule {
  /** 距上次"主动消息"的最小间隔（小时） */
  minGapHours: number;
  /** 是否再叠加全局频率的 minGap（baseMinGapHours） */
  usesGlobalGap: boolean;
  /** 距上次聊天的最小间隔（小时） */
  minChatGapHours: number;
  /** 是否消耗每日额度 */
  usesDailyBudget: boolean;
  /** 与间隔无关的语义触发条件 */
  wants: (st: ProactiveState) => boolean;
}

/** 各类型的独立规则（event_end 由 tickProactive 的独立路径处理，不参与这里的择优） */
export const PROACTIVE_RULES: Record<ProactiveKind, KindRule> = {
  greeting: { minGapHours: 0, usesGlobalGap: true, minChatGapHours: 6, usesDailyBudget: true, wants: () => true },
  memory: { minGapHours: 0, usesGlobalGap: true, minChatGapHours: 6, usesDailyBudget: true, wants: (st) => st.random < 0.45 },
  event: { minGapHours: 0, usesGlobalGap: true, minChatGapHours: 3, usesDailyBudget: true, wants: (st) => st.eventToday },
  ritual: {
    minGapHours: 0,
    usesGlobalGap: false,
    minChatGapHours: 6,
    usesDailyBudget: false,
    // 仪式不受每日额度与最小间隔限制，但同样不能在"等他确认关系/当天有特殊日子"时抢占
    wants: (st) => !st.force && st.ritualSlot !== null && !st.pendingStageConfirm && !st.eventToday,
  },
  relationship_talk: {
    minGapHours: 24,
    usesGlobalGap: false,
    minChatGapHours: 6,
    usesDailyBudget: true,
    wants: (st) => st.pendingRelationshipTalk || st.unresolvedTension > 50,
  },
  // 关系确认一旦触发会一直挂着，直到被回应；用 24h 抑制"一天内反复确认"，又不至于拖太久
  stage_confirm: { minGapHours: 24, usesGlobalGap: false, minChatGapHours: 6, usesDailyBudget: true, wants: (st) => st.pendingStageConfirm },
  miss: { minGapHours: 12, usesGlobalGap: false, minChatGapHours: 6, usesDailyBudget: true, wants: (st) => st.missingUser > 70 || st.loneliness > 65 },
  event_end: { minGapHours: 0, usesGlobalGap: false, minChatGapHours: 0, usesDailyBudget: false, wants: () => false },
};

/** 择优顺序（对应 tickProactive 里的 if-else 优先级） */
export const PROACTIVE_KIND_ORDER: ProactiveKind[] = [
  'stage_confirm',
  'event',
  'ritual',
  'relationship_talk',
  'miss',
  'memory',
  'greeting',
];

export const ALL_PROACTIVE_KINDS: ProactiveKind[] = [
  'greeting',
  'memory',
  'event',
  'relationship_talk',
  'stage_confirm',
  'ritual',
  'miss',
  'event_end',
];

/** 该类型当前是否满足自己的条件与最小间隔（纯逻辑） */
export function evaluateProactiveKind(kind: ProactiveKind, st: ProactiveState): KindEligibility {
  const rule = PROACTIVE_RULES[kind];
  if (!rule.wants(st)) return { eligible: false, reason: '不满足该类型的触发条件' };
  if (st.force) return { eligible: true, reason: '' };
  const waitGap = Math.max(rule.minGapHours, rule.usesGlobalGap ? st.baseMinGapHours : 0);
  if (st.hoursSinceLastProactive < waitGap) {
    return { eligible: false, reason: `距上次主动才 ${st.hoursSinceLastProactive.toFixed(1)} 小时（需 ${waitGap}）` };
  }
  // 当天有特殊日子时，各类的"聊天间隔"门槛统一放宽到 3 小时（与原 needHours 口径一致）
  const chatGap = st.eventToday ? Math.min(rule.minChatGapHours, 3) : rule.minChatGapHours;
  if (st.hoursSinceLastMessage < chatGap) {
    return { eligible: false, reason: `上次聊天才 ${st.hoursSinceLastMessage.toFixed(1)} 小时前（需 ${chatGap}）` };
  }
  if (rule.usesDailyBudget && st.todayCount >= st.perDay) {
    return { eligible: false, reason: `今天她已经主动 ${st.todayCount} 次了` };
  }
  return { eligible: true, reason: '' };
}

export interface ProactiveDecision {
  kind: ProactiveKind | null;
  reason: string;
  /** 每个类型的独立判定结果（便于测试逐条断言） */
  byKind: Record<ProactiveKind, KindEligibility>;
}

/** 综合全局约束（静默/开关/场景）与各类型独立条件，决定这一轮该发哪一种（纯逻辑） */
export function decideProactiveKind(st: ProactiveState): ProactiveDecision {
  const byKind = {} as Record<ProactiveKind, KindEligibility>;
  for (const k of ALL_PROACTIVE_KINDS) byKind[k] = { eligible: false, reason: '' };

  if (!st.force) {
    if (st.frequencyOff) return { kind: null, reason: '主动消息已关闭', byKind };
    if (st.dnd) return { kind: null, reason: '免打扰已开启', byKind };
    if (st.quiet) return { kind: null, reason: '现在是免打扰时段（夜间）', byKind };
    if (st.stage < 1) return { kind: null, reason: '关系还在初识期，她不会先开口', byKind };
    if (!st.hasLastInteraction) return { kind: null, reason: '你们还没聊过，等她先被搭话', byKind };
    if (st.busy) return { kind: null, reason: '她正忙着自己的事，先不打扰', byKind };
    if (st.offline && st.offlineRecent) return { kind: null, reason: '你们正在一起（线下相处），她不需要给你发消息', byKind };
    if (st.unanswered >= 2) return { kind: null, reason: '她已经主动过、你没回，她在等你先说话', byKind };
  }

  for (const k of PROACTIVE_KIND_ORDER) byKind[k] = evaluateProactiveKind(k, st);
  for (const k of PROACTIVE_KIND_ORDER) {
    if (byKind[k].eligible) return { kind: k, reason: '已发出主动消息', byKind };
  }
  return { kind: null, reason: '当前没有适合主动开口的时机', byKind };
}

/**
 * 纯函数（P1-44）：在候选记忆里挑出与"当下的事"（当前活动 / 今天经历 / 共享世界约定）最相关的。
 * 命中线索越多排越前；全不命中时保持原顺序（回退到现有选择）。
 */
export function pickWhyNowMemories<T extends { content: string }>(memories: T[], cues: string[], limit = 3): T[] {
  const cleaned = cues.map((c) => String(c || '').trim()).filter(Boolean);
  if (!cleaned.length) return memories.slice(0, limit);
  const grams = (s: string): Set<string> => {
    const set = new Set<string>();
    const t = s.replace(/\s+/g, '');
    for (let i = 0; i <= t.length - 2; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const cueGrams = cleaned.map(grams);
  const scored = memories.map((m, i) => {
    const mg = grams(String(m.content || ''));
    let hit = 0;
    for (const cg of cueGrams) {
      for (const g of cg) {
        if (mg.has(g)) {
          hit++;
          break;
        }
      }
    }
    return { m, hit, i };
  });
  scored.sort((a, b) => b.hit - a.hit || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.m);
}

export interface TickResult {
  sent: boolean;
  reason: string;
  kind?: ProactiveKind;
  message?: string;
}

/** 定时检查（由 instrumentation 每 5 分钟调用一次，也可手动触发） */
export async function tickProactive(force = false): Promise<TickResult> {
  const skip = (reason: string): TickResult => ({ sent: false, reason });
  // "现在"统一取一次，后续所有时段判断都基于它（便于测试与一致性）
  const now = new Date();

  const rel = getRelationshipState();
  const freq = getSetting('proactive_frequency') || 'medium';
  const limits = FREQ_LIMITS[freq] ?? FREQ_LIMITS.medium!;

  // 她的生活先推进到此刻（按流逝时间推导，幂等）
  ensureLife();
  advanceLife();
  advanceIntimacy();

  // 张力自然衰减：每天最多一次（很慢）
  try {
    const fadeKey = `tension_fade_${localDateStr(now)}`;
    if (getCounter(fadeKey) === 0) {
      setCounter(fadeKey, 1);
      fadeTension(-1);
    }
  } catch {
    /* 衰减失败不影响主流程 */
  }

  // 每日摘要（跨天/补漏；失败会自动重试）
  await maybeGenerateDailySummary().catch(() => null);

  // 事件到期：她自己来告诉你"睡醒了 / 洗完澡了 / 吃完了"。
  // 放在所有限流判断之前：这类到期提醒不算主动打扰，不受频率额度、免打扰与夜间时段限制。
  const expired = getExpiredEvent();
  if (expired) {
    const endMs = new Date(expired.expected_end_at || '').getTime();
    const lateMinutes = (Date.now() - endMs) / 60000;
    const lastAnyMsg = dbGet<{ created_at: string }>(
      'SELECT created_at FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 1',
      DEFAULT_USER_ID
    );
    const minsSinceMsg = lastAnyMsg ? (Date.now() - new Date(lastAnyMsg.created_at).getTime()) / 60000 : 99999;
    const notifyRetryAfter = getCounter('event_notify_retry_after');
    // 只有"他会在意"的事才值得一条结束提醒；看剧/游戏/家务/护肤这类日常不打扰（安静地结束掉）
    const REPORTABLE = new Set(['sleep', 'shower', 'meal', 'commute', 'focus']);
    if (lateMinutes > eventLateWindowMinutes(expired) || minsSinceMsg <= 3 || !REPORTABLE.has(expired.event_type)) {
      // 太久以前到期了 / 用户刚好在旁边 / 日常小事：静默结束，不补提醒
      settleExpiredEvent(expired, false);
    } else if (notifyRetryAfter <= Date.now()) {
      const sent = await notifyEventEnd(expired, false);
      if (sent) {
        settleExpiredEvent(expired, true);
        return { sent: true, reason: `「${expired.activity}」结束了，她来告诉你`, kind: 'event_end', message: sent };
      }
      // 生成失败（比如模型临时挂了）：不结束事件，10 分钟后再试
      setCounter('event_notify_retry_after', Date.now() + 10 * 60 * 1000);
      return skip('事件结束提醒生成失败，稍后重试');
    } else {
      return skip('事件结束提醒等待重试');
    }
  }

  const event = todayEvent(now);
  const lastMsg = dbGet<{ created_at: string; role: string }>(
    'SELECT created_at, role FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    DEFAULT_USER_ID
  );
  const hours = hoursSince(lastMsg?.created_at || rel.last_interaction_at);
  const dayKey = `proactive_count_${localDateStr(now)}`;
  const runningEvent = getActiveEvent();
  const BUSY_TYPES = new Set(['sleep', 'focus', 'shower', 'commute', 'out']);
  const act = getActivity();
  const psy = getPsychology();
  const offlineHours = rel.scene_updated_at ? hoursSince(rel.scene_updated_at) : 999;
  const lastProactiveAt = getCounter('last_proactive_ms');

  // 汇总为纯逻辑状态，交给 decideProactiveKind 判定（各类型独立条件与最小间隔）
  const state: ProactiveState = {
    now,
    force,
    stage: rel.stage,
    unresolvedTension: Number(rel.unresolved_tension),
    pendingStageConfirm: !!rel.pending_stage_confirm,
    pendingRelationshipTalk: !!rel.pending_relationship_talk,
    missingUser: Number(psy.missing_user),
    loneliness: Number(psy.loneliness),
    hasLastInteraction: !!rel.last_interaction_at,
    hoursSinceLastMessage: hours,
    hoursSinceLastProactive: lastProactiveAt > 0 ? (now.getTime() - lastProactiveAt) / 3600000 : Infinity,
    todayCount: getCounter(dayKey),
    perDay: limits.perDay,
    baseMinGapHours: limits.minGapHours,
    unanswered: unansweredProactiveCount(),
    frequencyOff: limits.perDay === 0,
    dnd: getSetting('dnd') === 'true',
    quiet: inQuietHours(now),
    offline: (rel.scene || 'online') === 'offline',
    offlineRecent: offlineHours < 12,
    // 她正处在"真的腾不出手"的事里（睡觉/上课/洗澡/通勤/在外面）；轻活动不阻止她想起你
    busy:
      (!!runningEvent && BUSY_TYPES.has(runningEvent.event_type)) ||
      (act.activity_type === 'sleep' && rel.stage < 3),
    ritualSlot: ritualSlotNow(now),
    eventToday: !!event,
    random: Math.random(),
  };

  const decision = decideProactiveKind(state);
  if (!decision.kind) return skip(decision.reason);
  const kind = decision.kind;

  // P1-44「为什么是现在」：她此刻在做的事 → 今天/最近经历 → 共享世界约定 → 联想到的记忆 → 情绪
  const todayEvents = listDailyEvents(5)
    .map((e) => String(e.content || '').trim())
    .filter(Boolean)
    .slice(0, 3);
  const world = getSharedWorld();
  const pickWorld = (arr?: { content?: string; title?: string }[]) =>
    (arr || [])
      .map((x) => String(x.content || x.title || '').trim())
      .filter(Boolean)
      .slice(0, 2);
  const sharedWorld = [...pickWorld(world.plans), ...pickWorld(world.rituals), ...pickWorld(world.items)].slice(0, 3);
  const cues = [act.current_activity, ...todayEvents, ...sharedWorld, event?.title || ''].filter(Boolean);

  // 检索记忆作为素材（多查询：主查询 + 当下线索）
  const baseQuery = kind === 'event' && event ? `${event.title} ${event.description || ''}` : cues.join(' ') || rel.mood || '日常';
  const memories = await retrieveMemories(baseQuery, { extraQueries: cues, topK: 6 });
  // 优先选与当下的事相关的记忆；无则回退现有选择顺序
  const ranked = pickWhyNowMemories(memories, cues, 4);
  const memoryBlock = formatMemoryBlock(ranked.length ? ranked : memories);

  const whyNow: ProactiveWhyNow = {
    activity: act.current_activity,
    ongoingEvent: runningEvent?.activity,
    todayEvents,
    sharedWorld,
    memory: ranked[0] ? truncate(String(ranked[0].content || ''), 60) : undefined,
    mood: rel.mood,
  };

  const messages = buildProactiveMessages({
    kind,
    hoursSinceLast: hours,
    memoryBlock,
    recentActions: recentActionPhrases(6),
    whyNow,
  });
  let content = '';
  try {
    content = await chat(messages, { maxTokens: 260, temperature: 0.95, thinking: false });
  } catch (e) {
    return skip(`生成失败：${errMsg(e)}`);
  }
  const raw = String(content || '').trim();
  // 主动消息同样过人味层：清洗 AI 腔、控制长度、缺动作就补一个
  const h = humanizeReply(raw, {
    userName: userName(),
    agentName: agentName(),
    stage: rel.stage,
    personality: personalityMap(),
    attachmentStyle: attachmentStyle(),
    mood: rel.mood,
    recentActions: recentActionPhrases(8),
    recentReplies: recentReplies(5),
    userMessage: '',
  });
  content = h.text;
  if (!content || content.length < 2) return skip('生成内容为空');

  const messageId = saveAssistantMessage(content, { isProactive: true });
  dbRun(
    `INSERT INTO proactive_messages (user_id, kind, content, message_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    DEFAULT_USER_ID,
    kind,
    content,
    messageId,
    nowIso()
  );
  bumpCounter(dayKey, 1);
  setCounter('last_proactive_ms', Date.now());

  // P1-45：她主动说出口的话（自述/计划/承诺/经历/未来打算）也要进长期分析，
  // 否则"我明天想去……"不会变成她自己的记忆。fire-and-forget，绝不阻塞消息发送。
  void analyzeProactiveMessage(messageId, content).catch((e) => {
    console.warn('[proactive] 主动消息分析失败:', errMsg(e));
  });

  return { sent: true, reason: '已发出主动消息', kind, message: content };
}

/** 事件结束后她主动来一条消息（不占主动消息额度、不受免打扰限制） */
export async function notifyEventEnd(evt: OngoingEventRow, interrupted = false): Promise<string | null> {
  const rel = getRelationshipState();
  let memoryBlock = '';
  try {
    const memories = await retrieveMemories(`${evt.activity} 结束 日常`, 4);
    memoryBlock = formatMemoryBlock(memories);
  } catch {
    /* 没有记忆也能发 */
  }
  const messages = buildProactiveMessages({
    kind: 'event_end',
    hoursSinceLast: 0,
    memoryBlock,
    recentActions: recentActionPhrases(6),
    eventActivity: evt.activity,
    eventInterrupted: interrupted,
    // 提醒生成时事件可能还没落定（到期路径先通知后结算）→ 忽略"她正在这件事当中"的注入，
    // 否则 system 里会同时出现"你正在睡觉不要宣布结束"和"你刚结束了睡觉，去告诉他"
    ignoreOngoingEvent: true,
  });
  let content = '';
  try {
    content = await chat(messages, { maxTokens: 240, temperature: 0.95, thinking: false });
  } catch (e) {
    console.warn('[event_end] 生成失败:', errMsg(e));
    return null;
  }
  const raw = String(content || '').trim();
  if (!raw) return null;
  const h = humanizeReply(raw, {
    userName: userName(),
    agentName: agentName(),
    stage: rel.stage,
    personality: personalityMap(),
    attachmentStyle: attachmentStyle(),
    mood: rel.mood,
    recentActions: recentActionPhrases(8),
    recentReplies: recentReplies(5),
    userMessage: '',
  });
  const text = h.text;
  if (!text || text.length < 2) return null;
  const messageId = saveAssistantMessage(text, { isProactive: true });
  dbRun(
    'INSERT INTO proactive_messages (user_id, kind, content, message_id, created_at) VALUES (?, ?, ?, ?, ?)',
    DEFAULT_USER_ID, 'event_end', text, messageId, nowIso()
  );
  // 注：结束与 notified_at 由调用方 settleExpiredEvent() 处理（提醒失败时不会误标）

  // P1-45：结束提醒同样属于她主动说出的话，进长期分析（fire-and-forget）
  void analyzeProactiveMessage(messageId, text).catch((e) => {
    console.warn('[proactive] 结束提醒分析失败:', errMsg(e));
  });
  return text;
}

/** 供设置页展示当前主动消息状态 */
export function proactiveStatus() {
  const freq = getSetting('proactive_frequency') || 'medium';
  const limits = FREQ_LIMITS[freq] ?? FREQ_LIMITS.medium!;
  const dayKey = `proactive_count_${localDateStr()}`;
  const rows = dbAll<{ kind: string; content: string; created_at: string }>(
    'SELECT kind, content, created_at FROM proactive_messages WHERE user_id = ? ORDER BY id DESC LIMIT 10',
    DEFAULT_USER_ID
  );
  const last = rows[0]?.created_at;
  return {
    frequency: freq,
    perDay: limits.perDay,
    todayCount: getCounter(dayKey),
    quietHours: `${getSetting('quiet_start')} - ${getSetting('quiet_end')}`,
    dnd: getSetting('dnd') === 'true',
    inQuietHours: inQuietHours(),
    unanswered: unansweredProactiveCount(),
    lastAt: last || null,
    minutesSinceLast: last ? Math.round(minutesSince(last)) : null,
    recent: rows,
  };
}

export function listProactive(limit = 20) {
  return dbAll<ProactiveMessageRow>(
    'SELECT * FROM proactive_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    DEFAULT_USER_ID,
    limit
  );
}