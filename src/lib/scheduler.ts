// 后台调度器：进程内定时检查主动消息 / 每日摘要
// 由 API 路由首次被访问时启动（避免 instrumentation 在 edge 构建下引入 node 模块）
import { tickProactive } from './proactive';
import { seedProfilesIfEmpty } from './profiles';

export function ensureScheduler(): void {
  const g = globalThis as any;
  if (g.__gfSchedulerStarted) return;
  g.__gfSchedulerStarted = true;

  // 首次运行时把当前模型配置存成"模型档案"，方便随时切换
  try {
    seedProfilesIfEmpty();
  } catch (e: any) {
    console.warn('[profiles] seed failed:', e?.message || e);
  }

  let running = false; // 上一次 tick 还没跑完就不再叠一次（tickProactive 里有模型调用，可能超过 5 分钟）
  const run = async (force: boolean) => {
    if (running) return;
    running = true;
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
    } catch (e: any) {
      console.warn('[life] advance failed:', e?.message || e);
    }
    try {
      await tickProactive(force);
    } catch (e: any) {
      console.warn('[proactive] tick failed:', e?.message || e);
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
  const g = globalThis as any;
  if (g.__gfTimer1) clearTimeout(g.__gfTimer1);
  if (g.__gfTimer2) clearInterval(g.__gfTimer2);
  g.__gfTimer1 = null;
  g.__gfTimer2 = null;
  g.__gfSchedulerStarted = false;
}