// LLM 流式输出：SSE 增量解析 + 思考标签（thinking / redacted_thinking）跨 chunk 过滤。
// 依赖 llm-core 的共享内核；严禁 import 桶文件 llm.ts。
import { markModelFailure, markModelSuccess } from './profiles';
import { errMsg } from './utils';
import {
  buildBody,
  bumpUsage,
  endpointFor,
  headersFor,
  isParamError,
  noteUsed,
  targetsFor,
  type ChatMessage,
  type ChatOptions,
  type LlmTarget,
} from './llm-core';

/* ------------------------------------------------------------------ */
/* 流式                                                                */
/* ------------------------------------------------------------------ */
export async function chatStream(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  opts: ChatOptions = {}
): Promise<string> {
  const targets = targetsFor(opts.kind ?? 'chat', opts.model);
  let lastErr: unknown = null;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    let emitted = '';
    const t0 = Date.now();
    try {
      let out: string;
      const onPiece = (piece: string) => {
        emitted += piece;
        onDelta(piece);
      };
      try {
        out = await streamOnce(t, messages, onPiece, opts);
      } catch (e) {
        // 还没吐字且是参数问题 → 去掉 thinking 参数重试
        if (!emitted && !opts.thinking && !opts.noThinkingKwarg && isParamError(e)) {
          out = await streamOnce(t, messages, onPiece, { ...opts, noThinkingKwarg: true });
        } else {
          throw e;
        }
      }
      markModelSuccess(t.key, Date.now() - t0);
      noteUsed(t, i > 0);
      bumpUsage(opts.kind === 'analysis' ? 'analysis' : 'chat');
      return out;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      lastErr = e;
      markModelFailure(t.key, errMsg(e), Date.now() - t0);
      // 已经吐过字就不能换模型重来（会重复内容），直接把错误抛出去
      if (emitted) throw e;
      console.warn(`[LLM] 流式 ${t.label}(${t.model}) 失败，尝试下一个：${errMsg(e)}`);
    }
  }
  throw lastErr || new Error('所有模型都不可用');
}

interface StreamDeltaPiece {
  content?: string;
  reasoning?: unknown;
  reasoning_content?: unknown;
}

async function streamOnce(
  target: LlmTarget,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  opts: ChatOptions
): Promise<string> {
  const firstTokenMs = opts.timeoutMs ?? 12000;
  const overallMs = 120000;
  const ctrl = new AbortController();
  let firstTimer: NodeJS.Timeout | null = setTimeout(
    () => ctrl.abort(new Error(`首字超时（${Math.round(firstTokenMs / 1000)} 秒无响应）`)),
    firstTokenMs
  );
  const overallTimer = setTimeout(() => ctrl.abort(new Error('整体超时')), overallMs);
  const onOuterAbort = () => ctrl.abort(new Error('已取消'));
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort(new Error('已取消'));
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    const res = await fetch(endpointFor(target, '/chat/completions'), {
      method: 'POST',
      headers: headersFor(target),
      body: JSON.stringify({ ...buildBody(target, messages, opts), stream: true }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`${target.model} 流式请求失败 ${res.status}: ${text.slice(0, 240)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    const thinkState = { inThink: false };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let delta: StreamDeltaPiece = {};
        try {
          delta = JSON.parse(payload)?.choices?.[0]?.delta || {};
        } catch {
          continue;
        }
        // 屏蔽思考链字段（不同平台的命名）
        if (typeof delta.reasoning === 'string' || typeof delta.reasoning_content === 'string') continue;
        let piece: string = typeof delta.content === 'string' ? delta.content : '';
        if (!piece) continue;
        if (firstTimer) {
          clearTimeout(firstTimer);
          firstTimer = null;
        }
        // 屏蔽思考链：跨 chunk 维护状态，把思考标签里的内容整段丢掉
        piece = filterThinkDelta(thinkState, piece);
        if (!piece) continue;
        full += piece;
        onDelta(piece);
      }
    }
    return cleanContent(full);
  } finally {
    if (firstTimer) clearTimeout(firstTimer);
    clearTimeout(overallTimer);
    if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort);
  }
}

/* 思考标签相关常量：用字符码拼出来，避免源码里的标签字面量被任何"清洗"环节吃掉 */
const TAG_LT = String.fromCharCode(60);
const TAG_GT = String.fromCharCode(62);
const THINK_OPENERS = [
  `${TAG_LT}thinking${TAG_GT}`,
  `${TAG_LT}think${TAG_GT}`,
  `${TAG_LT}redacted_thinking${TAG_GT}`,
];
const THINK_CLOSERS = [
  `${TAG_LT}/thinking${TAG_GT}`,
  `${TAG_LT}/think${TAG_GT}`,
  `${TAG_LT}/redacted_thinking${TAG_GT}`,
];
const THINK_BLOCK_RE = new RegExp(
  `${TAG_LT}think(?:ing)?(?:\\s[^${TAG_GT}]*)?${TAG_GT}[\\s\\S]*?${TAG_LT}/think(?:ing)?\\s*${TAG_GT}`,
  'gi'
);
const REDACTED_BLOCK_RE = new RegExp(
  `${TAG_LT}redacted_thinking${TAG_GT}[\\s\\S]*?${TAG_LT}/redacted_thinking\\s*${TAG_GT}`,
  'gi'
);
const THINK_TAG_ONLY_RE = new RegExp(`${TAG_LT}/?think(?:ing)?(?:\\s[^${TAG_GT}]*)?${TAG_GT}`, 'gi');
const MAX_TAG_LEN = Math.max(...THINK_OPENERS.map((t) => t.length), ...THINK_CLOSERS.map((t) => t.length));

export interface ThinkDeltaState {
  inThink: boolean;
  /** 可能是标签前缀、被切在 chunk 边界的尾巴（暂不展示，等下一片拼上再判定） */
  pending?: string;
  /** 已丢弃的思考内容长度：异常长（标签一直不闭合）时强制复位，避免"她整段失声" */
  thoughtLen?: number;
}

/** 尾巴是否可能是某个标签的前缀（如 "<"、"<thin"、"</redacted_"） */
function partialTagTail(rest: string): string | null {
  const lastLt = rest.lastIndexOf(TAG_LT);
  if (lastLt < 0) return null;
  const tail = rest.slice(lastLt);
  if (tail.length >= MAX_TAG_LEN) return null;
  const all = [...THINK_OPENERS, ...THINK_CLOSERS];
  return all.some((t) => t.startsWith(tail)) ? tail : null;
}

/**
 * 流式增量的"思考标签"过滤：跨 chunk 维护状态。
 * 返回应当展示给用户的文本（思考中的内容全部丢弃）。
 */
export function filterThinkDelta(state: ThinkDeltaState, piece: string): string {
  let rest = (state.pending || '') + String(piece || '');
  state.pending = '';
  let out = '';
  while (rest) {
    if (state.inThink) {
      let idx = -1;
      let len = 0;
      for (const c of THINK_CLOSERS) {
        const i = rest.indexOf(c);
        if (i >= 0 && (idx < 0 || i < idx)) {
          idx = i;
          len = c.length;
        }
      }
      if (idx < 0) {
        // 还没闭合：整段是思考内容。但尾巴可能是闭合标签的前缀，先缓存
        const tail = partialTagTail(rest);
        const drop = tail ? rest.length - tail.length : rest.length;
        state.thoughtLen = (state.thoughtLen || 0) + drop;
        if (tail) state.pending = tail;
        if ((state.thoughtLen || 0) > 8000) {
          // 标签明显坏了（一直不闭合）：强制复位，宁可漏一点也不要整段失声
          state.inThink = false;
          state.thoughtLen = 0;
        }
        return out;
      }
      rest = rest.slice(idx + len);
      state.inThink = false;
      state.thoughtLen = 0;
      continue;
    }
    let idx = -1;
    let len = 0;
    for (const o of THINK_OPENERS) {
      const i = rest.indexOf(o);
      if (i < 0) continue;
      if (idx < 0 || i < idx) {
        idx = i;
        len = o.length;
      }
    }
    if (idx < 0) {
      const tail = partialTagTail(rest);
      if (tail) {
        state.pending = tail;
        return out + rest.slice(0, rest.length - tail.length);
      }
      return out + rest;
    }
    out += rest.slice(0, idx);
    rest = rest.slice(idx + len);
    state.inThink = true;
  }
  return out;
}

export function cleanContent(text: string): string {
  let t = String(text || '').trim();
  // 思考标签（thinking 与 redacted 两种变体）整段去掉，残留标签本身也清掉
  t = t.replace(THINK_BLOCK_RE, '');
  t = t.replace(REDACTED_BLOCK_RE, '');
  t = t.replace(THINK_TAG_ONLY_RE, '');
  t = t.replace(/^```[a-z]*\s*([\s\S]*?)```$/i, '$1');
  return t.trim();
}