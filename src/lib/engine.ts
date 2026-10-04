// 聊天引擎：上下文组装 + 回复生成（流式）
import { dbAll, dbGet, dbRun, DEFAULT_USER_ID, bumpCounter, getCounter, numSetting, getSetting } from './db';
import { nowIso, localDateStr, truncate, humanTime, hoursSince } from './utils';
import { chat, chatStream, type ChatMessage } from './llm';
import { buildReplyMessages, buildHints } from './prompts';
import { retrieveMemories, formatMemoryBlock } from './memory';
import { touchInteraction, agentName, userName, getRelationshipState, saveRelationshipState } from './relationship';
import { personalityMap } from './personality';
import { attachmentStyle } from './attachment';
import { humanizeReply, type HumanizeContext } from './humanize';
import { detectScene, type Scene } from './scene';
import { renderContentForModel } from './stickers';
import { ensureLife, advanceLife, whatHappenedSince, settleExpiredEvents } from './life';
import type { MessageRow } from './types';

export interface PreparedTurn {
  userMessageId: number | null;
  messages: ChatMessage[];
  memoryBlock: string;
  hints: string[];
  turnCount: number;
  /** 交给"人味层"的上下文（清洗/补动作/查重都要用） */
  humanize: HumanizeContext;
}

/* ---------------------- 消息读写 ---------------------- */
export function insertMessage(
  role: 'user' | 'assistant' | 'system',
  content: string,
  opts: { isProactive?: boolean; emotion?: string; meta?: any } = {}
): number {
  const { lastInsertRowid } = dbRun(
    `INSERT INTO messages (user_id, role, content, emotion, is_proactive, read_at, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    DEFAULT_USER_ID,
    role,
    content,
    opts.emotion || null,
    opts.isProactive ? 1 : 0,
    role === 'assistant' ? null : nowIso(),
    opts.meta ? JSON.stringify(opts.meta) : null,
    nowIso()
  );
  return lastInsertRowid;
}

export function saveAssistantMessage(content: string, opts: { isProactive?: boolean; emotion?: string } = {}): number {
  return insertMessage('assistant', content.trim(), opts);
}

export function listMessages(opts: { afterId?: number; limit?: number } = {}): MessageRow[] {
  const { afterId, limit = 60 } = opts;
  if (afterId) {
    return dbAll<MessageRow>(
      'SELECT * FROM messages WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
      DEFAULT_USER_ID,
      afterId,
      limit
    );
  }
  return dbAll<MessageRow>(
    'SELECT * FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    DEFAULT_USER_ID,
    limit
  ).reverse();
}

export function messageCount(): number {
  const r = dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM messages WHERE user_id = ?', DEFAULT_USER_ID);
  return Number(r?.c || 0);
}

export function markAssistantMessagesRead(): void {
  dbRun(
    "UPDATE messages SET read_at = ? WHERE user_id = ? AND role = 'assistant' AND read_at IS NULL",
    nowIso(),
    DEFAULT_USER_ID
  );
}

/** 最近 N 轮对话 → LLM messages（工作记忆）。表情包会转换成她看得懂的描述 */
export function recentMessagesForPrompt(limit?: number): ChatMessage[] {
  const n = limit ?? Math.max(4, numSetting('context_size', 20));
  const rows = dbAll<MessageRow>(
    'SELECT role, content, is_proactive, created_at FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    DEFAULT_USER_ID,
    n
  ).reverse();
  return rows
    .filter((r) => r.role === 'user' || r.role === 'assistant')
    .map((r) => ({
      role: r.role as 'user' | 'assistant',
      content: truncate(renderContentForModel(String(r.content || '')), 800),
    }));
}

/** 从她最近说过的话里，抽出用过的括号动作，避免反复用同一批描写（最近的排在最前） */
export function recentActionPhrases(limit = 10): string[] {
  const rows = dbAll<{ content: string }>(
    "SELECT content FROM messages WHERE user_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 20",
    DEFAULT_USER_ID
  );
  const seen: string[] = [];
  for (const r of rows) {
    const text = String(r.content || '');
    const re = /[（(]([^）)]{2,80})[）)]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const a = m[1].trim();
      if (a && !seen.includes(a)) seen.push(a);
      if (seen.length >= limit) return seen;
    }
  }
  return seen;
}

/* ---------------------- 每轮准备 ---------------------- */
/** 保存用户消息 → 检索记忆 → 组装 Prompt */
export async function prepareTurn(userText: string): Promise<PreparedTurn> {
  const text = String(userText || '').trim();
  const userMessageId = insertMessage('user', text);
  const turnCount = bumpCounter('turn_count');
  const gapHours = hoursSince(getRelationshipState().last_interaction_at);
  // 她的生活先推进到此刻（按流逝时间推导，幂等；不足 15 分钟会直接返回）
  try {
    ensureLife();
    advanceLife();
    // 事件已到期而用户先来消息：静默结束（她用"刚结束"的状态回复，这里就不再补一条提醒）
    settleExpiredEvents();
  } catch (e: any) {
    console.warn('[life] advance failed:', e?.message || e);
  }
  touchInteraction();

  // 场景：先按规则识别（零延迟），后台分析会用 LLM 再校正
  updateSceneFromMessage(text);

  const recent = recentMessagesForPrompt();

  // 检索 query = 最近 3 条用户消息
  const query = recent
    .filter((m) => m.role === 'user')
    .slice(-3)
    .map((m) => m.content)
    .join(' ') || text;

  const memoryRows = await retrieveMemories(query);
  const memoryBlock = formatMemoryBlock(memoryRows);

  const isFirstMeeting = messageCount() <= 2;
  const hints = buildHints({ isFirstMeeting });

  // 隔了一段时间没聊：把她"这段时间在做的事"作为素材，让她自然分享
  if (gapHours >= 3) {
    const happened = whatHappenedSince(Math.min(48, gapHours));
    if (happened.length) {
      hints.push(
        `【你刚经历的事（可以自然提一句，但不要全部说出来，最多挑一件顺口的）】${happened.join('；')}`
      );
    }
  }

  const actions = recentActionPhrases(10);
  const messages = buildReplyMessages(recent, memoryBlock, hints, actions);

  const rel = getRelationshipState();
  const humanize: HumanizeContext = {
    userName: userName(),
    agentName: agentName(),
    stage: rel.stage,
    personality: personalityMap(),
    attachmentStyle: attachmentStyle(),
    mood: rel.mood,
    recentActions: actions,
    recentReplies: recentReplies(6),
    userMessage: text,
    scene: currentScene().scene,
  };

  return { userMessageId, messages, memoryBlock, hints, turnCount, humanize };
}

/** 她最近说过的原话（用于查重，避免复读） */
export function recentReplies(limit = 6): string[] {
  return dbAll<{ content: string }>(
    "SELECT content FROM messages WHERE user_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT ?",
    DEFAULT_USER_ID,
    limit
  ).map((r) => String(r.content || ''));
}

/* ---------------------- 场景（线上 / 线下） ---------------------- */
/**
 * scene_mode = auto → 规则识别（+ 后台 LLM 校正）
 * scene_mode = online / offline → 用户强制指定
 */
export function updateSceneFromMessage(userText: string): { scene: Scene; mode: string; reason: string } {
  const rel = getRelationshipState();
  const mode = getSetting('scene_mode') || 'auto';
  let scene: Scene = rel.scene === 'offline' ? 'offline' : 'online';
  let reason = rel.scene_reason || '';

  if (mode === 'offline') {
    scene = 'offline';
    reason = '你手动指定了线下';
  } else if (mode === 'online') {
    scene = 'online';
    reason = '你手动指定了线上';
  } else {
    const d = detectScene(userText, scene);
    if (d.confidence > 0 && d.scene !== scene) {
      scene = d.scene;
      reason = d.reason;
    } else if (d.confidence >= 0.5 && d.reason) {
      reason = d.reason;
    }
  }

  if (scene !== (rel.scene || 'online') || reason !== (rel.scene_reason || '')) {
    rel.scene = scene;
    rel.scene_reason = reason;
    rel.scene_updated_at = nowIso();
    saveRelationshipState(rel);
  }
  return { scene, mode, reason };
}

/** 当前场景（供界面与主动消息判断使用） */
export function currentScene(): { scene: Scene; mode: string; reason: string } {
  const rel = getRelationshipState();
  const mode = getSetting('scene_mode') || 'auto';
  const scene: Scene = mode === 'offline' ? 'offline' : mode === 'online' ? 'online' : rel.scene === 'offline' ? 'offline' : 'online';
  return { scene, mode, reason: rel.scene_reason || '' };
}

/** 直接生成一条回复（非流式，用于主动消息/测试）：同样经过"人味层" */
export async function generateReply(userText: string): Promise<string> {
  const prepared = await prepareTurn(userText);
  const raw = await chat(prepared.messages, { maxTokens: 900, temperature: 0.9, thinking: false });
  const h = humanizeReply(raw, prepared.humanize);
  saveAssistantMessage(h.text);
  return h.text;
}

export { chatStream };