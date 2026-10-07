// 一次性后台推进（P1-59）：前端应用启动时 POST 一次，
// 替代过去"GET /api/life 顺带推进时间"的写副作用（读接口保持只读）。
//
// T02 收尾 §3.8：按伴侣遍历——对每个 girlfriend 伴侣（含 id=1 主女友）在其作用域内推进同一套逻辑，
// 避免只服务主女友。主女友无上下文即默认目标，行为与旧实现逐字段一致（零回归）。
import { errMsg } from '@/lib/utils';
import { withCompanion } from '@/lib/companion-context';
import { listAdvanceableCompanions, displayNameOf } from '@/lib/companion';
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
    // 串行遍历（不引入并发写，避免与 tx()/会话锁语义冲突）；各伴侣的节流私有键仍各自生效。
    const ids = listAdvanceableCompanions();
    for (const id of ids) {
      await withCompanion(id, async () => {
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
          // 自动识别：交往中反复出现的人浮现为可攻略对象（6 小时节流、失败静默）
          const { maybeAutoDiscover } = await import('@/lib/candidate-gen');
          await maybeAutoDiscover(id, { ownerName: displayNameOf(id, '她') });
        } catch (e) {
          // 单伴侣失败不得中断其它伴侣，也不让整体 500
          console.warn(`[tick] companion ${id} failed:`, errMsg(e));
        }
      });
    }
    return Response.json({ ok: true });
  } catch (e) {
    // 枚举伴侣本身失败（如数据库不可用）才回报错误
    return Response.json({ ok: false, error: errMsg(e) });
  }
}
