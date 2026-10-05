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
/** "分析较慢"告警阈值：仅打印日志，仍然等它跑完；绝不并发启动下一轮 */
const ANALYZE_SLOW_WARN_MS = 90_000;

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

/**
 * 运行单轮分析：超过阈值只告警，仍然 await 其真正结束。
 * 关键：绝不在底层仍可能写库时"放弃等待"并启动下一轮——否则两轮 analyzeTurn 并发会
 * 互相覆盖关系数值、触发嵌套 BEGIN / SQLITE_BUSY。因此这里不做超时放弃。
 * analyzeTurn 内部所有网络调用都有超时（chat/chatJson 单次 45s，embedding 20s），不会永久挂死。
 */
async function runAnalyzeTurn(job: Job): Promise<AnalyzeOutcome> {
  const timer = setTimeout(() => {
    console.warn(
      `[analysisQueue] 分析较慢：本轮已运行超过 ${ANALYZE_SLOW_WARN_MS / 1000} 秒，继续等待其完成（不并发启动下一轮）`
    );
  }, ANALYZE_SLOW_WARN_MS);
  try {
    return await analyzeTurn(job);
  } finally {
    clearTimeout(timer);
  }
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
  // 模块级 in-flight 保护：任何时刻只有一个 drain、也只有一个 analyzeTurn 在跑
  if (st.running) return;
  st.running = true;
  try {
    while (st.queue.length) {
      const job = st.queue.shift()!;
      const t0 = Date.now();
      try {
        // 严格串行：完成当前 job 后才取下一个（不做超时放弃，避免并发写坏数据）
        const out = await runAnalyzeTurn(job);
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
    // 无论异常/正常结束，都确保复位，避免后续分析永久卡死
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