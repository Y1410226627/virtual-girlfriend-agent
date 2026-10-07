// 伴侣资料页：GET 聚合；PATCH 攻略/暂不/改名/资料；DELETE 删除
import { withCompanion } from '@/lib/companion-context';
import {
  profilePage,
  optOut,
  pursueOptIn,
  getCompanion,
  deleteCompanion,
  httpStatusForCode,
} from '@/lib/companion';
import { setPersonaField } from '@/lib/relationship';
import { dbRun } from '@/lib/db';
import { nowIso } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function parseId(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  const { id } = await ctx.params;
  const n = Math.trunc(Number(id));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function notFound() {
  return Response.json({ ok: false, code: 'COMPANION_NOT_FOUND', error: '伴侣不存在' }, { status: 404 });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = await parseId(ctx);
  if (!id) return notFound();
  return withCompanion(id, () => {
    const profile = profilePage(id);
    if (!profile.companion) return notFound();
    return Response.json(profile);
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = await parseId(ctx);
  if (!id) return notFound();
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = String(body?.action ?? '');
  return withCompanion(id, () => {
    if (!getCompanion(id)) return notFound();

    if (action === 'pursue') {
      const r = pursueOptIn(id);
      return r.ok
        ? Response.json({ ok: true, companion: r.companion })
        : Response.json({ ok: false, code: r.code, error: r.error }, { status: httpStatusForCode(r.code) });
    }

    if (action === 'opt_out') {
      const r = optOut(id);
      return r.ok
        ? Response.json({ ok: true, companion: r.companion })
        : Response.json({ ok: false, code: r.code, error: r.error }, { status: httpStatusForCode(r.code) });
    }

    if (action === 'rename') {
      const name = String(body?.name ?? '').trim().slice(0, 24);
      if (!name) return Response.json({ error: '名字不能为空' }, { status: 400 });
      dbRun('UPDATE companions SET name = ?, updated_at = ? WHERE id = ?', name, nowIso(), id);
      return Response.json({ ok: true, companion: getCompanion(id) });
    }

    if (action === 'set_persona') {
      if (body?.agent_name !== undefined) setPersonaField('agent_name', String(body.agent_name));
      if (body?.age !== undefined) setPersonaField('age', String(body.age));
      if (body?.occupation !== undefined) setPersonaField('occupation', String(body.occupation));
      if (body?.self_story !== undefined) setPersonaField('self_story', String(body.self_story));
      return Response.json({ ok: true, companion: getCompanion(id) });
    }

    return Response.json({ error: '未知操作' }, { status: 400 });
  });
}

/** 防御别名：状态操作历史上曾被前端误用 POST 调用（405）。接受 POST 与 PATCH 等价，避免方法错配再次炸出 405。 */
export const POST = PATCH;

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = await parseId(ctx);
  if (!id) return notFound();
  return withCompanion(id, () => {
    const r = deleteCompanion(id);
    if (!r.ok) return Response.json({ ok: false, code: r.code, error: r.error }, { status: httpStatusForCode(r.code) });
    return Response.json({ ok: true });
  });
}
