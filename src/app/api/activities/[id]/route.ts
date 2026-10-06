// 活动详情 / 操作：GET 详情（参与者 + 日程 + 消息）；PATCH focus / advance / end / cancel。
//
// 所有写操作统一走「群锁」（key = 关联群 id，缺省 g:0），与并发进行的活动回合串行化，
// 避免「正在结束活动时又产生一条发言」这类竞态。
import { withGroupLock } from '@/lib/group-run';
import {
  getActivity,
  getActivityDetail,
  focus,
  advanceSchedule,
  endActivity,
  cancelActivity,
  activityHttpStatus,
} from '@/lib/activity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function parseId(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  const { id } = await ctx.params;
  const n = Math.trunc(Number(id));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function notFound() {
  return Response.json({ ok: false, code: 'ACTIVITY_NOT_FOUND', error: '活动不存在' }, { status: 404 });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const aid = await parseId(ctx);
  if (!aid) return notFound();
  const detail = getActivityDetail(aid);
  if (!detail) return notFound();
  return Response.json({
    ok: true,
    activity: detail.activity,
    participantIds: detail.participantIds,
    participants: detail.participants,
    schedule: detail.schedule,
    groupId: detail.groupId,
    messages: detail.messages,
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const aid = await parseId(ctx);
  if (!aid) return notFound();
  const activity = getActivity(aid);
  if (!activity) return notFound();
  const lockGroup = activity.group_id == null ? 0 : Number(activity.group_id);

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const action = String(body.action ?? '');

  if (action === 'focus') {
    const cid = Math.trunc(Number(body.companionId));
    const res = await withGroupLock(lockGroup, async () => focus(aid, cid));
    if (!res.ok) {
      return Response.json({ ok: false, code: res.code, error: res.error }, { status: activityHttpStatus(res.code) });
    }
    return Response.json({ ok: true, activity: res.activity });
  }

  if (action === 'advance') {
    const schedule = await withGroupLock(lockGroup, async () => advanceSchedule(aid));
    return Response.json({ ok: true, schedule });
  }

  if (action === 'end') {
    const res = await withGroupLock(lockGroup, async () => endActivity(aid));
    if (!res.ok) {
      return Response.json({ ok: false, code: res.code, error: res.error }, { status: activityHttpStatus(res.code) });
    }
    const detail = getActivityDetail(aid);
    return Response.json({ ok: true, activity: res.activity, summary: res.summary ?? '', detail });
  }

  if (action === 'cancel') {
    const res = await withGroupLock(lockGroup, async () => cancelActivity(aid));
    if (!res.ok) {
      return Response.json({ ok: false, code: res.code, error: res.error }, { status: activityHttpStatus(res.code) });
    }
    return Response.json({ ok: true, activity: res.activity });
  }

  return Response.json({ ok: false, code: 'INVALID_INPUT', error: '未知操作' }, { status: 400 });
}
