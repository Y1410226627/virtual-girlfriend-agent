// 主动消息：定时任务检查是否该由她先开口（不骚扰、有节制、引用记忆、符合阶段）
import { dbAll, dbGet, dbRun, getSetting, numSetting, getCounter, setCounter, bumpCounter, DEFAULT_USER_ID } from './db';
import { hoursSince, localDateStr, localHour, minutesSince, truncate, nowIso } from './utils';
import { chat } from './llm';
import { buildProactiveMessages } from './prompts';
import { retrieveMemories, formatMemoryBlock } from './memory';
import { getRelationshipState, agentName, userName } from './relationship';
import { saveAssistantMessage, recentActionPhrases, recentReplies } from './engine';
import { personalityMap } from './personality';
import { attachmentStyle } from './attachment';
import { humanizeReply } from './humanize';
import { ensureLife, advanceLife, getActivity, getPsychology, getSharedWorld, getActiveEvent, settleExpiredEvents, type OngoingEventRow } from './life';
import { advanceIntimacy } from './intimacy';
import { maybeGenerateDailySummary } from './analysis';

export type ProactiveKind = 'greeting' | 'memory' | 'event' | 'relationship_talk' | 'stage_confirm' | 'ritual' | 'miss' | 'event_end';

/** 早安 / 晚安仪式：早 6-10 点、晚 21-23 点各最多一次 */
function ritualSlotNow(): 'morning' | 'night' | null {
  const hour = localHour();
  const slot: 'morning' | 'night' | null = hour >= 6 && hour < 10 ? 'morning' : hour >= 21 && hour < 23 ? 'night' : null;
  if (!slot) return null;
  const w = getSharedWorld();
  const hasRitual = (w.rituals || []).some((r: any) => /早安|晚安|早上|睡前/.test(String(r.content || r.title || '')));
  if (!hasRitual) return null;
  const today = localDateStr();
  const sent = dbAll<any>(
    "SELECT created_at FROM proactive_messages WHERE user_id = ? AND kind = 'ritual' AND substr(created_at,1,10) = ?",
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
  return h * 60 + m;
}

function inQuietHours(): boolean {
  const start = parseHm(getSetting('quiet_start') || '23:00');
  const end = parseHm(getSetting('quiet_end') || '08:00');
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

function todayEvent(): any | null {
  const today = localDateStr();
  const md = today.slice(5); // MM-DD
  const rows = dbAll<any>(
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

/** 最后一次用户消息之后是否有她的主动消息没被回应 */
function unansweredProactiveCount(): number {
  const lastProactive = dbGet<any>(
    'SELECT id FROM messages WHERE user_id = ? AND is_proactive = 1 ORDER BY id DESC LIMIT 1',
    DEFAULT_USER_ID
  );
  if (!lastProactive) return 0;
  const after = dbGet<{ c: number }>(
    "SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND id > ? AND role = 'user'",
    DEFAULT_USER_ID,
    lastProactive.id
  );
  if (Number(after?.c || 0) > 0) return 0;
  // 连续未回应的主动消息数
  const recentProactive = dbAll<any>(
    'SELECT id FROM messages WHERE user_id = ? AND is_proactive = 1 ORDER BY id DESC LIMIT 3',
    DEFAULT_USER_ID
  );
  let count = 0;
  for (const p of recentProactive) {
    const replied = dbGet<{ c: number }>(
      "SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND id > ? AND role = 'user'",
      DEFAULT_USER_ID,
      p.id
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
  const limits = FREQ_LIMITS[freq] || FREQ_LIMITS.medium;

  // 每日摘要
  await maybeGenerateDailySummary().catch(() => null);

  if (!force) {
    if (limits.perDay === 0) return skip('主动消息已关闭');
    if (getSetting('dnd') === 'true') return skip('免打扰已开启');
    if (inQuietHours()) return skip('现在是免打扰时段（夜间）');
    if (rel.stage < 1) return skip('关系还在初识期，她不会先开口');
  }

  const lastMsg = dbGet<any>(
    'SELECT created_at, role FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    DEFAULT_USER_ID
  );
  const hours = hoursSince(lastMsg?.created_at || rel.last_interaction_at);

  // 她的生活状态：睡觉时不发消息（关系很深时也只在必要时）
  ensureLife();
  advanceLife();
  advanceIntimacy();

  // 事件到期：她自己来告诉你"睡醒了 / 洗完澡了 / 吃完了"。
  // 这类到期提醒不算主动打扰：不占频率额度、不受免打扰与夜间时段限制。
  const expiredEvents = settleExpiredEvents();
  if (expiredEvents.length) {
    const lastAny = dbGet<any>(
      'SELECT created_at FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 1',
      DEFAULT_USER_ID
    );
    const minsSinceMsg = lastAny ? (Date.now() - new Date(lastAny.created_at).getTime()) / 60000 : 99999;
    if (minsSinceMsg > 3) {
      const sent = await notifyEventEnd(expiredEvents[0], false);
      if (sent) {
        return { sent: true, reason: `「${expiredEvents[0].activity}」结束了，她来告诉你`, kind: 'event_end', message: sent };
      }
    }
  }

  // 她正处在某件事里（睡觉/洗澡/上课/出门…）：期间她不会另外主动发消息
  const runningEvent = getActiveEvent();
  if (!force && runningEvent) return skip(`她正在${runningEvent.activity}，先不打扰`);

  const act = getActivity();
  const psy = getPsychology();
  if (!force && act.activity_type === 'sleep' && rel.stage < 3) {
    return skip(`她正在${act.current_activity}`);
  }

  // 你们正在线下相处（人在旁边），她不会给你发消息
  if (!force && (rel.scene || 'online') === 'offline' && hours < 12) {
    return skip('你们正在一起（线下相处），她不需要给你发消息');
  }

  const event = todayEvent();
  const needHours = event ? 3 : 6;
  if (!force && hours < needHours) {
    return skip(hours > 900 ? '你们还没聊过，等她先被搭话' : `上次聊天才 ${Math.round(hours)} 小时前，不用急着找`);
  }

  // 频率控制
  const dayKey = `proactive_count_${localDateStr()}`;
  const todayCount = getCounter(dayKey);
  if (!force && todayCount >= limits.perDay) return skip(`今天她已经主动 ${todayCount} 次了，不再打扰`);

  const lastProactiveAt = getCounter('last_proactive_ms');
  if (!force && lastProactiveAt > 0 && (Date.now() - lastProactiveAt) / 3600000 < limits.minGapHours) {
    return skip('距上次主动消息间隔太短');
  }

  const unanswered = unansweredProactiveCount();
  if (!force && unanswered >= 2) return skip('她已经主动过、你没回，她在等你先说话');

  // 决定消息类型
  let kind: ProactiveKind = 'greeting';
  const ritualSlot = ritualSlotNow();
  if (rel.pending_stage_confirm) kind = 'stage_confirm';
  else if (!force && ritualSlot) kind = 'ritual';
  else if (rel.pending_relationship_talk || rel.unresolved_tension > 50) kind = 'relationship_talk';
  else if (event) kind = 'event';
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
  } catch (e: any) {
    return skip(`生成失败：${e?.message || e}`);
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
  });
  let content = '';
  try {
    content = await chat(messages, { maxTokens: 240, temperature: 0.95, thinking: false });
  } catch (e: any) {
    console.warn('[event_end] 生成失败:', e?.message || e);
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
  dbRun('UPDATE ongoing_events SET notified_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), evt.id);
  return text;
}

/** 供设置页展示当前主动消息状态 */
export function proactiveStatus() {
  const freq = getSetting('proactive_frequency') || 'medium';
  const limits = FREQ_LIMITS[freq] || FREQ_LIMITS.medium;
  const dayKey = `proactive_count_${localDateStr()}`;
  const rows = dbAll<any>(
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
  return dbAll<any>(
    'SELECT * FROM proactive_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    DEFAULT_USER_ID,
    limit
  );
}