// 群聊：GET 群列表；POST 建群（2–6 名已晋升女友）
import { withGroupLock } from '@/lib/group-run';
import { listGroups, createGroup, groupHttpStatus, GROUP_MAX_MEMBERS } from '@/lib/group';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const groups = listGroups().map((g) => ({
    id: g.group.id,
    name: g.group.name,
    topic: g.group.topic,
    status: g.group.status,
    last_message_at: g.group.last_message_at,
    created_at: g.group.created_at,
    memberIds: g.memberIds,
    memberNames: g.memberNames,
    lastMessageId: g.lastMessageId,
  }));
  return Response.json({ ok: true, groups });
}

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const name = String(body.name ?? '');
  const topic = body.topic == null ? null : String(body.topic);
  const memberIds = Array.isArray(body.memberIds) ? (body.memberIds as unknown[]).map((x) => Math.trunc(Number(x))) : [];
  // 建群本身互不共享状态，但仍走群锁（key g:0）以符合"所有写操作走 withGroupLock"的约定
  const res = await withGroupLock(0, async () => createGroup(name, topic, memberIds));
  if (!res.ok || !res.group) {
    return Response.json(
      { ok: false, code: res.code, error: res.error, max: GROUP_MAX_MEMBERS },
      { status: groupHttpStatus(res.code) }
    );
  }
  return Response.json({ ok: true, id: res.group.id, group: res.group });
}
