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

  const run = async (force: boolean) => {
    try {
      // 她的生活先推进（按流逝时间推导，幂等）
      const { ensureLife, advanceLife, saveWeeklyWorldSnapshot } = await import('./life');
      const { advanceIntimacy } = await import('./intimacy');
      ensureLife();
      advanceLife();
      advanceIntimacy();
      saveWeeklyWorldSnapshot();
    } catch (e: any) {
      console.warn('[life] advance failed:', e?.message || e);
    }
    try {
      await tickProactive(force);
    } catch (e: any) {
      console.warn('[proactive] tick failed:', e?.message || e);
    }
  };

  // 启动 20 秒后先跑一次（只做跨天摘要之类的例行检查，不发主动消息）
  setTimeout(() => run(false), 20 * 1000);
  // 之后每 5 分钟检查一次
  setInterval(() => run(false), 5 * 60 * 1000);
  console.log('[虚拟女友] 后台定时任务已启动（每 5 分钟检查一次主动消息）');
}