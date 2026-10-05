// 后台调度器：进程内定时检查主动消息 / 每日摘要
// 由 API 路由首次被访问时启动（避免 instrumentation 在 edge 构建下引入 node 模块）
import { tickProactive } from './proactive';
import { seedProfilesIfEmpty } from './profiles';
import { getCounter, setCounter } from './db';
import { drainAnalysisQueue } from './analysisQueue';
import { errMsg } from './utils';

interface SchedulerGlobal {
  __gfSchedulerStarted?: boolean;
  __gfTimer1?: ReturnType<typeof setTimeout> | null;
  __gfTimer2?: ReturnType<typeof setInterval> | null;
}

/** 调度租约有效期：超过它认为持有者已死，可被抢占 */
const LEASE_TTL_MS = 30 * 60 * 1000;

/** pm2 / 多实例 worker 序号：有值且 >= 1 视为非主实例 */
function workerIndex(): string | null {
  const v = process.env.NODE_APP_INSTANCE ?? process.env.PM_ID;
  return v != null && v !== '' ? v : null;
}

function isPrimaryInstance(): boolean {
  const v = workerIndex();
  if (v == null) return true;
  const n = Number(v);
  return !Number.isFinite(n) || n < 1;
}

/**
 * 数据库租约：counters 的 scheduler_lease_pid / scheduler_lease_at。
 * 无租约 / 本进程持有 / 已过期（>30 分钟）时可抢占；否则本轮跳过。
 * 注意：counters 只存数字，pid 与 epoch ms 都是数字，无需改表。
 */
function acquireLease(): boolean {
  const now = Date.now();
  const holderPid = getCounter('scheduler_lease_pid');
  const heldAt = getCounter('scheduler_lease_at');
  const expired = !heldAt || now - heldAt > LEASE_TTL_MS;
  if (holderPid !== 0 && holderPid !== process.pid && !expired) return false;
  setCounter('scheduler_lease_pid', process.pid);
  setCounter('scheduler_lease_at', now);
  return true;
}

export function ensureScheduler(): void {
  const g = globalThis as typeof globalThis & SchedulerGlobal;
  if (g.__gfSchedulerStarted) return;
  g.__gfSchedulerStarted = true;

  // 多实例防护：非主实例不启动定时器（避免多实例重复发主动消息 / 抢同一把 DB 租约）
  if (!isPrimaryInstance()) {
    console.warn(
      `[虚拟女友] 检测到非主实例（NODE_APP_INSTANCE/PM_ID=${workerIndex()}），跳过启动后台定时器，仅主实例运行调度。`
    );
    return;
  }

  // 启动恢复：把遗留的 running 分析任务改回 pending 并继续处理（进程重启后任务不丢）
  drainAnalysisQueue().catch((e) => {
    console.warn('[analysisQueue] 启动恢复失败:', errMsg(e));
  });

  // 首次运行时把当前模型配置存成"模型档案"，方便随时切换
  try {
    seedProfilesIfEmpty();
  } catch (e) {
    console.warn('[profiles] seed failed:', errMsg(e));
  }

  let running = false; // 上一次 tick 还没跑完就不再叠一次（tickProactive 里有模型调用，可能超过 5 分钟）
  const run = async (force: boolean) => {
    if (running) return;
    running = true;
    try {
      // DB 租约：拿不到就跳过本轮（可能由其它实例持有）
      if (!acquireLease()) {
        console.warn('[虚拟女友] 未获得调度租约（可能由其它实例持有），跳过本轮 tick');
        return;
      }
      // 到期重试的分析任务在这里续跑（串行；不阻塞后续生活推进太久）
      try {
        await drainAnalysisQueue();
      } catch (e) {
        console.warn('[analysisQueue] drain failed:', errMsg(e));
      }
      try {
        // 她的生活先推进（按流逝时间推导，幂等）
        const { ensureLife, advanceLife, saveWeeklyWorldSnapshot, tickLifeArc, ensureDailyDiaries } = await import('./life');
        const { advanceIntimacy } = await import('./intimacy');
        ensureLife();
        advanceLife();
        advanceIntimacy();
        saveWeeklyWorldSnapshot();
        // 跨天剧情线 + 她的日记（内部有节流、失败静默，不会阻塞主流程）
        await tickLifeArc();
        await ensureDailyDiaries();
      } catch (e) {
        console.warn('[life] advance failed:', errMsg(e));
      }
      try {
        await tickProactive(force);
      } catch (e) {
        console.warn('[proactive] tick failed:', errMsg(e));
      }
    } finally {
      running = false;
    }
  };

  // 启动 20 秒后先跑一次（推进生活 + 例行检查；主动消息是否发出仍受频率/时段闸门约束）
  g.__gfTimer1 = setTimeout(() => run(false), 20 * 1000);
  // 之后每 5 分钟检查一次
  g.__gfTimer2 = setInterval(() => run(false), 5 * 60 * 1000);
  console.log('[虚拟女友] 后台定时任务已启动（每 5 分钟检查一次主动消息）');
}

/** 停止调度（进程退出/测试用） */
export function stopScheduler(): void {
  const g = globalThis as typeof globalThis & SchedulerGlobal;
  if (g.__gfTimer1) clearTimeout(g.__gfTimer1);
  if (g.__gfTimer2) clearInterval(g.__gfTimer2);
  g.__gfTimer1 = null;
  g.__gfTimer2 = null;
  g.__gfSchedulerStarted = false;
}