// 同场感知 API（v16）：
//   GET  ?hostId=（缺省当前伴侣）→ { ok, cohabitants: [...] }
//   POST { hostId?, member: { kind:'cast', name } | { kind:'companion', id } }
//        → ensurePresenceGroup → { ok, groupId, created|reused, memberId }
//   POST { action:'end', groupId } → endPresenceGroup → { ok, memoriesWritten }
// 全部在 withRequestCompanion / withCompanion 作用域内执行，伴侣域读取自动落到正确伴侣。
import { withRequestCompanion, resolveCompanionId, getCompanion } from '@/lib/companion';
import {
  detectCohabitants,
  ensurePresenceGroup,
  endPresenceGroup,
  activePresenceGroupId,
  type PresenceMemberInput,
} from '@/lib/presence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function hostIdFrom(req: Request, body: Record<string, unknown>): number {
  const url = new URL(req.url);
  const raw = body.hostId ?? url.searchParams.get('hostId');
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : resolveCompanionId(req);
}

export async function GET(req: Request) {
  return withRequestCompanion(req, () => {
    const url = new URL(req.url);
    const rawHost = url.searchParams.get('hostId');
    const hostId = rawHost ? Math.trunc(Number(rawHost)) : resolveCompanionId(req);
    if (!Number.isFinite(hostId) || hostId <= 0 || !getCompanion(hostId)) {
      return Response.json({ ok: false, code: 'COMPANION_NOT_FOUND', error: '主伴侣不存在' }, { status: 404 });
    }
    return Response.json({
      ok: true,
      hostId,
      cohabitants: detectCohabitants(hostId),
      activeGroupId: activePresenceGroupId(hostId),
    });
  });
}

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return withRequestCompanion(req, async () => {
    const hostId = hostIdFrom(req, body);

    // 结束共处群：{ action:'end', groupId }
    if (String(body.action ?? '') === 'end') {
      const groupId = Math.trunc(Number(body.groupId));
      const res = await endPresenceGroup(groupId);
      if (!res.ok) return Response.json(res, { status: 404 });
      return Response.json(res);
    }

    // 开启/复用共处群：{ hostId?, member }
    const rawMember = body.member;
    if (!rawMember || typeof rawMember !== 'object') {
      return Response.json({ ok: false, code: 'INVALID_INPUT', error: '缺少 member' }, { status: 400 });
    }
    const m = rawMember as Record<string, unknown>;
    const kind = String(m.kind ?? '') === 'companion' ? 'companion' : 'cast';
    const member: PresenceMemberInput = {
      kind,
      id: kind === 'companion' ? Math.trunc(Number(m.id)) : undefined,
      name: kind === 'cast' ? String(m.name ?? '') : undefined,
      role: m.role == null ? undefined : String(m.role),
      note: m.note == null ? undefined : String(m.note),
    };
    const res = await ensurePresenceGroup(hostId, member);
    if (!res.ok) {
      const status =
        res.code === 'COMPANION_NOT_FOUND' || res.code === 'GROUP_NOT_FOUND'
          ? 404
          : res.code === 'COMPANION_CLOSED'
            ? 410
            : 400;
      return Response.json(res, { status });
    }
    return Response.json({ ...res, reused: res.created === false });
  });
}
