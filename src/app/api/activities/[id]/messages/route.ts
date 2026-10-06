// 活动内发言：POST 用户发言 + 触发互动（复用群聊引擎）。
// 支持 JSON（整批返回）与 SSE（逐条推送 type: message / done / error）。
//
// - 线上活动：等同群聊一轮（多角色按调度发言）。
// - 线下活动：runActivityTurn 会强制 mentions=[焦点]，让「只让焦点一人发言」，避免多角色抢话。
import { withGroupLock } from '@/lib/group-run';
import { getActivity, runActivityTurn, activityHttpStatus } from '@/lib/activity';
import { errMsg } from '@/lib/utils';
import type { GroupTurnResult } from '@/lib/group';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function parseId(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  const { id } = await ctx.params;
  const n = Math.trunc(Number(id));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function notFound() {
  return Response.json({ ok: false, code: 'ACTIVITY_NOT_FOUND', error: '活动不存在' }, { status: 404 });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const aid = await parseId(ctx);
  if (!aid) return notFound();
  const activity = getActivity(aid);
  if (!activity) return notFound();
  const groupId = activity.group_id == null ? 0 : Number(activity.group_id);
  if (!groupId) {
    return Response.json({ ok: false, code: 'GROUP_NOT_FOUND', error: '活动没有关联的群' }, { status: 404 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const content = String(body.content ?? '');
  const mentions = Array.isArray(body.mentions) ? (body.mentions as unknown[]).map((x) => Math.trunc(Number(x))) : undefined;
  const cont = body.continue === true;
  const wantStream = body.stream === true || (req.headers.get('accept') || '').includes('text/event-stream');

  // ---- JSON 模式 ----
  if (!wantStream) {
    const result = await withGroupLock(groupId, () => runActivityTurn(aid, content, { mentions, newRun: cont }));
    const status = result.ok ? 200 : activityHttpStatus(result.code);
    return Response.json(result, { status });
  }

  // ---- SSE 模式 ----
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>): void => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* 客户端已断开 */
        }
      };
      try {
        const result: GroupTurnResult = await withGroupLock(groupId, () =>
          runActivityTurn(aid, content, {
            mentions,
            newRun: cont,
            onMessage: (m) => send({ type: 'message', message: m }),
          })
        );
        if (!result.ok) send({ type: 'error', code: result.code, message: result.error });
        send({ type: 'done', ended: result.ended, endedReason: result.endedReason ?? null, run: result.run, code: result.code ?? null });
      } catch (e) {
        send({ type: 'error', message: errMsg(e) });
        send({ type: 'done', ended: false, endedReason: null, run: null, code: 'EXCEPTION' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
