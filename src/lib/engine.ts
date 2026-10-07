// 聊天引擎：上下文组装 + 回复生成（流式）
import { dbRun, DEFAULT_USER_ID, bumpCounter, getCounter, numSetting, getSetting, cAll, cGet, cRun } from './db';
import { cId, ck } from './companion-context';
import { nowIso, truncateMiddle, hoursSince, errMsg } from './utils';
import { chat, chatStream, contentText, IMAGE_PLACEHOLDER, type ChatMessage, type MessageContentPart } from './llm';
import { buildReplyMessages, buildHints } from './prompts';
import { loadImageDataUrls, parseMetaImages } from './uploads';
import { retrieveMemories, formatMemoryBlock } from './memory';
import { touchInteraction, agentName, userName, getRelationshipState, saveRelationshipState } from './relationship';
import { personalityMap } from './personality';
import { attachmentStyle } from './attachment';
import { humanizeReply, type HumanizeContext } from './humanize';
import { detectScene, type Scene } from './scene';
import { renderContentForModel } from './stickers';
import { ensureLife, advanceLife, whatHappenedSince, getExpiredEvent, settleExpiredEvent } from './life';
import { detectCohabitants } from './presence';
import { createTurn, beginGeneration, completeGeneration, withConversationLock } from './turn';
import type { MessageRow } from './types';

export interface PreparedTurn {
  userMessageId: number | null;
  /** 本轮所属回合（一个用户消息 = 一个 turn） */
  turnId: number | null;
  /** 本轮的生成记录（重新生成 = 新 generation） */
  generationId: number | null;
  messages: ChatMessage[];
  memoryBlock: string;
  hints: string[];
  turnCount: number;
  /** 交给"人味层"的上下文（清洗/补动作/查重都要用） */
  humanize: HumanizeContext;
  /** 本轮的场景更新（prepare 只计算，commitTurn 才落库） */
  sceneUpdate: SceneUpdate;
}

export interface PrepareTurnOptions {
  /** 重新生成时置 false：不再重复保存用户消息，复用他已有的那一条 */
  insertUserMessage?: boolean;
  userMessageId?: number;
  /** 重新生成时由调用方（chat 路由）传入的既有 turn/generation */
  turnId?: number | null;
  generationId?: number | null;
  /**
   * 本轮用户消息附带的图片（已落盘的相对路径，如 uploads/xxx.jpg）。
   * 落进消息 meta.images，并在组装 Prompt 时以多模态 content parts 附在本轮用户消息上；
   * 重新生成时省略此参数，会自动从用户消息已存的 meta 里读回。
   */
  images?: string[];
}

/* ---------------------- 消息读写 ---------------------- */
export function insertMessage(
  role: 'user' | 'assistant' | 'system',
  content: string,
  opts: { isProactive?: boolean; emotion?: string; meta?: unknown } = {}
): number {
  const { lastInsertRowid } = cRun(
    `INSERT INTO messages (companion_id, user_id, role, content, emotion, is_proactive, read_at, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

/** 删除一条消息（生成失败时把刚落库的用户消息撤掉，避免留下"孤儿消息"） */
export function deleteMessageById(id: number): void {
  if (!Number.isFinite(id) || id <= 0) return;
  dbRun('DELETE FROM messages WHERE id = ? AND companion_id = ?', id, cId());
}

export function listMessages(opts: { afterId?: number; limit?: number } = {}): MessageRow[] {
  const { afterId, limit = 60 } = opts;
  if (afterId) {
    return cAll<MessageRow>(
      'SELECT * FROM messages WHERE companion_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
      afterId,
      limit
    );
  }
  return cAll<MessageRow>(
    'SELECT * FROM messages WHERE companion_id = ? ORDER BY id DESC LIMIT ?',
    limit
  ).reverse();
}

export function messageCount(): number {
  const r = cGet<{ c: number }>('SELECT COUNT(*) AS c FROM messages WHERE companion_id = ?');
  return Number(r?.c || 0);
}

/** 最后一条消息（重新生成时用来校验角色） */
export function getLastMessage(): MessageRow | null {
  return (
    cGet<MessageRow>('SELECT * FROM messages WHERE companion_id = ? ORDER BY id DESC LIMIT 1') || null
  );
}

/** 指定消息之前最近的一条用户消息（重新生成时作为内容，不重复保存） */
export function getLastUserMessageBefore(id: number): MessageRow | null {
  return (
    cGet<MessageRow>(
      "SELECT * FROM messages WHERE companion_id = ? AND role = 'user' AND id < ? ORDER BY id DESC LIMIT 1",
      id
    ) || null
  );
}

/** 删除引用了某条消息的主动消息记录（重新生成时清理它这条回复） */
export function deleteProactiveMessagesByMessageId(id: number): void {
  if (!Number.isFinite(id) || id <= 0) return;
  dbRun('DELETE FROM proactive_messages WHERE companion_id = ? AND message_id = ?', cId(), id);
}

export function markAssistantMessagesRead(): void {
  dbRun(
    "UPDATE messages SET read_at = ? WHERE companion_id = ? AND role = 'assistant' AND read_at IS NULL",
    nowIso(),
    cId()
  );
}

/**
 * 最近 N 轮对话 → LLM messages（工作记忆）。表情包会转换成她看得懂的描述。
 * 历史里"他发过图片"的消息**不再附原图**（避免上下文与体积爆炸），统一降级为一行文字占位；
 * 只有本轮用户消息会由 prepareTurn 真正附上图片（多模态 content parts）。
 */
export function recentMessagesForPrompt(limit?: number): ChatMessage[] {
  const n = limit ?? Math.max(4, numSetting('context_size', 20));
  // 先多取候选（limit*3，上限 120），过滤出 user/assistant 后再取最近 limit 条：
  // 主动消息 / 系统消息不再挤占额度，保证拿到的是真实对话轮。
  const candidateLimit = Math.min(120, Math.max(n * 3, n));
  const rows = cAll<MessageRow>(
    'SELECT role, content, is_proactive, meta, created_at FROM messages WHERE companion_id = ? ORDER BY id DESC LIMIT ?',
    candidateLimit
  );
  return rows
    .filter((r) => r.role === 'user' || r.role === 'assistant')
    .slice(0, n)
    .reverse()
    .map((r) => {
      // 长消息头尾保留（约 40% 头 + 60% 尾）：既见铺垫，也见结论
      const text = truncateMiddle(renderContentForModel(String(r.content || '')), 800);
      const hadImage = r.role === 'user' && parseMetaImages(r.meta).length > 0;
      return {
        role: r.role as 'user' | 'assistant',
        content: hadImage ? `${text} ${IMAGE_PLACEHOLDER}`.trim() : text,
      };
    });
}

/** 读取某条用户消息 meta 里记录的图片相对路径（重新生成时用它还原图片上下文） */
function readUserMessageImages(userMessageId: number | null | undefined): string[] {
  if (!userMessageId) return [];
  const row = cGet<{ meta: string | null }>(
    'SELECT meta FROM messages WHERE companion_id = ? AND id = ?',
    userMessageId
  );
  return parseMetaImages(row?.meta);
}

/**
 * 把图片以 OpenAI 多模态格式附在**最后一条用户消息**上（原消息为纯文本时升级为 content parts）。
 * - 无图片：原样返回（向后兼容，content 仍是字符串）
 * - 有图片但图已丢失（dataUrls 为空）：退化为纯文本（用 text，避免历史占位残留）
 * 纯函数，便于单测。
 */
export function withImagesOnLastUserMessage(
  messages: ChatMessage[],
  text: string,
  imageDataUrls: string[]
): ChatMessage[] {
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      idx = i;
      break;
    }
  }
  if (idx < 0) return messages;
  const out = messages.slice();
  const textPart = text && text.trim() ? text : IMAGE_PLACEHOLDER;
  if (!imageDataUrls.length) {
    out[idx] = { role: 'user', content: textPart };
    return out;
  }
  const parts: MessageContentPart[] = [
    { type: 'text', text: textPart },
    ...imageDataUrls.map((url): MessageContentPart => ({ type: 'image_url', image_url: { url } })),
  ];
  out[idx] = { role: 'user', content: parts };
  return out;
}

/** 从她最近说过的话里，抽出用过的括号动作，避免反复用同一批描写（最近的排在最前） */
export function recentActionPhrases(limit = 10): string[] {
  const rows = cAll<{ content: string }>(
    "SELECT content FROM messages WHERE companion_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 20"
  );
  const seen: string[] = [];
  for (const r of rows) {
    const text = String(r.content || '');
    const re = /[（(]([^）)]{2,80})[）)]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const a = m[1]!.trim();
      if (a && !seen.includes(a)) seen.push(a);
      if (seen.length >= limit) return seen;
    }
  }
  return seen;
}

/* ---------------------- 每轮准备 ---------------------- */
/**
 * 准备一轮：保存用户消息 → 建 turn/generation → 检索记忆 → 组装 Prompt。
 * 本函数只做"读取 + 计算 + 返回待提交动作"，**不写本轮产物**：
 *   - 不 bump turn_count、不 touchInteraction、不落库场景（这些在 commitTurn，assistant 成功落库后执行）；
 *   - 但保留"按时间幂等推进"的世界状态（ensureLife/advanceLife/过期事件 settle）——它们属于
 *     "到此刻为止的世界"，不是本轮的产物，重复执行也安全，所以仍放在 prepare。
 */
export async function prepareTurn(userText: string, opts: PrepareTurnOptions = {}): Promise<PreparedTurn> {
  const text = String(userText || '').trim();
  const insertUser = opts.insertUserMessage !== false;
  // 本轮图片：正常发送时来自调用方（已落盘的相对路径）；重新生成时从既有消息 meta 读回
  const images = insertUser ? opts.images ?? [] : readUserMessageImages(opts.userMessageId);
  // 重新生成时不再重复保存用户消息，直接复用他已存在的那一条
  const userMessageId = insertUser
    ? insertMessage('user', text, images.length ? { meta: { images } } : {})
    : opts.userMessageId ?? null;

  // 新用户消息 → 建 turn（sequence 递增）→ beginGeneration（generation_no 递增、置为当前）
  let turnId = opts.turnId ?? null;
  let generationId = opts.generationId ?? null;
  if (insertUser && userMessageId) {
    turnId = createTurn(userMessageId).id;
    generationId = beginGeneration(turnId).id;
  }

  // 只读当前计数：首次见面判定与 buildHints 都基于"已成功完成"的持久计数
  const turnCount = getCounter(ck('turn_count'));
  const gapHours = hoursSince(getRelationshipState().last_interaction_at);
  // 她的生活先推进到此刻（按流逝时间推导，幂等；不足 15 分钟会直接返回）
  try {
    ensureLife();
    advanceLife();
    // 事件已到期而用户先来消息：静默结束（她用"刚结束"的状态回复，这里就不再补一条提醒）
    const expired = getExpiredEvent();
    if (expired) settleExpiredEvent(expired, false);
  } catch (e) {
    console.warn('[life] advance failed:', errMsg(e));
  }

  // 场景：只计算不落库（落库在 commitTurn，含 TTL）
  const sceneUpdate = computeSceneUpdate(text);

  const recent = recentMessagesForPrompt();

  // 记忆检索：主查询=他此刻说的话；最近几条用户消息作为补充查询（多查询并行、按相似度 rerank）
  const extraQueries = recent
    .filter((m) => m.role === 'user')
    .slice(-3, -1)
    .map((m) => contentText(m.content))
    .filter((s) => s && s !== text)
    .slice(-2);
  const memoryRows = await retrieveMemories(text, { extraQueries });
  const memoryBlock = formatMemoryBlock(memoryRows);

  const hints = buildHints({ isFirstMeeting: isFirstMeeting(), userMessage: text });

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
  // v16 同场感知：此刻在场的「她身边的人」注入提示（只注入人名与角色，不注入任何记忆；
  // 伴侣型在场者不注入——她们的同场感知走共处群/共域记忆，不进私聊 prompt）。
  // detectCohabitants 是纯 SQL 读取，每轮调用一次即可，无需缓存。
  let copresence: string[] = [];
  try {
    copresence = detectCohabitants(cId())
      .filter((p) => p.kind === 'cast')
      .map((p) => `${p.role}${p.name}（就在旁边）`);
  } catch {
    copresence = []; // 在场检测失败不影响正常回复
  }
  const baseMessages = buildReplyMessages(recent, memoryBlock, hints, actions, copresence);
  // 本轮带图：把图片以多模态 content parts 附在最后一条用户消息上（历史图片已在 recent 里降级为占位）
  const messages = images.length
    ? withImagesOnLastUserMessage(baseMessages, text, loadImageDataUrls(images))
    : baseMessages;

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
    scene: sceneUpdate.scene,
  };

  return {
    userMessageId,
    turnId,
    generationId,
    messages,
    memoryBlock,
    hints,
    turnCount,
    humanize,
    sceneUpdate,
  };
}

/**
 * 提交本轮产物（assistant 消息成功落库后调用）：turn_count 计数、streak/last_interaction_at、场景落库（含 TTL）。
 * 生成失败则不调用 —— 避免出现"没有她回复的幽灵 turn"。
 */
export function commitTurn(prepared: PreparedTurn): void {
  bumpCounter(ck('turn_count'));
  touchInteraction();
  commitScene(prepared.sceneUpdate);
}

/** 首次见面判定：基于持久计数（重新生成不改变判定；清空聊天记录后不误判） */
export function isFirstMeeting(): boolean {
  return getCounter(ck('turn_count')) === 0;
}

/** 她最近说过的原话（用于查重，避免复读） */
export function recentReplies(limit = 6): string[] {
  return cAll<{ content: string }>(
    "SELECT content FROM messages WHERE companion_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT ?",
    limit
  ).map((r) => String(r.content || ''));
}

/* ---------------------- 场景（线上 / 线下） ---------------------- */
/** 场景默认存活 6 小时：作为"这次判定还算不算数"的 turnover 依据 */
const SCENE_TTL_MS = 6 * 60 * 60 * 1000;

export interface SceneUpdate {
  scene: Scene;
  mode: string;
  reason: string;
  confidence: number;
  /** 场景来源：manual=用户强制 / rule=规则识别 / none=未变化 */
  source: string;
  /** 过期时间（ISO）；null 表示不过期（用户强制指定时） */
  expiresAt: string | null;
  /** 是否与已落库状态不同、需要写库 */
  allowSwitch: boolean;
}

/** scene.ts 后续会扩展 temporal 字段（过去/现在/将来）；这里按可选字段兼容，缺字段不报错 */
interface SceneDetectionExt {
  scene: Scene;
  reason: string;
  confidence: number;
  temporal?: string | null;
}

/** 读取场景过期时间（readRelationshipState 不含该列，单独查一次） */
function readSceneExpiry(): string | null {
  const row = cGet<{ scene_expires_at: string | null }>(
    'SELECT scene_expires_at FROM relationship_state WHERE companion_id = ?'
  );
  return row?.scene_expires_at ?? null;
}

function isSceneExpired(expiresAt: string | null, now = Date.now()): boolean {
  return !!expiresAt && now > new Date(expiresAt).getTime();
}

/**
 * auto 模式下"当前生效的场景"：过期则该次判定作废，视为 online（不回写）。
 * online/offline 强制模式忽略 TTL。
 */
function effectiveAutoScene(
  rel: { scene?: string; scene_reason?: string | null },
  expiresAt: string | null
): { scene: Scene; reason: string } {
  if (isSceneExpired(expiresAt)) return { scene: 'online', reason: '' };
  return { scene: rel.scene === 'offline' ? 'offline' : 'online', reason: rel.scene_reason || '' };
}

/**
 * 只计算本轮场景（不落库）：prepare 阶段调用，真正写库在 commitScene。
 * 切换规则：scene_mode 为 online/offline 时强制指定、忽略 TTL；
 * auto 时仅当 temporal 为空或 'current' 且 confidence >= 0.5 才允许切换（过去/将来的提及不该切场景）。
 */
function computeSceneUpdate(userText: string): SceneUpdate {
  const rel = getRelationshipState();
  const mode = getSetting('scene_mode') || 'auto';

  if (mode === 'offline' || mode === 'online') {
    const persisted: Scene = rel.scene === 'offline' ? 'offline' : 'online';
    const scene: Scene = mode === 'offline' ? 'offline' : 'online';
    const reason = mode === 'offline' ? '你手动指定了线下' : '你手动指定了线上';
    return {
      scene,
      mode,
      reason,
      confidence: 1,
      source: 'manual',
      expiresAt: null, // 用户强制指定：TTL 不生效
      allowSwitch: scene !== persisted || reason !== (rel.scene_reason || ''),
    };
  }

  // auto：过期判定视为 online（不回写）
  const base = effectiveAutoScene(rel, readSceneExpiry());
  const d = detectScene(userText, base.scene) as SceneDetectionExt;
  const temporal = d.temporal ?? null;
  const temporalOk = temporal === null || temporal === 'current';
  let scene: Scene = base.scene;
  let reason = base.reason;
  let confidence = 0;
  let source = 'none';
  let expiresAt: string | null = null;
  let allowSwitch = false;

  if (temporalOk && d.confidence >= 0.5 && d.scene !== base.scene) {
    scene = d.scene;
    reason = d.reason || base.reason;
    confidence = d.confidence;
    source = 'rule';
    expiresAt = new Date(Date.now() + SCENE_TTL_MS).toISOString();
    allowSwitch = true;
  } else if (d.confidence >= 0.5 && d.reason && d.reason !== base.reason) {
    // 场景不变但理由更清晰：仅更新理由（同样带 TTL）
    reason = d.reason;
    confidence = d.confidence;
    source = 'rule';
    expiresAt = new Date(Date.now() + SCENE_TTL_MS).toISOString();
    allowSwitch = true;
  }
  return { scene, mode, reason, confidence, source, expiresAt, allowSwitch };
}

/** 落库场景（含 scene_confidence/scene_source/scene_expires_at）：仅在需要变化时写 */
export function commitScene(update: SceneUpdate): void {
  if (!update.allowSwitch) return;
  const rel = getRelationshipState();
  rel.scene = update.scene;
  rel.scene_reason = update.reason;
  rel.scene_updated_at = nowIso();
  saveRelationshipState(rel);
  // saveRelationshipState 不写 TTL 三列，这里单独补写
  dbRun(
    'UPDATE relationship_state SET scene_confidence = ?, scene_source = ?, scene_expires_at = ? WHERE companion_id = ?',
    update.confidence,
    update.source,
    update.expiresAt,
    cId()
  );
}

/**
 * 兼容旧接口：立即计算并落库场景（供非对话场景调用）。
 * 对话主链路请走 prepare 计算 + commitTurn 落库，不要在这里重复写入。
 */
export function updateSceneFromMessage(userText: string): { scene: Scene; mode: string; reason: string } {
  const update = computeSceneUpdate(userText);
  commitScene(update);
  return { scene: update.scene, mode: update.mode, reason: update.reason };
}

/**
 * 当前场景（供界面与主动消息判断使用）。
 * auto 模式下若 scene_expires_at 已过 → 视为 online（不回写）；online/offline 强制模式忽略 TTL。
 */
export function currentScene(): { scene: Scene; mode: string; reason: string } {
  const rel = getRelationshipState();
  const mode = getSetting('scene_mode') || 'auto';
  if (mode === 'offline') return { scene: 'offline', mode, reason: rel.scene_reason || '' };
  if (mode === 'online') return { scene: 'online', mode, reason: rel.scene_reason || '' };
  const eff = effectiveAutoScene(rel, readSceneExpiry());
  return { scene: eff.scene, mode, reason: eff.reason };
}

/** 直接生成一条回复（非流式，用于主动消息/测试）：同样经过"人味层" */
export async function generateReply(userText: string): Promise<string> {
  // T02 收尾 D2：会话锁按当前伴侣分键（cId()），不同伴侣可并行、同一伴侣串行，
  // 避免把所有伴侣的生成都排到主女友那把锁上。
  return withConversationLock(cId(), async () => {
    const prepared = await prepareTurn(userText);
    const raw = await chat(prepared.messages, { maxTokens: 900, temperature: 0.9, thinking: false });
    const h = humanizeReply(raw, prepared.humanize);
    const assistantMessageId = saveAssistantMessage(h.text);
    // 成功落库后才提交本轮产物，并收尾生成记录
    commitTurn(prepared);
    if (prepared.generationId) completeGeneration(prepared.generationId, assistantMessageId);
    return h.text;
  });
}

export { chatStream };