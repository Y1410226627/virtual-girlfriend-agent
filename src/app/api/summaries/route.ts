// 每日摘要：查看 / 手动生成
import { listDailySummaries } from '@/lib/memory';
import { maybeGenerateDailySummary } from '@/lib/analysis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return Response.json({ summaries: listDailySummaries(60) });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export async function POST() {
  try {
    const summary = await maybeGenerateDailySummary(true);
    return Response.json({ ok: true, summary, summaries: listDailySummaries(60) });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}