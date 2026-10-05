// 后台分析队列：串行执行，保证不阻塞聊天、也不并发写坏关系状态
import { analyzeTurn, type AnalyzeOutcome } from './analysis';
import { errMsg } from './utils';

interface Job {
  userMessage: string;
  assistantMessage: string;
  userMessageId?: number | null;
  assistantMessageId?: number | null;
  resolve: (o: AnalyzeOutcome) => void;
  queuedAt: number;
}

interface QueueState {
  queue: Job[];
  running: boolean;
  lastMs: number;
  lastFinishedAt: number;
  last: { ok: boolean; error?: string; applied: AnalyzeOutcome['applied'] } | null;
}

declare global {
   
  var __gfAnalysisQueue: QueueState | undefined;
}

function state(): QueueState {
  if (!globalThis.__gfAnalysisQueue) {
    globalThis.__gfAnalysisQueue = { queue: [], running: false, lastMs: 0, lastFinishedAt: 0, last: null };
  }
  return globalThis.__gfAnalysisQueue;
}

/** 队列上限：超出时丢弃最旧的排队项，避免无限增长占内存 */
const MAX_QUEUE = 50;
/** 单轮分析超时：底层挂起时不至于永久卡死后续分析 */
const ANALYZE_TIMEOUT_MS = 90_000;

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

/** 给 Promise 加超时：超时后抛错，且清理计时器；底层 promise 仍会自行结束，不影响队列继续 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`分析超时（${ms / 1000} 秒）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * 入队后立即返回（不等分析跑完）——前端因此不会被"归档记忆"卡住。
 * 返回的 Promise 会在这一轮分析结束时 resolve，调用方可以选择等或不等。
 */
export function enqueueAnalysis(job: Omit<Job, 'resolve' | 'queuedAt'>): { promise: Promise<AnalyzeOutcome>; pending: number } {
  const st = state();
  const promise = new Promise<AnalyzeOutcome>((resolve) => {
    st.queue.push({ ...job, resolve, queuedAt: Date.now() });
    // 超限：丢弃最旧的排队项（resolve 掉它的 Promise，避免调用方永久等待）
    while (st.queue.length > MAX_QUEUE) {
      const dropped = st.queue.shift()!;
      dropped.resolve({ ok: false, error: '分析队列已满，丢弃最早的排队项', applied: emptyApplied() });
    }
    void drain();
  });
  return { promise, pending: st.queue.length };
}

async function drain(): Promise<void> {
  const st = state();
  if (st.running) return;
  st.running = true;
  try {
    while (st.queue.length) {
      const job = st.queue.shift()!;
      const t0 = Date.now();
      try {
        const out = await withTimeout(analyzeTurn(job), ANALYZE_TIMEOUT_MS);
        st.last = { ok: out.ok, error: out.error, applied: out.applied };
        job.resolve(out);
      } catch (e) {
        const error = errMsg(e);
        st.last = { ok: false, error, applied: emptyApplied() };
        job.resolve({ ok: false, error, applied: emptyApplied() });
      }
      st.lastMs = Date.now() - t0;
      st.lastFinishedAt = Date.now();
    }
  } finally {
    // 无论超时/异常/正常结束，都确保复位，避免后续分析永久卡死
    st.running = false;
  }
}

export function analysisQueueStatus() {
  const st = state();
  return {
    pending: st.queue.length,
    running: st.running,
    busy: st.running || st.queue.length > 0,
    lastMs: st.lastMs,
    lastFinishedAt: st.lastFinishedAt,
    last: st.last,
  };
}