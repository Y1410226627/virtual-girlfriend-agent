// LLM 客户端：多模型档案 + 自动备用链 + 超时保护 + 向量接口分离
// 支持：本地 vLLM / 智谱 GLM / 任何 OpenAI 兼容服务
// 本文件为"桶文件"：对外 API 不变，具体实现按职责拆到 llm-core / llm-stream / llm-embedding。
import { getCounter, getSetting } from './db';
import { parseJsonLoose, errMsg } from './utils';
import { markModelFailure, markModelSuccess } from './profiles';
import {
  buildBody,
  bumpUsage,
  endpointFor,
  fetchWithTimeout,
  headersFor,
  isParamError,
  noteUsed,
  targetOf,
  targetsFor,
  type ChatMessage,
  type ChatOptions,
  type LlmTarget,
} from './llm-core';
import { cleanContent } from './llm-stream';

// 对外保持原样：类型与子模块导出的函数仍可从 '@/lib/llm' 取得
export type { ChatMessage, ChatOptions } from './llm-core';
export { chatStream, filterThinkDelta } from './llm-stream';
export type { ThinkDeltaState } from './llm-stream';
export { localEmbedding, embed, embedOne, embeddingMode } from './llm-embedding';
export { cleanContent };

export function usageToday() {
  const day = new Date().toISOString().slice(0, 10);
  const chat = getCounter(`llm_calls_chat_${day}`);
  const analysis = getCounter(`llm_calls_analysis_${day}`);
  const embedding = getCounter(`llm_calls_embedding_${day}`);
  const fbAt = getCounter('last_fallback_at');
  return {
    day,
    chat,
    analysis,
    embedding,
    total: getCounter(`llm_calls_${day}`),
    lastFallback: fbAt > 0 ? { label: getSetting('last_fallback_label') || '备用模型', at: fbAt } : null,
  };
}

export function lastUsedTarget() {
  return globalThis.__gfLastTarget || null;
}

/** 自检用：当前"陪聊 / 分析"两条链实际会用的模型（验证分析模型是否真的接上了） */
export function routePreview(): { chat: string[]; analysis: string[] } {
  const pick = (kind: 'chat' | 'analysis') => {
    try {
      return targetsFor(kind).map((t) => `${t.label || t.model}·${t.model}`);
    } catch {
      return [] as string[];
    }
  };
  return { chat: pick('chat'), analysis: pick('analysis') };
}

/** 单独测试某套配置（不写库、不影响当前设置） */
export async function testTarget(
  src: { baseUrl: string; apiKey: string; model: string; label?: string },
  opts: { timeoutMs?: number; prompt?: string } = {}
): Promise<{ ok: boolean; ms: number; reply?: string; error?: string; provider: string }> {
  const t = targetOf(
    { id: 'test', label: src.label || src.model, baseUrl: src.baseUrl, apiKey: src.apiKey, model: src.model },
    'chat'
  );
  const t0 = Date.now();
  try {
    const reply = await chatOnce(
      t,
      [{ role: 'user', content: opts.prompt || '只回复两个字：在的' }],
      { maxTokens: 60, temperature: 0.3, thinking: false },
      opts.timeoutMs ?? 30000
    );
    return { ok: true, ms: Date.now() - t0, reply: reply.slice(0, 60), provider: t.provider };
  } catch (e) {
    // 参数不兼容时去掉 thinking 参数再试一次
    try {
      const reply = await chatOnce(
        t,
        [{ role: 'user', content: opts.prompt || '只回复两个字：在的' }],
        { maxTokens: 60, temperature: 0.3, thinking: false, noThinkingKwarg: true },
        opts.timeoutMs ?? 30000
      );
      return { ok: true, ms: Date.now() - t0, reply: reply.slice(0, 60), provider: t.provider };
    } catch {
      return { ok: false, ms: Date.now() - t0, error: errMsg(e), provider: t.provider };
    }
  }
}

/* ------------------------------------------------------------------ */
/* 非流式                                                              */
/* ------------------------------------------------------------------ */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const targets = targetsFor(opts.kind ?? 'chat', opts.model);
  let lastErr: unknown = null;
  const timeout = opts.timeoutMs ?? 45000;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const t0 = Date.now();
    try {
      let text: string;
      try {
        text = await chatOnce(t, messages, opts, timeout);
      } catch (e) {
        // 模型不认识 thinking 参数 → 去掉该参数重试同一模型
        if (!opts.thinking && !opts.noThinkingKwarg && isParamError(e)) {
          text = await chatOnce(t, messages, { ...opts, noThinkingKwarg: true }, timeout);
        } else {
          throw e;
        }
      }
      markModelSuccess(t.key, Date.now() - t0);
      noteUsed(t, i > 0);
      bumpUsage(opts.kind === 'analysis' ? 'analysis' : 'chat');
      return text;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      lastErr = e;
      markModelFailure(t.key, errMsg(e), Date.now() - t0);
      console.warn(`[LLM] ${t.label}(${t.model}) 失败，尝试下一个：${errMsg(e)}`);
    }
  }
  throw lastErr || new Error('所有模型都不可用');
}

async function chatOnce(target: LlmTarget, messages: ChatMessage[], opts: ChatOptions, timeoutMs: number): Promise<string> {
  const res = await fetchWithTimeout(
    endpointFor(target, '/chat/completions'),
    { method: 'POST', headers: headersFor(target), body: JSON.stringify(buildBody(target, messages, opts)) },
    timeoutMs,
    opts.signal
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${target.model} 请求失败 ${res.status}: ${text.slice(0, 240)}`);
  }
  const j = await res.json();
  const msg = j?.choices?.[0]?.message || {};
  return cleanContent(msg.content ?? '');
}

/* ------------------------------------------------------------------ */
/* 结构化 JSON（自动备份链 + 多轮降级重试）                             */
/* ------------------------------------------------------------------ */
export async function chatJson<T = unknown>(messages: ChatMessage[], opts: ChatOptions = {}): Promise<T | null> {
  // JSON 抽取基本都是后台分析任务（记忆/关系/依恋/摘要）→ 默认走分析模型链
  const kind = opts.kind ?? 'analysis';
  const strict: ChatMessage[] = [
    ...messages,
    {
      role: 'user' as const,
      content: '再次强调：只输出一个合法的 JSON 对象，不要任何解释、不要 markdown 代码块、不要多余的大括号。',
    },
  ];
  const attempts: Array<{ msgs: ChatMessage[]; opts: ChatOptions }> = [
    { msgs: messages, opts: { ...opts, kind, json: true, temperature: opts.temperature ?? 0.3 } },
  ];
  if (opts.thinking) {
    attempts.push({ msgs: messages, opts: { ...opts, kind, json: true, thinking: false, temperature: opts.temperature ?? 0.3 } });
  }
  attempts.push({
    msgs: strict,
    opts: { ...opts, kind, json: true, thinking: false, temperature: 0.1, maxTokens: Math.max(opts.maxTokens || 0, 2400) },
  });

  for (const attempt of attempts) {
    try {
      const text = await chat(attempt.msgs, attempt.opts);
      const parsed = parseJsonLoose(text);
      if (parsed) return parsed as T;
    } catch {
      /* 继续下一轮尝试（chat 内部已经跑过备用链） */
    }
  }
  return null;
}