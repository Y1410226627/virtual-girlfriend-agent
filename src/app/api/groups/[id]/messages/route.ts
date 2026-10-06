// 群发言：POST 用户发言 + 触发发言调度。
// 支持 JSON（整批返回）与 SSE（逐条推送 type: message / done / error）。
import { withGroupLock } from '@/lib/group-run';
import { runGroupTurn, groupHttpStatus, type GroupTurnResult } from '@/lib/group';
import { errMsg } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function parseId(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  const { id } = await ctx.params;
  const n = Math.trunc(Number(id));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gid = await parseId(ctx);
  if (!gid) {
    return Response.json({ ok: false, code: 'GROUP_NOT_FOUND', error: '群不存在' }, { status: 404 });
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
    const result = await withGroupLock(gid, () => runGroupTurn(gid, content, { mentions, newRun: cont }));
    const status = result.ok ? 200 : groupHttpStatus(result.code);
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
        const result: GroupTurnResult = await withGroupLock(gid, () =>
          runGroupTurn(gid, content, {
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
