// 后台调度器：进程内定时检查主动消息 / 每日摘要
// 由 API 路由首次被访问时启动（避免 instrumentation 在 edge 构建下引入 node 模块）
import { tickProactive } from './proactive';
import { seedProfilesIfEmpty } from './profiles';
import { getCounter, setCounter } from './db';
import { drainAnalysisQueue } from './analysisQueue';
import { errMsg } from './utils';
import { withCompanion } from './companion-context';
import { listAdvanceableCompanions } from './companion';

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
      // 生活依赖按需加载（与既有实现一致：不在模块顶层引入重依赖）
      const life = await import('./life');
      const { advanceIntimacy } = await import('./intimacy');

      // §3.8 后台任务按伴侣遍历：对每个 girlfriend 伴侣（含 id=1 主女友）在其作用域内推进同一套逻辑，
      // 避免只服务主女友。主女友（id=1）无上下文即默认目标 → 行为与原实现逐字段一致（零回归）。
      // 租约键（scheduler_lease_*）保持全局；各伴侣的节流窗口已是私有键，遍历时仍各自生效。
      const ids = listAdvanceableCompanions();
      for (const id of ids) {
        await withCompanion(id, async () => {
          try {
            life.ensureLife();
            life.advanceLife();
            advanceIntimacy();
            life.saveWeeklyWorldSnapshot();
            // 跨天剧情线 + 她的日记（内部有节流、失败静默，不会阻塞主流程）
            await life.tickLifeArc();
            await life.ensureDailyDiaries();
          } catch (e) {
            // 单伴侣失败不得中断其它伴侣
            console.warn(`[life] companion ${id} advance failed:`, errMsg(e));
          }
          try {
            await tickProactive(force);
          } catch (e) {
            console.warn(`[proactive] companion ${id} tick failed:`, errMsg(e));
          }
          // 自动识别（需求：交往中出现的人自动浮现为可攻略对象）：6 小时节流，失败静默
          try {
            const { maybeAutoDiscover } = await import('./candidate-gen');
            const { displayNameOf } = await import('./companion');
            await maybeAutoDiscover(id, { ownerName: displayNameOf(id, '她') });
          } catch (e) {
            console.warn(`[autoDiscover] companion ${id} failed:`, errMsg(e));
          }
        });
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