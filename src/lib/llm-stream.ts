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
/** 单次流式调用累计缓冲的字符上限：上游（用户可配 baseUrl）持续吐超长内容时截断收尾，避免 OOM */
const MAX_STREAM_CHARS = 512 * 1024;

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
    let truncated = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 单行超长（上游可能一直不吐换行）：缓冲超过上限就截断收尾，避免 OOM
      if (buffer.length > MAX_STREAM_CHARS) {
        truncated = true;
        break;
      }
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
        // 累计正文达到上限：截断并正常收尾（不 throw，避免整轮回复炸掉）
        if (full.length >= MAX_STREAM_CHARS) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    if (truncated) {
      console.warn(`[LLM] 流式输出超过 ${MAX_STREAM_CHARS} 字符上限，已截断并正常收尾`);
      await reader.cancel().catch(() => {});
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

/** 被当作"思考链"整段丢弃的标签名（大小写不敏感，可带属性；按长度降序，避免短名抢先匹配） */
const THINK_TAG_NAMES = [
  'redacted_thinking',
  'chain_of_thought',
  'thinking',
  'think',
  'reasoning',
  'analysis',
  'reflection',
  'thought',
  '思考',
];
const THINK_NAME_SRC =
  '(?:redacted_thinking|chain_of_thought|thinking|think|reasoning|analysis|reflection|thought|思考)';
// 起始标签 / 闭合标签：名字后必须是空白或 ">"（可带属性），避免把 thinker / reasoningx 这类词误判
const THINK_OPEN_RE = new RegExp(
  `${TAG_LT}\\s*${THINK_NAME_SRC}(?=[\\s${TAG_GT}])[^${TAG_GT}]*${TAG_GT}`,
  'i'
);
const THINK_CLOSE_RE = new RegExp(
  `${TAG_LT}/\\s*${THINK_NAME_SRC}(?=[\\s${TAG_GT}])[^${TAG_GT}]*${TAG_GT}`,
  'i'
);
// 白名单标签块整段删除（开闭标签名用反向引用要求一致）
const THINK_BLOCK_RE = new RegExp(
  `${TAG_LT}(${THINK_NAME_SRC})(?:\\s[^${TAG_GT}]*)?${TAG_GT}[\\s\\S]*?${TAG_LT}/\\1\\s*${TAG_GT}`,
  'gi'
);
// 残留的单个白名单标签本身（无配对）也清掉，只删标记、保留内容
const THINK_TAG_ONLY_RE = new RegExp(
  `${TAG_LT}/?\\s*${THINK_NAME_SRC}(?:\\s[^${TAG_GT}]*)?\\s*${TAG_GT}`,
  'gi'
);
/**
 * 第二层兜底：把成对出现的未知 XML 风格标签块整块删除。
 * 仅当开闭标签成对（同名）存在时才删，避免误伤正常文本里的单个 "<" 或数学符号。
 */
const UNKNOWN_PAIRED_TAG_RE = new RegExp(
  `${TAG_LT}([A-Za-z][A-Za-z0-9_]*)(?:\\s[^${TAG_GT}]*)?${TAG_GT}[\\s\\S]*?${TAG_LT}/\\1\\s*${TAG_GT}`,
  'gi'
);
/** 思考内容累计上限：标签一直不闭合时强制复位，避免"她整段失声" */
const MAX_THOUGHT_CHARS = 8000;

export interface ThinkDeltaState {
  inThink: boolean;
  /** 可能是标签前缀、被切在 chunk 边界的尾巴（暂不展示，等下一片拼上再判定） */
  pending?: string;
  /** 已丢弃的思考内容长度：异常长（标签一直不闭合）时强制复位，避免"她整段失声" */
  thoughtLen?: number;
}

/** 尾巴是否可能是某个标签的前缀（如只有一个 "<"、"<thin"、"</reason" 等被切断的起始标签） */
function partialTagTail(rest: string): string | null {
  const lastLt = rest.lastIndexOf(TAG_LT);
  if (lastLt < 0) return null;
  const tail = rest.slice(lastLt);
  const inner = tail.slice(TAG_LT.length);
  if (inner.includes(TAG_GT)) return null; // 已经是完整标签，交给正则判定
  let body = inner;
  if (body.startsWith('/')) body = body.slice(1);
  body = body.replace(/^\s+/, '');
  if (!body) return tail; // 只有 "<" / "</" / "<空格"
  const namePart = /^[^\s/>]*/.exec(body)?.[0] ?? '';
  if (!namePart) return null;
  const lower = (s: string) => s.toLowerCase();
  // name 仍可能是某个白名单名的前缀，或已完整（后面只剩属性/空白，等 ">"）
  if (THINK_TAG_NAMES.some((n) => lower(n).startsWith(lower(namePart)))) return tail;
  if (THINK_TAG_NAMES.some((n) => lower(n) === lower(namePart))) return tail;
  return null;
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
      const c = THINK_CLOSE_RE.exec(rest);
      if (!c) {
        // 还没闭合：整段是思考内容。但尾巴可能是闭合标签的前缀，先缓存
        const tail = partialTagTail(rest);
        const drop = tail ? rest.length - tail.length : rest.length;
        state.thoughtLen = (state.thoughtLen || 0) + drop;
        if (tail) state.pending = tail;
        if ((state.thoughtLen || 0) > MAX_THOUGHT_CHARS) {
          // 标签明显坏了（一直不闭合）：强制复位，宁可漏一点也不要整段失声
          state.inThink = false;
          state.thoughtLen = 0;
        }
        return out;
      }
      rest = rest.slice(c.index + c[0].length);
      state.inThink = false;
      state.thoughtLen = 0;
      continue;
    }
    const o = THINK_OPEN_RE.exec(rest);
    const c = THINK_CLOSE_RE.exec(rest);
    const openIdx = o ? o.index : -1;
    const closeIdx = c ? c.index : -1;
    if (openIdx < 0 && closeIdx < 0) {
      const tail = partialTagTail(rest);
      if (tail) {
        state.pending = tail;
        return out + rest.slice(0, rest.length - tail.length);
      }
      return out + rest;
    }
    // 取更靠前的标签：起始标签进入思考态，孤立的闭合标签直接丢弃（内容保留）
    const isOpen = openIdx >= 0 && (closeIdx < 0 || openIdx <= closeIdx);
    const idx = isOpen ? openIdx : closeIdx;
    const len = isOpen ? o![0].length : c![0].length;
    out += rest.slice(0, idx);
    rest = rest.slice(idx + len);
    if (isOpen) state.inThink = true;
  }
  return out;
}

export function cleanContent(text: string): string {
  let t = String(text || '').trim();
  // 白名单思考标签（thinking / reasoning / analysis …）整段去掉，残留标签本身也清掉
  t = t.replace(THINK_BLOCK_RE, '');
  // 第二层兜底：成对出现的未知 XML 风格标签块整块删掉（仅成对时删）
  t = t.replace(UNKNOWN_PAIRED_TAG_RE, '');
  t = t.replace(THINK_TAG_ONLY_RE, '');
  t = t.replace(/^```[a-z]*\s*([\s\S]*?)```$/i, '$1');
  return t.trim();
}