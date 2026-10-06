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
import { tx } from '@/lib/db';
import { withRequestCompanion } from '@/lib/companion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  // T02 收尾 D2：按请求所指伴侣读取性格
  return withRequestCompanion(req, () => {
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
  });
}

export async function POST(req: Request) {
  return withRequestCompanion(req, async () => {
  const body = await req.json().catch(() => ({}));
  const action = body?.action;

  if (action === 'adjust') {
    const dim = String(body.dimension || '');
    const value = body.value;
    if (!DIMENSIONS.some((d) => d.key === dim) || typeof value !== 'number' || !isFinite(value)) {
      return Response.json({ error: '参数错误' }, { status: 400 });
    }
    manualAdjust(dim, value, body.reason ? String(body.reason) : '用户在性格页手动微调');
    return Response.json({ ok: true, dimension: dim, label: dimensionLabel(dim), value });
  }
  if (action === 'unsolidify') {
    const dim = String(body.dimension || '');
    if (!DIMENSIONS.some((d) => d.key === dim)) return Response.json({ error: '参数错误' }, { status: 400 });
    unsolidify(dim);
    return Response.json({ ok: true });
  }
  if (action === 'snapshot') {
    saveWeeklySnapshot();
    return Response.json({ ok: true, snapshots: listSnapshots(20) });
  }
  if (action === 'rollback') {
    const snapshotId = Number(body.snapshotId);
    if (!Number.isInteger(snapshotId)) return Response.json({ error: '参数错误' }, { status: 400 });
    // 回滚内部逐维度调 manualAdjust，用事务包住避免半写入
    const ok = tx(() => rollbackToSnapshot(snapshotId));
    return Response.json({ ok });
  }
  return Response.json({ error: '未知操作' }, { status: 400 });
  });
}