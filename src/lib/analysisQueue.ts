// 后台分析队列：以 analysis_jobs 表为唯一事实源，严格串行执行，重启后自动恢复未完成任务。
// 关键点：
//   - 入队即写 pending 行并立即返回（不阻塞聊天）；不再有"队列上限静默丢弃"。
//   - drain 每次只取最早一条 pending，标 running，**执行前校验**（assistant 消息存在 && generation 仍 current），
//     不满足则标 cancelled，绝不调用 analyzeTurn；通过后从 messages 表读取真实文本再分析。
//   - 失败按 1/5/15 分钟退避重试（≤3 次），否则 failed。
import { dbRun, dbGet, dbAll, DEFAULT_USER_ID, cGet, cRun } from './db';
import { cId, withCompanion } from './companion-context';
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
  companion_id: number;
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
  const { lastInsertRowid } = cRun(
    `INSERT INTO analysis_jobs
       (companion_id, user_id, turn_id, generation_id, user_message_id, assistant_message_id, status, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
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
    cGet<{ c: number }>("SELECT COUNT(*) AS c FROM analysis_jobs WHERE companion_id = ? AND status = 'pending'")
      ?.c ?? 0
  );
}

function countRunning(): number {
  return Number(
    cGet<{ c: number }>("SELECT COUNT(*) AS c FROM analysis_jobs WHERE companion_id = ? AND status = 'running'")
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
  // 作用域内恢复：只回收"当前伴侣（cId()）"的陈旧 running（按 companion_id 分区）。
  // 语义差异：本函数是"分区/作用域内"的恢复；启动与每轮 drain 的"全局恢复"用
  // recoverAllStaleAnalysisJobs（跨伴侣）——见下。
  const r = dbRun(
    `UPDATE analysis_jobs SET status = 'pending', started_at = NULL
      WHERE companion_id = ? AND status = 'running' AND (started_at IS NULL OR started_at < ?)`,
    cId(),
    cutoff
  );
  return r.changes;
}

/**
 * 跨伴侣恢复（§3.8）：启动恢复与每轮 drain 前调用。
 * 把所有伴侣遗留的陈旧 running 都改回 pending，避免只回收主女友、其它伴侣的任务永远卡在 running。
 * 实现上逐个伴侣在各自作用域内调用 recoverStaleAnalysisJobs，复用同一套"陈旧"判定（DRY）。
 */
export function recoverAllStaleAnalysisJobs(now = Date.now()): number {
  const rows = dbAll<{ companion_id: number }>(
    "SELECT DISTINCT companion_id FROM analysis_jobs WHERE status = 'running'"
  );
  let total = 0;
  for (const r of rows) {
    const id = Math.trunc(Number(r.companion_id));
    if (!Number.isFinite(id) || id <= 0) continue;
    total += withCompanion(id, () => recoverStaleAnalysisJobs(now));
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* 领取 / 校验 / 收尾                                                     */
/* ------------------------------------------------------------------ */
function claimNextJob(): AnalysisJobRow | null {
  const now = Date.now();
  // 跨伴侣领取最早到期的 pending 任务（不按 cId() 过滤）：多伴侣并发聊天时，任一 drain 都能推进全局队列，
  // 避免"c1 的 drain 在跑时 c2 的任务要等下一次触发"。后续处理会以 job.companion_id 建立作用域。
  const row = dbGet<AnalysisJobRow>(
    `SELECT * FROM analysis_jobs
      WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY id ASC LIMIT 1`,
    now
  );
  if (!row) return null;
  const upd = dbRun(
    "UPDATE analysis_jobs SET status = 'running', started_at = ?, error = NULL WHERE id = ? AND status = 'pending'",
    nowIso(),
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
  const msg = cGet<{ id: number }>(
    'SELECT id FROM messages WHERE companion_id = ? AND id = ? AND role = ?',
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
  const assistant = cGet<{ content: string }>(
    'SELECT content FROM messages WHERE companion_id = ? AND id = ?',
    job.assistant_message_id
  );
  if (!assistant) return null;
  const user =
    job.user_message_id != null
      ? cGet<{ content: string }>('SELECT content FROM messages WHERE companion_id = ? AND id = ?', job.user_message_id)
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
  // 状态流转一律用显式 job.companion_id（不依赖当前 ALS 上下文，避免在作用域外被误写到主女友）。
  dbRun(
    "UPDATE analysis_jobs SET status = 'cancelled', finished_at = ?, error = ? WHERE companion_id = ? AND id = ?",
    nowIso(),
    reason,
    job.companion_id,
    job.id
  );
  const st = state();
  st.last = { ok: false, error: reason, applied: emptyApplied() };
  st.lastFinishedAt = Date.now();
  settleWaiter(job.id, { ok: false, error: reason, applied: emptyApplied() });
}

function doneJob(job: AnalysisJobRow, out: AnalyzeOutcome, ms: number): void {
  dbRun("UPDATE analysis_jobs SET status = 'done', finished_at = ? WHERE companion_id = ? AND id = ?", nowIso(), job.companion_id, job.id);
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
      "UPDATE analysis_jobs SET status = 'pending', attempts = ?, next_retry_at = ?, started_at = NULL, error = ? WHERE companion_id = ? AND id = ?",
      attempts,
      Date.now() + delay,
      error,
      job.companion_id,
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
    "UPDATE analysis_jobs SET status = 'failed', attempts = ?, finished_at = ?, error = ? WHERE companion_id = ? AND id = ?",
    attempts,
    nowIso(),
    error,
    job.companion_id,
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
    recoverAllStaleAnalysisJobs();
    for (;;) {
      await Promise.resolve();
      const job = claimNextJob();
      if (!job) break;

      // ★关键正确性点（T02 收尾 §3.8）：每个任务的全部处理（校验 / 读文本 / analyzeTurn /
      // applyAnalysisResult / 操作账本 / 状态流转）都必须在该任务所属伴侣的作用域内执行，
      // 否则分析结果会写进 cId()（当前上下文）而不是任务所属伴侣 → 跨伴侣串扰。
      await withCompanion(job.companion_id, async () => {
        const valid = validateJob(job);
        if (!valid.ok) {
          cancelJob(job, valid.reason);
          return; // 注意：此处是异步闭包，用 return 代替 continue
        }
        const texts = readJobTexts(job);
        if (!texts) {
          cancelJob(job, '对话文本缺失，任务作废');
          return;
        }

        const t0 = Date.now();
        const slowTimer = setTimeout(() => {
          console.warn(
            `[analysisQueue] 分析较慢（companion ${job.companion_id}）：本轮已运行超过 ${ANALYZE_SLOW_WARN_MS / 1000} 秒，继续等待其完成（不并发启动下一轮）`
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
      });
    }
  } finally {
    st.draining = false;
  }
}

// 模块初始化：跨伴侣恢复遗留 running 并踢一次 drain（进程重启后未完成的任务自动续跑）
recoverAllStaleAnalysisJobs();
drainAnalysisQueue().catch((e) => {
  console.warn('[analysisQueue] 启动恢复异常:', errMsg(e));
});