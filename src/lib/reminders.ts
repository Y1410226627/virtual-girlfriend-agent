// 提醒：她答应的"到点提醒你"——解析 → 落库 → 到点由调度器生成她的口吻消息
// 设计参考 AstrBot 的 cron（定时任务落库、启动后同步）+ agent 工具意图：不引入工具循环，
// 用确定性的本地解析识别「提醒我…」，把结果交给我们已有的调度器执行。
import { cAll, cRun, dbAll } from './db';
import { cId } from './companion-context';
import { errMsg, nowIso } from './utils';
import { chat } from './llm';
import { buildProactiveMessages } from './prompts';
import { retrieveMemories, formatMemoryBlock } from './memory';
import { getRelationshipState, agentName, userName } from './relationship';
import { saveAssistantMessage, recentActionPhrases, recentReplies } from './engine';
import { personalityMap } from './personality';
import { attachmentStyle } from './attachment';
import { humanizeReply } from './humanize';
import { analyzeProactiveMessage } from './proactive-analysis';
import { formatDueLabel, parseReminder } from './reminder-parse';

export interface ReminderRow {
  id: number;
  content: string;
  due_at: string;
  status: string;
  created_at: string;
  sent_at: string | null;
  message_id: number | null;
}

/** 设置页展示：待提醒（按时间升序）+ 最近已提醒 */
export function listReminders(limit = 50): ReminderRow[] {
  const pending = cAll<ReminderRow>(
    `SELECT id, content, due_at, status, created_at, sent_at, message_id FROM reminders
     WHERE companion_id = ? AND status = 'pending' ORDER BY due_at ASC LIMIT ?`,
    limit
  );
  const sent = cAll<ReminderRow>(
    `SELECT id, content, due_at, status, created_at, sent_at, message_id FROM reminders
     WHERE companion_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT ?`,
    20
  );
  return [...pending, ...sent];
}

/** 到点未发（调度器每轮取前 3 条；单条失败留到下轮重试） */
export function listDueReminders(now: string = nowIso(), limit = 3): ReminderRow[] {
  return dbAll<ReminderRow>(
    `SELECT id, content, due_at, status, created_at, sent_at, message_id FROM reminders
     WHERE companion_id = ? AND status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT ?`,
    cId(),
    now,
    limit
  );
}

/**
 * 从用户消息创建提醒（幂等：同一条消息重复提交/重新生成不会重复创建）。
 * 返回新提醒 id；不是提醒意图/已存在 → null。
 */
export function createReminderFromMessage(
  userMessageId: number | null | undefined,
  text: string,
  now: Date = new Date()
): number | null {
  if (!userMessageId) return null;
  const parsed = parseReminder(text, now);
  if (!parsed) return null;
  const res = cRun(
    `INSERT OR IGNORE INTO reminders (companion_id, content, due_at, status, source_message_id, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
    parsed.content,
    parsed.due.toISOString(),
    userMessageId,
    nowIso()
  );
  return res.changes ? Number(res.lastInsertRowid) : null;
}

/** 取消一条待提醒；返回 false=不存在/已发送/已取消（避免前端谎报成功） */
export function cancelReminder(id: number): boolean {
  const res = cRun(
    "UPDATE reminders SET status = 'cancelled' WHERE companion_id = ? AND id = ? AND status = 'pending'",
    id
  );
  return res.changes > 0;
}

/** 到点的提醒：用她平时的语气生成一条消息并落库（失败不标记，下轮重试） */
export async function tickReminders(): Promise<number> {
  const due = listDueReminders();
  let sent = 0;
  for (const r of due) {
    try {
      const text = await composeReminderMessage(r.content, r.due_at);
      if (!text) continue;
      const messageId = saveAssistantMessage(text, { isProactive: true });
      const upd = cRun(
        "UPDATE reminders SET status = 'sent', sent_at = ?, message_id = ? WHERE companion_id = ? AND id = ? AND status = 'pending'",
        nowIso(),
        messageId,
        r.id
      );
      if (!upd.changes) continue; // 并发下已被别的实例发掉
      void analyzeProactiveMessage(messageId, text).catch((e) => {
        console.warn('[reminders] 分析失败:', errMsg(e));
      });
      sent++;
    } catch (e) {
      // 单条失败不影响其它提醒；保持 pending，下个 tick 重试
      console.warn('[reminders] 发送失败，稍后重试:', errMsg(e));
    }
  }
  return sent;
}

async function composeReminderMessage(content: string, dueAt: string): Promise<string> {
  const rel = getRelationshipState();
  let memoryBlock = '';
  try {
    const memories = await retrieveMemories(`${content} 提醒 说好的事`, 3);
    memoryBlock = formatMemoryBlock(memories);
  } catch {
    /* 没有相关记忆也能提醒 */
  }
  const messages = buildProactiveMessages({
    kind: 'reminder',
    hoursSinceLast: 0,
    memoryBlock,
    recentActions: recentActionPhrases(6),
    reminderContent: content,
    reminderDueText: formatDueLabel(new Date(dueAt)),
    ignoreOngoingEvent: true,
  });
  let raw = '';
  try {
    raw = await chat(messages, { maxTokens: 220, temperature: 0.95, thinking: false });
  } catch (e) {
    console.warn('[reminders] 生成失败:', errMsg(e));
    return '';
  }
  const body = String(raw || '').trim();
  if (!body) return '';
  const h = humanizeReply(body, {
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
  return String(h.text || '').trim();
}
