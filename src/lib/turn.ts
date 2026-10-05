// 回合 / 生成账本 + 服务端会话串行锁
//
// 事实源：conversation_turns（一个用户消息 = 一个 turn）与 message_generations（重新生成 = 新 generation）。
// 目标：把"同一轮对话到底发生了什么、属于哪次生成"变成可查询的事实；
// 并保证同一会话的请求在服务端串行执行（不是拒绝，而是排队依次执行）。
import { dbGet, dbRun, DEFAULT_USER_ID, tx } from './db';
import { nowIso } from './utils';

/* ------------------------------------------------------------------ */
/* 账本行                                                                */
/* ------------------------------------------------------------------ */
export interface TurnRow {
  id: number;
  user_id: number;
  sequence: number;
  user_message_id: number | null;
  current_generation_id: number | null;
  status: string;
  created_at: string;
  completed_at: string | null;
}

export interface GenerationRow {
  id: number;
  user_id: number;
  turn_id: number;
  generation_no: number;
  assistant_message_id: number | null;
  status: string;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* 查询                                                                  */
/* ------------------------------------------------------------------ */
export function getTurnById(id: number): TurnRow | null {
  if (!Number.isFinite(id) || id <= 0) return null;
  return dbGet<TurnRow>('SELECT * FROM conversation_turns WHERE user_id = ? AND id = ?', DEFAULT_USER_ID, id) ?? null;
}

export function getTurnByUserMessageId(userMessageId: number): TurnRow | null {
  if (!Number.isFinite(userMessageId) || userMessageId <= 0) return null;
  return (
    dbGet<TurnRow>(
      'SELECT * FROM conversation_turns WHERE user_id = ? AND user_message_id = ? ORDER BY id DESC LIMIT 1',
      DEFAULT_USER_ID,
      userMessageId
    ) ?? null
  );
}

export function getGenerationById(id: number): GenerationRow | null {
  if (!Number.isFinite(id) || id <= 0) return null;
  return (
    dbGet<GenerationRow>('SELECT * FROM message_generations WHERE user_id = ? AND id = ?', DEFAULT_USER_ID, id) ?? null
  );
}

/** 产出某条 assistant 消息的那次生成（重新生成时用来精确定位要取代的旧生成） */
export function generationByAssistantMessageId(assistantMessageId: number): GenerationRow | null {
  if (!Number.isFinite(assistantMessageId) || assistantMessageId <= 0) return null;
  return (
    dbGet<GenerationRow>(
      'SELECT * FROM message_generations WHERE user_id = ? AND assistant_message_id = ? ORDER BY id DESC LIMIT 1',
      DEFAULT_USER_ID,
      assistantMessageId
    ) ?? null
  );
}

export function currentGenerationForTurn(turnId: number): GenerationRow | null {
  const turn = getTurnById(turnId);
  if (!turn?.current_generation_id) return null;
  return getGenerationById(Number(turn.current_generation_id));
}

/** 该生成是否仍是"当前且有效"的生成（分析任务执行前的校验依据） */
export function isGenerationCurrent(generationId: number): boolean {
  const g = getGenerationById(generationId);
  if (!g || g.status !== 'active') return false;
  const turn = getTurnById(g.turn_id);
  if (!turn) return false;
  if (turn.status === 'cancelled') return false;
  return Number(turn.current_generation_id) === Number(generationId);
}

/* ------------------------------------------------------------------ */
/* 生命周期（写操作统一走事务）                                            */
/* ------------------------------------------------------------------ */
/** 新建一轮（sequence 在用户内递增）；同一用户消息只应有一个 turn */
export function createTurn(userMessageId: number): TurnRow {
  return tx(() => {
    const row = dbGet<{ maxSeq: number | null }>(
      'SELECT MAX(sequence) AS maxSeq FROM conversation_turns WHERE user_id = ?',
      DEFAULT_USER_ID
    );
    const seq = Number(row?.maxSeq ?? 0) + 1;
    const { lastInsertRowid } = dbRun(
      `INSERT INTO conversation_turns (user_id, sequence, user_message_id, current_generation_id, status, created_at)
       VALUES (?, ?, ?, NULL, 'pending', ?)`,
      DEFAULT_USER_ID,
      seq,
      userMessageId,
      nowIso()
    );
    const turn = getTurnById(lastInsertRowid);
    if (!turn) throw new Error('回合记录创建失败');
    return turn;
  });
}

/** 开始一次生成（generation_no 递增；写 turn.current_generation_id、turn.status='generating'） */
export function beginGeneration(turnId: number): GenerationRow {
  return tx(() => {
    const row = dbGet<{ maxNo: number | null }>(
      'SELECT MAX(generation_no) AS maxNo FROM message_generations WHERE user_id = ? AND turn_id = ?',
      DEFAULT_USER_ID,
      turnId
    );
    const no = Number(row?.maxNo ?? 0) + 1;
    const { lastInsertRowid } = dbRun(
      `INSERT INTO message_generations (user_id, turn_id, generation_no, assistant_message_id, status, created_at)
       VALUES (?, ?, ?, NULL, 'active', ?)`,
      DEFAULT_USER_ID,
      turnId,
      no,
      nowIso()
    );
    dbRun(
      "UPDATE conversation_turns SET current_generation_id = ?, status = 'generating' WHERE user_id = ? AND id = ?",
      lastInsertRowid,
      DEFAULT_USER_ID,
      turnId
    );
    const gen = getGenerationById(lastInsertRowid);
    if (!gen) throw new Error('生成记录创建失败');
    return gen;
  });
}

/**
 * 生成成功收尾：仅当它仍是当前生成时才写入 assistant 消息并置 turn 完成。
 * 生成本身保持 'active'（完成后仍需可被分析任务校验为"当前有效生成"）。
 */
export function completeGeneration(generationId: number, assistantMessageId: number): boolean {
  return tx(() => {
    const g = getGenerationById(generationId);
    if (!g) return false;
    const turn = getTurnById(g.turn_id);
    if (!turn) return false;
    if (Number(turn.current_generation_id) !== Number(generationId)) return false; // 已被重新生成取代
    dbRun(
      'UPDATE message_generations SET assistant_message_id = ? WHERE user_id = ? AND id = ?',
      assistantMessageId,
      DEFAULT_USER_ID,
      generationId
    );
    dbRun(
      "UPDATE conversation_turns SET status = 'completed', completed_at = ? WHERE user_id = ? AND id = ?",
      nowIso(),
      DEFAULT_USER_ID,
      turn.id
    );
    return true;
  });
}

/** 生成失败：标 failed（分析任务校验会因此作废） */
export function failGeneration(generationId: number): void {
  if (!Number.isFinite(generationId) || generationId <= 0) return;
  dbRun(
    "UPDATE message_generations SET status = 'failed' WHERE user_id = ? AND id = ?",
    DEFAULT_USER_ID,
    generationId
  );
}

/** 重新生成：把旧生成标 superseded（不再视为当前有效生成） */
export function supersedeGeneration(generationId: number): void {
  if (!Number.isFinite(generationId) || generationId <= 0) return;
  dbRun(
    "UPDATE message_generations SET status = 'superseded' WHERE user_id = ? AND id = ?",
    DEFAULT_USER_ID,
    generationId
  );
}

/** 整轮作废（生成失败清理用户消息时调用），使任何排队中的分析任务失效 */
export function cancelTurn(turnId: number): void {
  if (!Number.isFinite(turnId) || turnId <= 0) return;
  dbRun("UPDATE conversation_turns SET status = 'cancelled' WHERE user_id = ? AND id = ?", DEFAULT_USER_ID, turnId);
}

/* ------------------------------------------------------------------ */
/* 服务端会话串行锁（按 userId）                                          */
/* ------------------------------------------------------------------ */
interface LockStore {
  chains: Map<number, Promise<unknown>>;
}

declare global {
   
  var __gfTurnLocks: LockStore | undefined;
}

function lockStore(): LockStore {
  if (!globalThis.__gfTurnLocks) globalThis.__gfTurnLocks = { chains: new Map() };
  return globalThis.__gfTurnLocks;
}

/**
 * 按 userId 串行执行：同一会话的请求排队依次执行（不是拒绝）。
 * 用 globalThis 保存 Promise 链，避免开发模式 HMR 重建模块时丢锁。
 * 注意：调用方不要在锁内再次获取同一把锁（会自等），也不要把 fn 写成永不 resolve。
 */
export function withConversationLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const store = lockStore();
  const prev = store.chains.get(userId) ?? Promise.resolve();
  // 前一棒成功或失败都继续执行下一棒（锁只保证顺序，不传播上一棒的异常）
  const run = prev.then(
    () => fn(),
    () => fn()
  );
  // 链尾必须吞掉异常，否则后续 await 会被上一棒的失败中断
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  store.chains.set(userId, tail);
  void tail.then(() => {
    // 只在仍是队尾时清理，避免误删后来者的链
    if (store.chains.get(userId) === tail) store.chains.delete(userId);
  });
  return run;
}

/** 该会话当前是否忙碌（有请求在跑或排队） */
export function conversationBusy(userId: number): boolean {
  return lockStore().chains.has(userId);
}