// 后台分析队列：以 analysis_jobs 表为唯一事实源，严格串行执行，重启后自动恢复未完成任务。
// 关键点：
//   - 入队即写 pending 行并立即返回（不阻塞聊天）；不再有"队列上限静默丢弃"。
//   - drain 每次只取最早一条 pending，标 running，**执行前校验**（assistant 消息存在 && generation 仍 current），
//     不满足则标 cancelled，绝不调用 analyzeTurn；通过后从 messages 表读取真实文本再分析。
//   - 失败按 1/5/15 分钟退避重试（≤3 次），否则 failed。
import { dbGet, dbRun, DEFAULT_USER_ID } from './db';
import { analyzeTurn, type AnalyzeOutcome } from './analysis';
import { isGenerationCurrent } from './turn';
import { errMsg, nowIso } from './utils';

export interface EnqueueAnalysisJob {
  turnId?: number | null;
  generationId?: number | null;
  userMessageId?: number | null;
  assistantMessageId?: number | null;
}

interface AnalysisJobRow {
  id: number;
  user_id: number;
  turn_id: number | null;
  generation_id: number | null;
  user_message_id: number | null;
  assistant_message_id: number | null;
  status: string;
  attempts: number;
  next_retry_at: number | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  created_at: string;
}

/** analyzeTurn 的参数形状（与分析代理的冻结签名一致；这里用变量传入，避免"多字段"字面量检查） */
interface AnalyzeTurnParams {
  userMessage: string;
  assistantMessage: string;
  userMessageId?: number | null;
  assistantMessageId?: number | null;
  turnId?: number | null;
  generationId?: number | null;
}

interface QueueState {
  draining: boolean;
  lastMs: number;
  lastFinishedAt: number;
  last: { ok: boolean; error?: string; applied: AnalyzeOutcome['applied'] } | null;
  /** jobId → 等待该任务最终结果的 resolve（重试期间不 resolve） */
  waiters: Map<number, (o: AnalyzeOutcome) => void>;
}

declare global {
   
  var __gfAnalysisQueue: QueueState | undefined;
}

function state(): QueueState {
  if (!globalThis.__gfAnalysisQueue) {
    globalThis.__gfAnalysisQueue = { draining: false, lastMs: 0, lastFinishedAt: 0, last: null, waiters: new Map() };
  }
  return globalThis.__gfAnalysisQueue;
}

/** 遗留 running 判定为陈旧的阈值：超过它认为进程已死、任务可重跑 */
const STALE_RUNNING_MS = 30 * 60 * 1000;
/** "分析较慢"告警阈值：仅打印日志，仍然等它跑完；绝不并发启动下一轮 */
const ANALYZE_SLOW_WARN_MS = 90_000;
/** 失败退避：第 1/2/3 次失败分别等待 1/5/15 分钟 */
const RETRY_BACKOFF_MS = [1 * 60_000, 5 * 60_000, 15 * 60_000];

function emptyApplied(): AnalyzeOutcome['applied'] {
  return {
    memories: 0,
    personalitySignals: 0,
    conflict: false,
    repaired: false,
    stageChanged: false,
    attachmentAnalyzed: false,
  };
}

/* ------------------------------------------------------------------ */
/* 入队                                                                  */
/* ------------------------------------------------------------------ */
/**
 * 入队后立即返回（不等分析跑完）。事实落库到 analysis_jobs，
 * 返回的 Promise 在该任务最终结束（done/cancelled/failed）时 resolve。
 */
export function enqueueAnalysis(job: EnqueueAnalysisJob): {
  promise: Promise<AnalyzeOutcome>;
  pending: number;
  jobId: number;
} {
  const { lastInsertRowid } = dbRun(
    `INSERT INTO analysis_jobs
       (user_id, turn_id, generation_id, user_message_id, assistant_message_id, status, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
    DEFAULT_USER_ID,
    job.turnId ?? null,
    job.generationId ?? null,
    job.userMessageId ?? null,
    job.assistantMessageId ?? null,
    nowIso()
  );
  const jobId = lastInsertRowid;
  const promise = new Promise<AnalyzeOutcome>((resolve) => {
    state().waiters.set(jobId, resolve);
  });
  drainAnalysisQueue().catch((e) => {
    console.warn('[analysisQueue] drain 异常:', errMsg(e));
  });
  return { promise, pending: countPending(), jobId };
}

/* ------------------------------------------------------------------ */
/* 统计                                                                  */
/* ------------------------------------------------------------------ */
function countPending(): number {
  return Number(
    dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM analysis_jobs WHERE user_id = ? AND status = 'pending'", DEFAULT_USER_ID)
      ?.c ?? 0
  );
}

function countRunning(): number {
  return Number(
    dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM analysis_jobs WHERE user_id = ? AND status = 'running'", DEFAULT_USER_ID)
      ?.c ?? 0
  );
}

export function analysisQueueStatus(): {
  pending: number;
  running: boolean;
  busy: boolean;
  lastMs: number;
  lastFinishedAt: number;
  last: { ok: boolean; error?: string; applied: AnalyzeOutcome['applied'] } | null;
} {
  const st = state();
  const pending = countPending();
  const running = countRunning() > 0;
  return {
    pending,
    running,
    busy: running || pending > 0,
    lastMs: st.lastMs,
    lastFinishedAt: st.lastFinishedAt,
    last: st.last,
  };
}

/* ------------------------------------------------------------------ */
/* 恢复                                                                  */
/* ------------------------------------------------------------------ */
/**
 * 启动恢复：把进程死亡留下的 'running'（started_at 超过 30 分钟）改回 pending。
 * 模块初始化与 ensureScheduler / 每轮 drain 前都会调用。
 */
export function recoverStaleAnalysisJobs(now = Date.now()): number {
  const cutoff = new Date(now - STALE_RUNNING_MS).toISOString();
  const r = dbRun(
    `UPDATE analysis_jobs SET status = 'pending', started_at = NULL
      WHERE user_id = ? AND status = 'running' AND (started_at IS NULL OR started_at < ?)`,
    DEFAULT_USER_ID,
    cutoff
  );
  return r.changes;
}

/* ------------------------------------------------------------------ */
/* 领取 / 校验 / 收尾                                                     */
/* ------------------------------------------------------------------ */
function claimNextJob(): AnalysisJobRow | null {
  const now = Date.now();
  const row = dbGet<AnalysisJobRow>(
    `SELECT * FROM analysis_jobs
      WHERE user_id = ? AND status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY id ASC LIMIT 1`,
    DEFAULT_USER_ID,
    now
  );
  if (!row) return null;
  const upd = dbRun(
    "UPDATE analysis_jobs SET status = 'running', started_at = ?, error = NULL WHERE user_id = ? AND id = ? AND status = 'pending'",
    nowIso(),
    DEFAULT_USER_ID,
    row.id
  );
  if (upd.changes !== 1) return null; // 竞争失败/状态已变：交给下一轮
  return { ...row, status: 'running' };
}

/**
 * 执行前校验：
 *   - assistant 消息必须存在；
 *   - 有 turn/generation 时：generation 必须仍是当前有效生成（active 且 = turn.current_generation_id，turn 未取消）；
 *   - 无 turn/generation 的旧任务：放宽为"assistant 消息仍存在"（向后兼容旧客户端）。
 */
function validateJob(job: AnalysisJobRow): { ok: true } | { ok: false; reason: string } {
  if (job.assistant_message_id == null) return { ok: false, reason: '缺少 assistant 消息，任务作废' };
  const msg = dbGet<{ id: number }>(
    'SELECT id FROM messages WHERE user_id = ? AND id = ? AND role = ?',
    DEFAULT_USER_ID,
    job.assistant_message_id,
    'assistant'
  );
  if (!msg) return { ok: false, reason: 'assistant 消息已不存在，任务作废' };
  // 旧任务：没有 turn/generation 归属，只校验消息存在
  if (job.turn_id == null && job.generation_id == null) return { ok: true };
  if (job.generation_id == null) return { ok: false, reason: 'generation 缺失，任务作废' };
  if (!isGenerationCurrent(job.generation_id)) return { ok: false, reason: 'generation 已被取代，任务作废' };
  return { ok: true };
}

/** 从 messages 表读取真实文本（不再相信外部传入的文本） */
function readJobTexts(job: AnalysisJobRow): { userMessage: string; assistantMessage: string } | null {
  if (job.assistant_message_id == null) return null;
  const assistant = dbGet<{ content: string }>(
    'SELECT content FROM messages WHERE user_id = ? AND id = ?',
    DEFAULT_USER_ID,
    job.assistant_message_id
  );
  if (!assistant) return null;
  const user =
    job.user_message_id != null
      ? dbGet<{ content: string }>('SELECT content FROM messages WHERE user_id = ? AND id = ?', DEFAULT_USER_ID, job.user_message_id)
      : undefined;
  return { userMessage: String(user?.content ?? ''), assistantMessage: String(assistant.content ?? '') };
}

function settleWaiter(jobId: number, outcome: AnalyzeOutcome): void {
  const w = state().waiters.get(jobId);
  if (w) {
    state().waiters.delete(jobId);
    w(outcome);
  }
}

function cancelJob(job: AnalysisJobRow, reason: string): void {
  dbRun(
    "UPDATE analysis_jobs SET status = 'cancelled', finished_at = ?, error = ? WHERE user_id = ? AND id = ?",
    nowIso(),
    reason,
    DEFAULT_USER_ID,
    job.id
  );
  const st = state();
  st.last = { ok: false, error: reason, applied: emptyApplied() };
  st.lastFinishedAt = Date.now();
  settleWaiter(job.id, { ok: false, error: reason, applied: emptyApplied() });
}

function doneJob(job: AnalysisJobRow, out: AnalyzeOutcome, ms: number): void {
  dbRun("UPDATE analysis_jobs SET status = 'done', finished_at = ? WHERE user_id = ? AND id = ?", nowIso(), DEFAULT_USER_ID, job.id);
  const st = state();
  st.last = { ok: out.ok, error: out.error, applied: out.applied };
  st.lastFinishedAt = Date.now();
  st.lastMs = ms;
  settleWaiter(job.id, out);
}

function retryOrFail(job: AnalysisJobRow, error: string, ms: number): void {
  const st = state();
  const attempts = job.attempts + 1;
  st.last = { ok: false, error, applied: emptyApplied() };
  st.lastFinishedAt = Date.now();
  st.lastMs = ms;
  if (attempts <= RETRY_BACKOFF_MS.length) {
    const delay = RETRY_BACKOFF_MS[attempts - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
    dbRun(
      "UPDATE analysis_jobs SET status = 'pending', attempts = ?, next_retry_at = ?, started_at = NULL, error = ? WHERE user_id = ? AND id = ?",
      attempts,
      Date.now() + delay,
      error,
      DEFAULT_USER_ID,
      job.id
    );
    // 到期后再踢一次 drain；unref 避免定时器拖住进程退出（测试/关闭时安全）
    const t = setTimeout(() => {
      drainAnalysisQueue().catch((e) => {
        console.warn('[analysisQueue] drain 异常:', errMsg(e));
      });
    }, delay);
    if (typeof t.unref === 'function') t.unref();
    return; // 重试期间不 resolve（等待任务最终结束）
  }
  dbRun(
    "UPDATE analysis_jobs SET status = 'failed', attempts = ?, finished_at = ?, error = ? WHERE user_id = ? AND id = ?",
    attempts,
    nowIso(),
    error,
    DEFAULT_USER_ID,
    job.id
  );
  settleWaiter(job.id, { ok: false, error, applied: emptyApplied() });
}

/* ------------------------------------------------------------------ */
/* 串行 drain                                                           */
/* ------------------------------------------------------------------ */
/**
 * 严格串行：任何时刻只有一个 drain、也只有一个 analyzeTurn 在跑。
 * 先让出一次微任务，确保同一 tick 内先发生的 enqueue/supersede 已经落库，
 * 再做领取与校验（避免误跑"已被重新生成取代"的任务）。
 */
export async function drainAnalysisQueue(): Promise<void> {
  const st = state();
  if (st.draining) return;
  st.draining = true;
  try {
    recoverStaleAnalysisJobs();
    for (;;) {
      await Promise.resolve();
      const job = claimNextJob();
      if (!job) break;

      const valid = validateJob(job);
      if (!valid.ok) {
        cancelJob(job, valid.reason);
        continue;
      }
      const texts = readJobTexts(job);
      if (!texts) {
        cancelJob(job, '对话文本缺失，任务作废');
        continue;
      }

      const t0 = Date.now();
      const slowTimer = setTimeout(() => {
        console.warn(
          `[analysisQueue] 分析较慢：本轮已运行超过 ${ANALYZE_SLOW_WARN_MS / 1000} 秒，继续等待其完成（不并发启动下一轮）`
        );
      }, ANALYZE_SLOW_WARN_MS);
      try {
        const params: AnalyzeTurnParams = {
          userMessage: texts.userMessage,
          assistantMessage: texts.assistantMessage,
          userMessageId: job.user_message_id,
          assistantMessageId: job.assistant_message_id,
          turnId: job.turn_id,
          generationId: job.generation_id,
        };
        const out = await analyzeTurn(params);
        if (out.ok) doneJob(job, out, Date.now() - t0);
        else retryOrFail(job, out.error || '分析失败', Date.now() - t0);
      } catch (e) {
        retryOrFail(job, errMsg(e), Date.now() - t0);
      } finally {
        clearTimeout(slowTimer);
      }
    }
  } finally {
    st.draining = false;
  }
}

// 模块初始化：恢复遗留 running 并踢一次 drain（进程重启后未完成的任务自动续跑）
recoverStaleAnalysisJobs();
drainAnalysisQueue().catch((e) => {
  console.warn('[analysisQueue] 启动恢复异常:', errMsg(e));
});