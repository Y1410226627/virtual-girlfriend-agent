// 依恋系统：状态 / 日志 / 曲线 / 手动调整
import { getAttachmentState, listAttachmentLogs, attachmentEvolution, attachmentPromptBlock, runAttachmentLayer } from '@/lib/attachment';
import { setAttachmentAxes } from '@/lib/attachment';
import { cAll } from '@/lib/db';
import { ATTACHMENT_STYLES, attachmentStyleOf } from '@/lib/types';
import { round1, clamp } from '@/lib/utils';
import { getPersonalityRows } from '@/lib/personality';
import { withRequestCompanion } from '@/lib/companion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** attachment_signals 未应用信号的分组统计列 */
interface PendingSignalRow {
  axis: string;
  direction: string;
  c: number;
}

export async function GET(req: Request) {
  // T02 收尾 D2：按请求所指伴侣读取依恋
  return withRequestCompanion(req, () => {
  const a = getAttachmentState();
  const pending = cAll<PendingSignalRow>(
    'SELECT axis, direction, COUNT(*) AS c FROM attachment_signals WHERE companion_id = ? AND applied = 0 GROUP BY axis, direction'
  );
  return Response.json({
    state: {
      ...a,
      anxiety: round1(a.anxiety),
      avoidance: round1(a.avoidance),
      styleLabel: ATTACHMENT_STYLES[attachmentStyleOf(Number(a.anxiety), Number(a.avoidance))],
    },
    styleMeaning: attachmentPromptBlock(),
    logs: listAttachmentLogs(80),
    series: attachmentEvolution(),
    pendingSignals: pending.map((p) => ({ axis: p.axis, direction: p.direction, count: Number(p.c) })),
    personality: getPersonalityRows(),
  });
  });
}

export async function POST(req: Request) {
  return withRequestCompanion(req, async () => {
  const body = await req.json().catch(() => ({}));
  if (body?.action === 'adjust') {
    const anxiety = body.anxiety;
    const avoidance = body.avoidance;
    if (
      typeof anxiety !== 'number' || typeof avoidance !== 'number' ||
      !isFinite(anxiety) || !isFinite(avoidance)
    ) return Response.json({ error: '参数错误' }, { status: 400 });
    setAttachmentAxes(
      clamp(anxiety, 0, 100),
      clamp(avoidance, 0, 100),
      '用户手动调整',
      String(body.reason || '用户在依恋页手动微调').slice(0, 120)
    );
    return Response.json({ ok: true });
  }
  if (body?.action === 'run') {
    runAttachmentLayer();
    return Response.json({ ok: true, state: getAttachmentState() });
  }
  return Response.json({ error: '未知操作' }, { status: 400 });
  });
}