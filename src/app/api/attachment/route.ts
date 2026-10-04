// 依恋系统：状态 / 日志 / 曲线 / 手动调整
import { getAttachmentState, listAttachmentLogs, attachmentEvolution, attachmentPromptBlock, runAttachmentLayer } from '@/lib/attachment';
import { setAttachmentAxes } from '@/lib/attachment';
import { dbAll, DEFAULT_USER_ID } from '@/lib/db';
import { ATTACHMENT_STYLES, attachmentStyleOf } from '@/lib/types';
import { round1 } from '@/lib/utils';
import { getPersonalityRows } from '@/lib/personality';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const a = getAttachmentState();
  const pending = dbAll<any>(
    'SELECT axis, direction, COUNT(*) AS c FROM attachment_signals WHERE user_id = ? AND applied = 0 GROUP BY axis, direction',
    DEFAULT_USER_ID
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
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (body?.action === 'adjust') {
    const anxiety = Number(body.anxiety);
    const avoidance = Number(body.avoidance);
    if (!isFinite(anxiety) || !isFinite(avoidance)) return Response.json({ error: '参数错误' }, { status: 400 });
    setAttachmentAxes(anxiety, avoidance, '用户手动调整', String(body.reason || '用户在依恋页手动微调'));
    return Response.json({ ok: true });
  }
  if (body?.action === 'run') {
    runAttachmentLayer();
    return Response.json({ ok: true, state: getAttachmentState() });
  }
  return Response.json({ error: '未知操作' }, { status: 400 });
}