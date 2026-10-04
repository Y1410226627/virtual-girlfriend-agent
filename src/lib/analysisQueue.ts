// 后台分析队列：串行执行，保证不阻塞聊天、也不并发写坏关系状态
import { analyzeTurn, type AnalyzeOutcome } from './analysis';

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
  // eslint-disable-next-line no-var
  var __gfAnalysisQueue: QueueState | undefined;
}

function state(): QueueState {
  if (!globalThis.__gfAnalysisQueue) {
    globalThis.__gfAnalysisQueue = { queue: [], running: false, lastMs: 0, lastFinishedAt: 0, last: null };
  }
  return globalThis.__gfAnalysisQueue;
}

/**
 * 入队后立即返回（不等分析跑完）——前端因此不会被"归档记忆"卡住。
 * 返回的 Promise 会在这一轮分析结束时 resolve，调用方可以选择等或不等。
 */
export function enqueueAnalysis(job: Omit<Job, 'resolve' | 'queuedAt'>): { promise: Promise<AnalyzeOutcome>; pending: number } {
  const st = state();
  const promise = new Promise<AnalyzeOutcome>((resolve) => {
    st.queue.push({ ...job, resolve, queuedAt: Date.now() });
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
        const out = await analyzeTurn(job);
        st.last = { ok: out.ok, error: out.error, applied: out.applied };
        job.resolve(out);
      } catch (e: any) {
        const applied = {
          memories: 0,
          personalitySignals: 0,
          conflict: false,
          repaired: false,
          stageChanged: false,
          attachmentAnalyzed: false,
        };
        st.last = { ok: false, error: e?.message || String(e), applied };
        job.resolve({ ok: false, error: e?.message || String(e), applied });
      }
      st.lastMs = Date.now() - t0;
      st.lastFinishedAt = Date.now();
    }
  } finally {
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