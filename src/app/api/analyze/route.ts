// 后台分析接口：入队即返回（不阻塞聊天），前端轮询 GET 看进度
import { enqueueAnalysis, analysisQueueStatus } from '@/lib/analysisQueue';
import { getRelationshipState } from '@/lib/relationship';
import { getAttachmentState, attachmentStyle } from '@/lib/attachment';
import { personalityMap } from '@/lib/personality';
import { ATTACHMENT_STYLES } from '@/lib/types';
import { round1 } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 当前状态快照（给前端提示用） */
function snapshot() {
  const rel = getRelationshipState();
  const att = getAttachmentState();
  return {
    mood: rel.mood,
    stage: rel.stage,
    intimacy: round1(rel.intimacy),
    emotional_balance: round1(rel.emotional_balance),
    unresolved_tension: round1(rel.unresolved_tension),
    repair_credit: round1(rel.repair_credit),
    conflict_state: rel.conflict_state,
    attachment_style: ATTACHMENT_STYLES[attachmentStyle()] || attachmentStyle(),
    anxiety: round1(att.anxiety),
    avoidance: round1(att.avoidance),
    personality: personalityMap(),
  };
}

export async function GET() {
  const st = analysisQueueStatus();
  return Response.json({ ...st, updated: snapshot() });
}

export async function POST(req: Request) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: '无效请求' }, { status: 400 });
  }
  const { userMessage, assistantMessage, userMessageId, assistantMessageId } = body || {};
  if (!assistantMessage) return Response.json({ error: '缺少对话内容' }, { status: 400 });

  // 关键：入队后立刻返回，分析在后台按顺序执行
  const { pending } = enqueueAnalysis({
    userMessage: String(userMessage || ''),
    assistantMessage: String(assistantMessage || ''),
    userMessageId: userMessageId ?? null,
    assistantMessageId: assistantMessageId ?? null,
  });

  return Response.json({ queued: true, pending: pending + (analysisQueueStatus().running ? 1 : 0) });
}