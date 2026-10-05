// 主动消息：定时任务检查是否该由她先开口（不骚扰、有节制、引用记忆、符合阶段）
import { dbAll, dbGet, dbRun, getSetting, getCounter, setCounter, bumpCounter, DEFAULT_USER_ID } from './db';
import { hoursSince, localDateStr, localHour, minutesSince, nowIso, errMsg } from './utils';
import { chat } from './llm';
import { buildProactiveMessages } from './prompts';
import { retrieveMemories, formatMemoryBlock } from './memory';
import { getRelationshipState, agentName, userName } from './relationship';
import { saveAssistantMessage, recentActionPhrases, recentReplies } from './engine';
import { personalityMap } from './personality';
import { attachmentStyle } from './attachment';
import { humanizeReply } from './humanize';
import { ensureLife, advanceLife, getActivity, getPsychology, getSharedWorld, getActiveEvent, getExpiredEvent, eventLateWindowMinutes, settleExpiredEvent, type OngoingEventRow } from './life';
import { advanceIntimacy } from './intimacy';
import { maybeGenerateDailySummary } from './analysis';
import { fadeTension } from './conflict';

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

/** 早安 / 晚安仪式：早 6-10 点、晚 21-23 点各最多一次 */
function ritualSlotNow(): 'morning' | 'night' | null {
  const hour = localHour();
  const slot: 'morning' | 'night' | null = hour >= 6 && hour < 10 ? 'morning' : hour >= 21 && hour < 23 ? 'night' : null;
  if (!slot) return null;
  const w = getSharedWorld();
  const hasRitual = (w.rituals || []).some((r: { content?: string; title?: string }) =>
    /早安|晚安|早上|睡前/.test(String(r.content || r.title || ''))
  );
  if (!hasRitual) return null;
  const today = localDateStr();
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

function inQuietHours(): boolean {
  const start = parseHm(getSetting('quiet_start') || '23:00');
  const end = parseHm(getSetting('quiet_end') || '08:00');
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

function todayEvent(): EventRow | null {
  const today = localDateStr();
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

export interface TickResult {
  sent: boolean;
  reason: string;
  kind?: ProactiveKind;
  message?: string;
}

/** 定时检查（由 instrumentation 每 5 分钟调用一次，也可手动触发） */
export async function tickProactive(force = false): Promise<TickResult> {
  const skip = (reason: string): TickResult => ({ sent: false, reason });

  const rel = getRelationshipState();
  const freq = getSetting('proactive_frequency') || 'medium';
  const limits = FREQ_LIMITS[freq] ?? FREQ_LIMITS.medium!;

  // 她的生活先推进到此刻（按流逝时间推导，幂等）
  ensureLife();
  advanceLife();
  advanceIntimacy();

  // 张力自然衰减：每天最多一次（很慢）
  try {
    const fadeKey = `tension_fade_${localDateStr()}`;
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

  if (!force) {
    if (limits.perDay === 0) return skip('主动消息已关闭');
    if (getSetting('dnd') === 'true') return skip('免打扰已开启');
    if (inQuietHours()) return skip('现在是免打扰时段（夜间）');
    if (rel.stage < 1) return skip('关系还在初识期，她不会先开口');
  }

  const lastMsg = dbGet<{ created_at: string; role: string }>(
    'SELECT created_at, role FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    DEFAULT_USER_ID
  );
  const hours = hoursSince(lastMsg?.created_at || rel.last_interaction_at);

  // 她正处在"真的腾不出手"的事里（睡觉/上课/洗澡/通勤/在外面）：期间不另外主动发消息。
  // 轻活动（看剧/游戏/家务/散步…）不阻止她想起你。
  const runningEvent = getActiveEvent();
  const BUSY_TYPES = new Set(['sleep', 'focus', 'shower', 'commute', 'out']);
  if (!force && runningEvent && BUSY_TYPES.has(runningEvent.event_type)) {
    return skip(`她正在${runningEvent.activity}，先不打扰`);
  }

  const act = getActivity();
  const psy = getPsychology();
  if (!force && act.activity_type === 'sleep' && rel.stage < 3) {
    return skip(`她正在${act.current_activity}`);
  }

  // 你们正在线下相处（人在旁边），她不会给你发消息（按"进入线下场景的时间"算，而不是距上条消息多久）
  const offlineHours = rel.scene_updated_at ? hoursSince(rel.scene_updated_at) : 999;
  if (!force && (rel.scene || 'online') === 'offline' && offlineHours < 12) {
    return skip('你们正在一起（线下相处），她不需要给你发消息');
  }

  const event = todayEvent();
  const needHours = event ? 3 : 6;
  // 从来没聊过：她不会先开口（这个判断要放在 needHours 之前，原来藏在死分支里永远走不到）
  if (!force && !rel.last_interaction_at) {
    return skip('你们还没聊过，等她先被搭话');
  }
  if (!force && hours < needHours) {
    return skip(`上次聊天才 ${Math.round(hours)} 小时前，不用急着找`);
  }

  // 频率控制
  // 早安/晚安仪式不受 perDay 与 minGap 限制（否则晚间仪式常被白天消息吞掉），但仍受上面的免打扰/夜间时段约束
  const ritualSlot = ritualSlotNow();
  const willBeRitual = !force && !!ritualSlot && !rel.pending_stage_confirm && !event;
  const dayKey = `proactive_count_${localDateStr()}`;
  const todayCount = getCounter(dayKey);
  if (!force && !willBeRitual && todayCount >= limits.perDay) return skip(`今天她已经主动 ${todayCount} 次了，不再打扰`);

  const lastProactiveAt = getCounter('last_proactive_ms');
  if (!force && !willBeRitual && lastProactiveAt > 0 && (Date.now() - lastProactiveAt) / 3600000 < limits.minGapHours) {
    return skip('距上次主动消息间隔太短');
  }

  const unanswered = unansweredProactiveCount();
  if (!force && unanswered >= 2) return skip('她已经主动过、你没回，她在等你先说话');

  // 决定消息类型（特殊日子优先于早安/晚安：仪式不该把当天的事件挤掉）
  let kind: ProactiveKind = 'greeting';
  if (rel.pending_stage_confirm) kind = 'stage_confirm';
  else if (event) kind = 'event';
  else if (!force && ritualSlot) kind = 'ritual';
  else if (rel.pending_relationship_talk || rel.unresolved_tension > 50) kind = 'relationship_talk';
  else if (psy.missing_user > 70 || psy.loneliness > 65) kind = 'miss';
  else if (Math.random() < 0.45) kind = 'memory';

  // 检索记忆作为素材
  const memories = await retrieveMemories(
    kind === 'event' && event ? `${event.title} ${event.description || ''}` : rel.mood || '日常',
    6
  );
  const memoryBlock = formatMemoryBlock(memories);

  const messages = buildProactiveMessages({
    kind,
    hoursSinceLast: hours,
    memoryBlock,
    recentActions: recentActionPhrases(6),
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