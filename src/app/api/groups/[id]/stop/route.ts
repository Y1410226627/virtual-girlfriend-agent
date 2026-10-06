// 中止当前群聊 run（「停止」按钮）。
//
// 注意：本路由【有意不获取群锁】。群聊 run 在 withGroupLock 内串行执行（持锁直到整轮结束），
// 若「停止」也去抢同一把锁，就会排在运行中的那一轮之后 → 无法"立即中止后续发言"。
// run.status 的取消是一条原子 UPDATE，本就不需要与发言写入互斥；
// 运行中的 runGroupTurn 会在每条消息之间重新读取 run.status，见 status='cancelled' 即停止（叶子锁原则）。
import { abort, groupHttpStatus } from '@/lib/group';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function parseId(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  const { id } = await ctx.params;
  const n = Math.trunc(Number(id));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gid = await parseId(ctx);
  if (!gid) {
    return Response.json({ ok: false, code: 'GROUP_NOT_FOUND', error: '群不存在' }, { status: 404 });
  }
  const res = abort(gid);
  if (!res.ok) {
    return Response.json({ ok: false, code: res.code, error: res.error }, { status: groupHttpStatus(res.code) });
  }
  return Response.json({ ok: true, run: res.run });
}
