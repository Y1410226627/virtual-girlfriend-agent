// 性格系统：状态 / 演化曲线 / 日志 / 手动微调 / 固化 / 快照回滚 / 累积层进度
import {
  getPersonalityRows,
  listPersonalityLogs,
  evolutionSeries,
  listSnapshots,
  signalProgress,
  manualAdjust,
  unsolidify,
  saveWeeklySnapshot,
  rollbackToSnapshot,
  personalityMap,
  dimensionLabel,
} from '@/lib/personality';
import { getRelationshipState } from '@/lib/relationship';
import { getAttachmentState } from '@/lib/attachment';
import { DIMENSIONS } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const rows = getPersonalityRows();
  const state = DIMENSIONS.map((d) => {
    const row = rows.find((r) => r.dimension === d.key);
    return {
      key: d.key,
      label: d.label,
      desc: d.desc,
      value: Math.round(Number(row?.value ?? 50) * 10) / 10,
      solidified: Number(row?.solidified || 0) === 1,
      lastAdjustedTurn: Number(row?.last_adjusted_turn || 0),
      updatedAt: row?.updated_at || null,
    };
  });
  return Response.json({
    state,
    values: personalityMap(),
    logs: listPersonalityLogs(120),
    series: evolutionSeries(),
    snapshots: listSnapshots(20),
    signals: signalProgress(),
    stage: getRelationshipState().stage,
    attachment: getAttachmentState(),
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = body?.action;

  if (action === 'adjust') {
    const dim = String(body.dimension || '');
    const value = Number(body.value);
    if (!dim || !isFinite(value)) return Response.json({ error: '参数错误' }, { status: 400 });
    manualAdjust(dim, value, body.reason ? String(body.reason) : '用户在性格页手动微调');
    return Response.json({ ok: true, dimension: dim, label: dimensionLabel(dim), value });
  }
  if (action === 'unsolidify') {
    unsolidify(String(body.dimension || ''));
    return Response.json({ ok: true });
  }
  if (action === 'snapshot') {
    saveWeeklySnapshot();
    return Response.json({ ok: true, snapshots: listSnapshots(20) });
  }
  if (action === 'rollback') {
    const ok = rollbackToSnapshot(Number(body.snapshotId));
    return Response.json({ ok });
  }
  return Response.json({ error: '未知操作' }, { status: 400 });
}