// 每日摘要：查看 / 手动生成
import { listDailySummaries } from '@/lib/memory';
import { maybeGenerateDailySummary } from '@/lib/analysis';
import { errMsg } from '@/lib/utils';
import { withRequestCompanion } from '@/lib/companion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  // T02 收尾 D2：按请求所指伴侣读取摘要
  return withRequestCompanion(req, () => {
    try {
      return Response.json({ summaries: listDailySummaries(60) });
    } catch (e) {
      return Response.json({ error: errMsg(e) }, { status: 500 });
    }
  });
}

export async function POST(req: Request) {
  return withRequestCompanion(req, async () => {
    try {
      const summary = await maybeGenerateDailySummary(true);
      return Response.json({ ok: true, summary, summaries: listDailySummaries(60) });
    } catch (e) {
      return Response.json({ error: errMsg(e) }, { status: 500 });
    }
  });
}
