// 活动：GET 活动列表；POST 发起活动（线上 / 线下，2–6 名已晋升女友）。
//
// - 线上活动（kind='online'）：复用群聊引擎互动，场景保持 online；产物 = 群聊记录 + summary。
// - 线下活动（kind='offline'）：生成约会日程并把参与者置为 offline 场景（结束后恢复）。
// activities / activity_participants / activity_schedule_items 均为【全局表】，写入沿用「群锁」约定串行化。
import { withGroupLock } from '@/lib/group-run';
import { listActivities, createActivity, activityHttpStatus, type CreateActivityInput } from '@/lib/activity';
import { GROUP_MAX_MEMBERS } from '@/lib/group';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const activities = listActivities().map((a) => ({
    id: Number(a.activity.id),
    group_id: a.activity.group_id == null ? null : Number(a.activity.group_id),
    kind: a.activity.kind,
    template_key: a.activity.template_key,
    title: a.activity.title,
    scene: a.activity.scene,
    status: a.activity.status,
    scheduled_at: a.activity.scheduled_at,
    location: a.activity.location,
    focus_companion_id: a.activity.focus_companion_id == null ? null : Number(a.activity.focus_companion_id),
    summary: a.activity.summary,
    created_at: a.activity.created_at,
    updated_at: a.activity.updated_at,
    participantIds: a.participantIds,
    participantNames: a.participantNames,
    scheduleCount: a.scheduleCount,
  }));
  return Response.json({ ok: true, activities });
}

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const rawKind = String(body.kind ?? 'online');
  const kind: 'online' | 'offline' = rawKind === 'offline' ? 'offline' : 'online';
  const memberIds = Array.isArray(body.memberIds) ? (body.memberIds as unknown[]).map((x) => Math.trunc(Number(x))) : [];

  const input: CreateActivityInput = {
    kind,
    templateKey: body.templateKey == null ? undefined : String(body.templateKey),
    title: body.title == null ? undefined : String(body.title),
    memberIds,
    groupId: body.groupId == null ? null : Math.trunc(Number(body.groupId)),
    scheduledAt: body.scheduledAt == null ? null : String(body.scheduledAt),
    location: body.location == null ? null : String(body.location),
  };

  // 发起活动会（可能）新建群并写全局活动表：统一走群锁（key g:0）串行化
  const res = await withGroupLock(0, async () => createActivity(input));
  if (!res.ok || !res.activity) {
    return Response.json(
      { ok: false, code: res.code, error: res.error, max: GROUP_MAX_MEMBERS },
      { status: activityHttpStatus(res.code) }
    );
  }
  return Response.json({ ok: true, id: Number(res.activity.id), activity: res.activity });
}
