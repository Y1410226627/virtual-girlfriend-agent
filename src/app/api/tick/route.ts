// 一次性后台推进（P1-59）：前端应用启动时 POST 一次，
// 替代过去"GET /api/life 顺带推进时间"的写副作用（读接口保持只读）。
import { errMsg } from '@/lib/utils';
import {
  ensureLife,
  advanceLife,
  saveWeeklyWorldSnapshot,
  tickLifeArc,
  ensureDailyDiaries,
} from '@/lib/life';
import { advanceIntimacy } from '@/lib/intimacy';
import { tickProactive } from '@/lib/proactive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    ensureLife();
    advanceLife();
    advanceIntimacy();
    saveWeeklyWorldSnapshot();
    // 跨天剧情线 + 她的日记（内部有节流、失败静默，不会阻塞主流程）
    await tickLifeArc();
    await ensureDailyDiaries();
    // 主动消息检查（仍受频率 / 深夜免打扰等闸门约束）
    await tickProactive(false);
    return Response.json({ ok: true });
  } catch (e) {
    // 静默失败即可（前端不依赖返回值），但如实回报错误便于排查
    return Response.json({ ok: false, error: errMsg(e) });
  }
}