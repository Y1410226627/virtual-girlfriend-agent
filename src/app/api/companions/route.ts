// 通讯录：GET 列表（按 status 分组 + 未读角标 + 待处理发现区）；POST 创建/手动认识
import { withCompanion } from '@/lib/companion-context';
import { listRoster, createCompanion, resolveCompanionId, httpStatusForCode } from '@/lib/companion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const id = resolveCompanionId(req);
  return withCompanion(id, () => Response.json(listRoster()));
}

export async function POST(req: Request) {
  const id = resolveCompanionId(req);
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  return withCompanion(id, () => {
    const res = createCompanion({
      name: String(body?.name ?? ''),
      age: Number(body?.age),
      gender: body?.gender ? String(body.gender) : undefined,
      identity: body?.identity ? String(body.identity) : undefined,
      personality_tags: Array.isArray(body?.personality_tags) ? (body.personality_tags as unknown[]).map(String) : undefined,
      portrait_desc: body?.portrait_desc ? String(body.portrait_desc) : undefined,
      intro: body?.intro ? String(body.intro) : undefined,
      first_meet_scene: body?.first_meet_scene ? String(body.first_meet_scene) : undefined,
      gen_seed: body?.gen_seed ? String(body.gen_seed) : undefined,
      pursue: body?.pursue === true,
    });
    if (!res.ok) {
      return Response.json({ ok: false, code: res.code, error: res.error }, { status: httpStatusForCode(res.code) });
    }
    return Response.json({ ok: true, companion: res.companion });
  });
}
