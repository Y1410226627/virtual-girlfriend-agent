// 发现区：POST 生成一名候选人。三条来源：
//   ① mode='cast'  —— 从「她身边的人」（shared_world.cast_json）升格：你见到了她的室友/同事/朋友
//   ② mode='auto'  —— 交往中自动识别：她反复提到的人自动浮现为可攻略对象（确定性文本扫描）
//   ③ mode='random'（缺省）—— 陌生人随机生成（次要来源）
// 无数量上限：待处理候选人可无限累积（UI 侧分页/折叠）。
import { withCompanion } from '@/lib/companion-context';
import { resolveCompanionId, httpStatusForCode, getCompanion, displayNameOf } from '@/lib/companion';
import { generateCandidate, generateCandidateFromCast, autoDiscoverFromMentions } from '@/lib/candidate-gen';
import { getCast } from '@/lib/life-shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const id = resolveCompanionId(req);
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const mode = String(body?.mode || 'random');
  const forceTemplate = body?.forceTemplate === true;

  return withCompanion(id, async () => {
    // ② 自动识别：扫描她最近提到过的人，浮现为候选
    if (mode === 'auto') {
      const ownerName = displayNameOf(id, '她');
      const r = await autoDiscoverFromMentions(id, { ownerName, forceTemplate });
      return Response.json({ ok: true, mode, created: r.created, skipped: r.skipped });
    }

    // ① 她的身边人升格
    if (mode === 'cast') {
      const cast = getCast();
      if (!cast.length) {
        return Response.json(
          { ok: false, code: 'NO_CAST', error: '她身边暂时没有可认识的人' },
          { status: 400 }
        );
      }
      const want = body?.castName ? String(body.castName).trim() : '';
      const member = want ? cast.find((c) => String(c.name).trim() === want) : cast[0];
      if (!member) {
        return Response.json(
          { ok: false, code: 'CAST_NOT_FOUND', error: `她的身边没有叫「${want}」的人`, candidates: cast },
          { status: 404 }
        );
      }
      const ownerName = displayNameOf(id, '她');
      const res = await generateCandidateFromCast(id, member, { ownerName, forceTemplate });
      if (!res.ok) {
        return Response.json({ ok: false, code: res.code, error: res.error }, { status: httpStatusForCode(res.code) });
      }
      return Response.json({
        ok: true,
        mode,
        candidate: res.draft,
        row: res.row,
        source: res.source,
        origin: { kind: 'cast', from: ownerName, role: member.role },
      });
    }

    // ③ 陌生人
    const res = await generateCandidate({
      seed: body?.seed ? String(body.seed) : undefined,
      forceTemplate,
    });
    if (!res.ok) {
      return Response.json({ ok: false, code: res.code, error: res.error }, { status: httpStatusForCode(res.code) });
    }
    return Response.json({ ok: true, mode: 'random', candidate: res.draft, row: res.row, source: res.source });
  });
}

/** GET：列出「她身边的人」中**尚未成为候选/伴侣**的可认识对象（UI 用来展示"你也许见过这些人"） */
export async function GET(req: Request) {
  const id = resolveCompanionId(req);
  return withCompanion(id, () => {
    const cast = getCast();
    return Response.json({ ok: true, cast, owner: getCompanion(id)?.name ?? null });
  });
}
