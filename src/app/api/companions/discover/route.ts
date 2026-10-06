// 发现区：POST 生成一名候选人（LLM + 模板兜底；去重；待处理上限 3）
import { withCompanion } from '@/lib/companion-context';
import { resolveCompanionId, httpStatusForCode } from '@/lib/companion';
import { generateCandidate } from '@/lib/candidate-gen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const id = resolveCompanionId(req);
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  return withCompanion(id, async () => {
    const res = await generateCandidate({
      seed: body?.seed ? String(body.seed) : undefined,
      forceTemplate: body?.forceTemplate === true,
    });
    if (!res.ok) {
      return Response.json({ ok: false, code: res.code, error: res.error }, { status: httpStatusForCode(res.code) });
    }
    return Response.json({ ok: true, candidate: res.draft, row: res.row, source: res.source });
  });
}
