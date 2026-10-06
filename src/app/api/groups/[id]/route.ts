// 群配置：GET 群配置 + 成员 + 消息；PATCH 改名/话题/成员；DELETE 解散
import { withGroupLock } from '@/lib/group-run';
import { getGroupDetail, updateGroup, deleteGroup, groupHttpStatus } from '@/lib/group';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function parseId(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  const { id } = await ctx.params;
  const n = Math.trunc(Number(id));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function notFound() {
  return Response.json({ ok: false, code: 'GROUP_NOT_FOUND', error: '群不存在' }, { status: 404 });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gid = await parseId(ctx);
  if (!gid) return notFound();
  const detail = getGroupDetail(gid);
  if (!detail) return notFound();
  return Response.json({
    ok: true,
    group: detail.group,
    memberIds: detail.memberIds,
    members: detail.members,
    messages: detail.messages,
    run: detail.run,
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gid = await parseId(ctx);
  if (!gid) return notFound();
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const patch: { name?: string; topic?: string | null; add?: number[]; remove?: number[] } = {};
  if (body.name !== undefined) patch.name = String(body.name);
  if (body.topic !== undefined) patch.topic = body.topic == null ? null : String(body.topic);
  if (Array.isArray(body.add)) patch.add = (body.add as unknown[]).map((x) => Math.trunc(Number(x)));
  if (Array.isArray(body.remove)) patch.remove = (body.remove as unknown[]).map((x) => Math.trunc(Number(x)));

  const res = await withGroupLock(gid, async () => updateGroup(gid, patch));
  if (!res.ok) {
    return Response.json({ ok: false, code: res.code, error: res.error }, { status: groupHttpStatus(res.code) });
  }
  const detail = getGroupDetail(gid);
  return Response.json({ ok: true, group: res.group, members: detail?.members ?? [] });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gid = await parseId(ctx);
  if (!gid) return notFound();
  const res = await withGroupLock(gid, async () => deleteGroup(gid));
  if (!res.ok) {
    return Response.json({ ok: false, code: res.code, error: res.error }, { status: groupHttpStatus(res.code) });
  }
  return Response.json({ ok: true });
}
