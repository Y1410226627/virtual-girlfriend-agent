// 聊天接口（流式 SSE）
import { prepareTurn, saveAssistantMessage, chatStream } from '@/lib/engine';
import { chat } from '@/lib/llm';
import { humanizeReply } from '@/lib/humanize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: '无效请求' }, { status: 400 });
  }
  const content = String(body?.content || '').trim();
  if (!content) return Response.json({ error: '消息不能为空' }, { status: 400 });

  let prepared;
  try {
    prepared = await prepareTurn(content);
  } catch (e: any) {
    return Response.json({ error: `准备上下文失败：${e?.message || e}` }, { status: 500 });
  }

  const encoder = new TextEncoder();
  let full = '';

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* 客户端已断开 */
        }
      };
      try {
        send({ type: 'start', userMessageId: prepared.userMessageId });
        await chatStream(
          prepared.messages,
          (t) => {
            full += t;
            send({ type: 'delta', text: t });
          },
          { maxTokens: 1200, temperature: 0.9, thinking: false }
        );

        // 兜底一：模型什么都没产出（换成笨模型时常见）→ 追加一次更明确的指令重试
        if (!full.trim()) {
          const retry = await chat(
            [
              ...prepared.messages,
              {
                role: 'user',
                content: '（直接说出你此刻想说的 1-3 句话，口语、短句，带上一个括号里的神态或动作，不要解释、不要拒绝）',
              },
            ],
            { maxTokens: 400, temperature: 0.95, thinking: false }
          );
          if (String(retry || '').trim()) {
            full = retry;
            send({ type: 'delta', text: retry });
          }
        }

        // 兜底二：人味层（清洗 AI 腔 / 控制长度 / 补神态动作 / 空回复用兜底台词）
        const h = humanizeReply(full, prepared.humanize);
        const assistantMessageId = saveAssistantMessage(h.text);
        send({
          type: 'final',
          text: h.text,
          addedAction: h.addedAction,
          notes: h.notes.slice(0, 3),
        });
        send({ type: 'done', assistantMessageId, userMessageId: prepared.userMessageId, fullText: h.text });
      } catch (e: any) {
        send({ type: 'error', message: e?.message || String(e) });
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