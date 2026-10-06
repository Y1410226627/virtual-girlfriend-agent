// 攻略动作：POST 推进(advance) / 表白晋升确认(confess|promote)
import { withCompanion } from '@/lib/companion-context';
import { confess, getCompanion, httpStatusForCode } from '@/lib/companion';
import { checkAdvance } from '@/lib/pursuit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function parseId(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  const { id } = await ctx.params;
  const n = Math.trunc(Number(id));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = await parseId(ctx);
  if (!id) return Response.json({ ok: false, code: 'COMPANION_NOT_FOUND', error: '伴侣不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = String(body?.action ?? 'advance');
  return withCompanion(id, () => {
    const row = getCompanion(id);
    if (!row) return Response.json({ ok: false, code: 'COMPANION_NOT_FOUND', error: '伴侣不存在' }, { status: 404 });

    if (action === 'advance') {
      const turnRaw = Number(body?.turn);
      const turn = Number.isFinite(turnRaw) && turnRaw > 0 ? Math.trunc(turnRaw) : 0;
      const res = checkAdvance(id, turn);
      return Response.json({ ok: true, ...(res ?? { status: row.status, from: row.status, changed: false }) });
    }

    if (action === 'confess' || action === 'promote') {
      const out = confess(id);
      if (!out.ok) {
        return Response.json({ ok: false, code: out.code, error: '伴侣不存在' }, { status: httpStatusForCode(out.code) });
      }
      // 冷却期屏蔽表白（语义错误码）；其它情况以 accepted 表达结果
      if (out.code === 'PURSUIT_REJECTED_COOLDOWN') {
        return Response.json(
          { ok: false, code: out.code, error: '她刚拒绝过，24 小时冷却期内不适合再表白', status: out.status, cooldown_until: out.cooldown_until },
          { status: httpStatusForCode(out.code) }
        );
      }
      return Response.json({
        ok: true,
        accepted: out.accepted,
        code: out.code,
        status: out.status,
        reject_count: out.reject_count,
        cooldown_until: out.cooldown_until,
        companion: out.companion,
      });
    }

    return Response.json({ error: '未知操作' }, { status: 400 });
  });
}
