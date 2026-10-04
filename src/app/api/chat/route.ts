// 聊天接口（流式 SSE）
import {
  prepareTurn,
  saveAssistantMessage,
  deleteMessageById,
  chatStream,
  getLastMessage,
  getLastUserMessageBefore,
  deleteProactiveMessagesByMessageId,
  type PreparedTurn,
} from '@/lib/engine';
import { chat } from '@/lib/llm';
import { humanizeReply } from '@/lib/humanize';
import { detectEventFromConversation } from '@/lib/life';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: '无效请求' }, { status: 400 });
  }

  // 重新生成：删掉她最后一条回复，用前面的用户消息重跑一遍生成（不重复保存用户消息）
  if (body?.regenerate === true) {
    const last = getLastMessage();
    if (!last || last.role !== 'assistant') {
      return Response.json({ error: '最后一条不是她的消息，无法重新生成' }, { status: 400 });
    }
    const userMsg = getLastUserMessageBefore(last.id);
    if (!userMsg) {
      return Response.json({ error: '没有可用的用户消息，无法重新生成' }, { status: 400 });
    }
    // 只删她这一条（不走级联撤销），以及引用它的主动消息记录
    deleteMessageById(last.id);
    deleteProactiveMessagesByMessageId(last.id);

    const content = String(userMsg.content || '');
    let prepared: PreparedTurn;
    try {
      prepared = await prepareTurn(content, { insertUserMessage: false, userMessageId: userMsg.id });
    } catch (e: any) {
      return Response.json({ error: `准备上下文失败：${e?.message || e}` }, { status: 500 });
    }
    // 重新生成失败时不能把他那条用户消息删掉
    return buildChatStream(req, prepared, content, { cleanupUserOnError: false });
  }

  const content = String(body?.content || '').trim();
  if (!content) return Response.json({ error: '消息不能为空' }, { status: 400 });
  if (content.length > 4000) return Response.json({ error: '消息太长了（最多 4000 字）' }, { status: 400 });

  let prepared: PreparedTurn;
  try {
    prepared = await prepareTurn(content);
  } catch (e: any) {
    return Response.json({ error: `准备上下文失败：${e?.message || e}` }, { status: 500 });
  }

  return buildChatStream(req, prepared, content, { cleanupUserOnError: true });
}

/** 生成 + 流式返回（正常回复与重新生成共用同一套协议：delta/final/done/error） */
function buildChatStream(
  req: Request,
  prepared: PreparedTurn,
  content: string,
  opts: { cleanupUserOnError: boolean }
): Response {
  const encoder = new TextEncoder();
  let full = '';
  let assistantSaved = false;
  let assistantMessageId: number | null = null;
  const ac = new AbortController();
  req.signal?.addEventListener?.('abort', () => ac.abort());

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
          { maxTokens: 1200, temperature: 0.9, thinking: false, signal: ac.signal }
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
        assistantMessageId = saveAssistantMessage(h.text);
        assistantSaved = true;
        // 规则兜底：她话里明确说了"我睡了/我去洗澡/我去吃饭…" → 立刻登记可控事件
        try {
          detectEventFromConversation(content, h.text);
        } catch {
          /* 登记失败不影响聊天 */
        }
        send({
          type: 'final',
          text: h.text,
          addedAction: h.addedAction,
          notes: h.notes.slice(0, 3),
        });
        send({ type: 'done', assistantMessageId, userMessageId: prepared.userMessageId, fullText: h.text });
      } catch (e: any) {
        // 整轮失败：把刚落库的用户消息撤掉，避免刷新后"复活"一条没人回应的消息
        // （重新生成时不能删，那是他之前发的那条）
        if (!assistantSaved && opts.cleanupUserOnError && prepared.userMessageId) {
          try {
            deleteMessageById(Number(prepared.userMessageId));
          } catch {
            /* 删除失败不影响错误上报 */
          }
        }
        send({ type: 'error', message: e?.message || String(e) });
        send({ type: 'done', assistantMessageId, userMessageId: prepared.userMessageId, fullText: full });
      } finally {
        controller.close();
      }
    },
    cancel() {
      ac.abort();
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