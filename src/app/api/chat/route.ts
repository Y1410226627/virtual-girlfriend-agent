// 聊天接口（流式 SSE）
import {
  prepareTurn,
  commitTurn,
  saveAssistantMessage,
  deleteMessageById,
  chatStream,
  getLastMessage,
  getLastUserMessageBefore,
  deleteProactiveMessagesByMessageId,
  type PreparedTurn,
} from '@/lib/engine';
import { chat, cleanContent } from '@/lib/llm';
import { humanizeReply } from '@/lib/humanize';
import { validateReply, RETRY_SCORE_THRESHOLD } from '@/lib/reply-validator';
import { detectEventFromConversation } from '@/lib/life';
import { errMsg } from '@/lib/utils';
import { DEFAULT_USER_ID } from '@/lib/db';
import {
  withConversationLock,
  createTurn,
  beginGeneration,
  completeGeneration,
  failGeneration,
  supersedeGeneration,
  cancelTurn,
  getTurnByUserMessageId,
  currentGenerationForTurn,
  generationByAssistantMessageId,
} from '@/lib/turn';
import { enqueueAnalysis } from '@/lib/analysisQueue';
import { rollbackOperationsForGeneration } from '@/lib/turnOps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 请求体：regenerate=重新生成；content=用户消息 */
type ReqBody = { regenerate?: boolean; content?: string };

export async function POST(req: Request) {
  let body: ReqBody = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: '无效请求' }, { status: 400 });
  }

  // 重新生成：删掉她最后一条回复，用前面的用户消息重跑一遍生成（不重复保存用户消息）
  if (body?.regenerate === true) {
    return buildChatStream(req, { regenerate: true, content: '' });
  }

  const content = String(body?.content || '').trim();
  if (!content) return Response.json({ error: '消息不能为空' }, { status: 400 });
  if (content.length > 4000) return Response.json({ error: '消息太长了（最多 4000 字）' }, { status: 400 });

  return buildChatStream(req, { regenerate: false, content });
}

/** 把非流式兜底的整段文本切成若干段（句末标点优先），让前端仍能"逐句浮现"，与流式体验一致 */
function splitForStream(text: string): string[] {
  const t = String(text || '');
  if (!t) return [];
  const parts = t.split(/(?<=[。！？!?…；;\n])/).filter((s) => s.length > 0);
  // 只有一句（没有句末标点）时按长度对半拆，保证至少 2 段
  if (parts.length <= 1 && t.length > 8) {
    const mid = Math.ceil(t.length / 2);
    return [t.slice(0, mid), t.slice(mid)];
  }
  return parts;
}

/**
 * 生成 + 流式返回（正常回复与重新生成共用同一套协议：delta/final/done/error）。
 * 整条生成链路（prepare → start → 生成 → 落库 → 提交回合 → 入队分析 → 出错清理）都在
 * 服务端会话锁内串行执行；流结束 / 取消 / 异常都会释放锁。
 */
function buildChatStream(req: Request, params: { regenerate: boolean; content: string }): Response {
  const encoder = new TextEncoder();
  let full = '';
  let assistantSaved = false;
  let assistantMessageId: number | null = null;
  let content = params.content;
  const ac = new AbortController();
  req.signal?.addEventListener?.('abort', () => ac.abort());

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* 客户端已断开 */
        }
      };

      try {
        await withConversationLock(DEFAULT_USER_ID, async () => {
          if (ac.signal.aborted) return;

          // ---- prepare 阶段：准备上下文 + 建 turn/generation（同一会话串行）----
          let prepared: PreparedTurn;
          let cleanupUserOnError = true;
          try {
            if (params.regenerate) {
              const last = getLastMessage();
              if (!last || last.role !== 'assistant') throw new Error('最后一条不是她的消息，无法重新生成');
              const userMsg = getLastUserMessageBefore(last.id);
              if (!userMsg) throw new Error('没有可用的用户消息，无法重新生成');
              content = String(userMsg.content || '');

              // 找到"他这条消息"所属的 turn；旧数据没有则补建（不新增一轮对话语义）
              let turn = getTurnByUserMessageId(userMsg.id);
              if (!turn) turn = createTurn(userMsg.id);
              const turnId = turn.id;

              // 旧 generation：优先定位"产出这条回复"的那次生成，标 superseded 并撤销其已生效影响
              const oldGen = generationByAssistantMessageId(last.id) ?? currentGenerationForTurn(turnId);
              if (oldGen) {
                supersedeGeneration(oldGen.id);
                try {
                  rollbackOperationsForGeneration(oldGen.id);
                } catch (e) {
                  console.warn('[chat] 撤销旧生成影响失败:', errMsg(e));
                }
              }
              // 删掉旧回复（保留现有主动消息清理逻辑）
              deleteMessageById(last.id);
              deleteProactiveMessagesByMessageId(last.id);

              // 新 generation：不新建 turn、不改 turn_count、不 touchInteraction
              const newGen = beginGeneration(turnId);
              prepared = await prepareTurn(content, {
                insertUserMessage: false,
                userMessageId: userMsg.id,
                turnId,
                generationId: newGen.id,
              });
              cleanupUserOnError = false;
            } else {
              prepared = await prepareTurn(content);
            }
          } catch (e) {
            send({ type: 'error', message: errMsg(e) });
            return;
          }

          // ---- 生成阶段 ----
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
                // 与流式协议一致：分段逐个发 delta（而不是把整段当单个 delta 一次性灌下去）
                full = '';
                const segs = splitForStream(retry);
                for (let i = 0; i < segs.length; i++) {
                  full += segs[i]!;
                  send({ type: 'delta', text: segs[i]! });
                  if (i < segs.length - 1) await new Promise((r) => setTimeout(r, 40));
                }
              }
            }

            // 兜底二：人味层（清洗 AI 腔 / 控制长度 / 补神态动作 / 空回复用兜底台词）
            let h = humanizeReply(cleanContent(full), prepared.humanize);

            // P1-13 回复校验层：人味层只管格式，不看"她到底有没有接住他此刻说的内容"。
            // 答非所问（hardFail）或分数过低 → 用同一条上下文追加纠正指令，最多自动重答一次，
            // 两次里取校验分高者作为 final（只落库最终采用的那一条）。校验自身出错一律退回 attempt1。
            let retried = false;
            try {
              const v1 = validateReply({
                userMessage: content,
                reply: h.text,
                recentReplies: prepared.humanize.recentReplies,
              });
              if (v1.hardFail || v1.score < RETRY_SCORE_THRESHOLD) {
                retried = true;
                try {
                  const retryRaw = await chat(
                    [
                      ...prepared.messages,
                      {
                        role: 'user',
                        content:
                          '（你刚才没有接住他此刻说的内容，重新自然回应他这条消息，别答非所问；保持口语、短句、一个括号神态动作）',
                      },
                    ],
                    { maxTokens: 500, temperature: 0.9, thinking: false, signal: ac.signal }
                  );
                  if (String(retryRaw || '').trim()) {
                    const h2 = humanizeReply(cleanContent(retryRaw), prepared.humanize);
                    const v2 = validateReply({
                      userMessage: content,
                      reply: h2.text,
                      recentReplies: prepared.humanize.recentReplies,
                    });
                    if (v2.score >= v1.score) h = h2;
                  }
                } catch (e) {
                  console.warn('[chat] 自动重答失败，沿用首次回复:', errMsg(e));
                }
              }
            } catch (e) {
              console.warn('[chat] 回复校验异常，跳过校验:', errMsg(e));
            }

            const savedAssistantId = saveAssistantMessage(h.text);
            assistantMessageId = savedAssistantId;
            assistantSaved = true;
            // 规则兜底：她话里明确说了"我睡了/我去洗澡/我去吃饭…" → 立刻登记可控事件
            try {
              detectEventFromConversation(content, h.text);
            } catch {
              /* 登记失败不影响聊天 */
            }

            // 成功落库后才提交本轮产物（turn_count / streak / 场景）并收尾生成
            if (!params.regenerate) commitTurn(prepared);
            if (prepared.generationId) completeGeneration(prepared.generationId, savedAssistantId);

            // 若触发过自动重答，在 notes 里标一下（放最前，避免被.slice(0,3)截掉）
            const notes = (retried ? ['已自动重答一次'] : []).concat(h.notes);
            send({
              type: 'final',
              text: h.text,
              addedAction: h.addedAction,
              notes: notes.slice(0, 3),
            });

            // 服务端直接入队分析（不再依赖前端触发）；done 事件带上回合/生成/任务标识
            let analysisJobId: number | null = null;
            let analysisStartedAt: number | null = null;
            if (prepared.generationId && prepared.turnId !== null) {
              try {
                analysisStartedAt = Date.now();
                const { jobId } = enqueueAnalysis({
                  turnId: prepared.turnId,
                  generationId: prepared.generationId,
                  userMessageId: prepared.userMessageId,
                  assistantMessageId: savedAssistantId,
                });
                analysisJobId = jobId;
              } catch (e) {
                console.warn('[chat] 入队分析失败:', errMsg(e));
              }
            }

            send({
              type: 'done',
              assistantMessageId: savedAssistantId,
              userMessageId: prepared.userMessageId,
              fullText: h.text,
              turnId: prepared.turnId,
              generationId: prepared.generationId,
              analysisJobId,
              analysisStartedAt,
            });
          } catch (e) {
            // 整轮失败：把刚落库的用户消息撤掉，避免刷新后"复活"一条没人回应的消息
            // （重新生成时不能删，那是他之前发的那条）；同时作废本轮生成/回合
            if (!assistantSaved) {
              if (cleanupUserOnError && prepared.userMessageId) {
                try {
                  deleteMessageById(Number(prepared.userMessageId));
                } catch {
                  /* 删除失败不影响错误上报 */
                }
                if (prepared.turnId) cancelTurn(prepared.turnId);
              }
              if (prepared.generationId) failGeneration(prepared.generationId);
            }
            send({ type: 'error', message: errMsg(e) });
            send({
              type: 'done',
              assistantMessageId,
              userMessageId: prepared.userMessageId,
              fullText: full,
              turnId: prepared.turnId,
              generationId: prepared.generationId,
              analysisJobId: null,
              analysisStartedAt: null,
            });
          }
        });
      } catch (e) {
        send({ type: 'error', message: errMsg(e) });
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