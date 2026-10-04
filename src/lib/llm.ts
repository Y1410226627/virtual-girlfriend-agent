// LLM 客户端：多模型档案 + 自动备用链 + 超时保护 + 向量接口分离
// 支持：本地 vLLM / 智谱 GLM / 任何 OpenAI 兼容服务
import { llmConfig, getCounter } from './db';
import { parseJsonLoose } from './utils';
import {
  listProfiles,
  activeProfile,
  markModelFailure,
  markModelSuccess,
  isCooling,
} from './profiles';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  thinking?: boolean; // 是否允许"深度思考"（默认关闭，聊天更快更自然）
  /** 用途：chat=陪聊（默认）；analysis=后台分析（走 analysis_model，可用更快的小模型） */
  kind?: 'chat' | 'analysis';
  timeoutMs?: number;
  noThinkingKwarg?: boolean;
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* 目标（一次调用要用的连接与模型）                                     */
/* ------------------------------------------------------------------ */
interface LlmTarget {
  key: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: 'zhipu' | 'openai';
}

function isZhipu(baseUrl: string): boolean {
  return /bigmodel\.cn|zhipuai/i.test(baseUrl || '');
}

function makeKey(baseUrl: string, model: string, kind: string) {
  return `${kind}|${baseUrl}|${model}`;
}

function targetOf(
  src: { label: string; baseUrl: string; apiKey: string; model: string },
  kind: 'chat' | 'analysis'
): LlmTarget {
  const baseUrl = (src.baseUrl || '').replace(/\/+$/, '');
  return {
    key: makeKey(baseUrl, src.model, kind),
    label: src.label,
    baseUrl,
    apiKey: src.apiKey,
    model: src.model,
    provider: isZhipu(baseUrl) ? 'zhipu' : 'openai',
  };
}

/** 当前档案 + 备用档案，拼成调用链（健康的排前面；正在冷却的放最后） */
function targetsFor(kind: 'chat' | 'analysis', modelOverride?: string): LlmTarget[] {
  const cfg = llmConfig();
  const profiles = listProfiles();

  let list: LlmTarget[];
  if (profiles.length) {
    const act = profiles.find((p) => p.is_default === 1) || profiles[0];
    const ordered = [act, ...profiles.filter((p) => p.id !== act.id).sort((a, b) => a.sort_order - b.sort_order)];
    list = ordered.map((p) =>
      targetOf(
        {
          label: p.label,
          baseUrl: p.base_url,
          apiKey: p.api_key,
          model: (kind === 'analysis' ? p.analysis_model || p.chat_model : p.chat_model) as string,
        },
        kind
      )
    );
  } else {
    const single = targetOf(
      {
        label: cfg.model,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: kind === 'analysis' ? cfg.analysisModel : cfg.model,
      },
      kind
    );
    list = [single];
  }

  if (modelOverride) {
    // 指定模型时只走当前档案（用于设置页"测试这个模型"）
    const base = list[0];
    list = [{ ...base, model: modelOverride, key: makeKey(base.baseUrl, modelOverride, kind) }];
  }

  // 健康的优先；正在冷却的排到后面，但不剔除（避免全部冷却时无可用）
  const healthy = list.filter((t) => !isCooling(t.key));
  const cooling = list.filter((t) => isCooling(t.key));
  return [...healthy, ...cooling];
}

/* ------------------------------------------------------------------ */
/* 请求构造                                                            */
/* ------------------------------------------------------------------ */
function buildBody(target: LlmTarget, messages: ChatMessage[], opts: ChatOptions) {
  const body: Record<string, any> = {
    model: target.model,
    messages,
    temperature: opts.temperature ?? 0.85,
    max_tokens: opts.maxTokens ?? 800,
  };
  if (opts.json) body.response_format = { type: 'json_object' };

  if (target.provider === 'zhipu') {
    // 智谱：glm-5 系列"始终思考"，只能用 low/high/max 控制强度
    if (/^glm-5/i.test(target.model)) {
      body.thinking = { type: opts.thinking ? 'high' : 'low' };
    } else {
      body.thinking = { type: opts.thinking ? 'enabled' : 'disabled' };
    }
  } else if (!opts.thinking && !opts.noThinkingKwarg) {
    // vLLM / qwen 系列：关闭思考链
    body.chat_template_kwargs = { enable_thinking: false };
  }
  return body;
}

function headersFor(target: LlmTarget): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey}` };
}

function endpointFor(target: LlmTarget, pathname: string): string {
  if (!target.baseUrl) throw new Error('未配置模型接口地址，请在「设置 → 模型」里选择或填写');
  return `${target.baseUrl}${pathname}`;
}

const THINKING_UNSUPPORTED_RE =
  /(chat_template_kwargs|enable_thinking|thinking|unexpected keyword|unknown (field|argument)|template.*not (support|found))/i;

function isParamError(e: any): boolean {
  return THINKING_UNSUPPORTED_RE.test(String(e?.message || ''));
}

/** 只在"所有模型都失败"时才向上抛错；单个模型失败会自动切下一个 */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number, outerSignal?: AbortSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`请求超时（${Math.round(ms / 1000)} 秒）`)), ms);
  const onOuterAbort = () => ctrl.abort(new Error('已取消'));
  if (outerSignal) {
    if (outerSignal.aborted) ctrl.abort(new Error('已取消'));
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

/** 记录最后一次真正使用的模型（设置页/自检展示用） */
declare global {
  // eslint-disable-next-line no-var
  var __gfLastTarget: { label: string; model: string; baseUrl: string; at: number; fallback: boolean } | undefined;
}

function noteUsed(target: LlmTarget, fallback: boolean) {
  globalThis.__gfLastTarget = {
    label: target.label,
    model: target.model,
    baseUrl: target.baseUrl,
    at: Date.now(),
    fallback,
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
    { label: src.label || src.model, baseUrl: src.baseUrl, apiKey: src.apiKey, model: src.model },
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
  } catch (e: any) {
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
      return { ok: false, ms: Date.now() - t0, error: e?.message || String(e), provider: t.provider };
    }
  }
}

/* ------------------------------------------------------------------ */
/* 非流式                                                              */
/* ------------------------------------------------------------------ */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const targets = targetsFor(opts.kind ?? 'chat', opts.model);
  let lastErr: any = null;
  const timeout = opts.timeoutMs ?? 45000;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
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
      return text;
    } catch (e: any) {
      if (opts.signal?.aborted) throw e;
      lastErr = e;
      markModelFailure(t.key, e?.message || String(e), Date.now() - t0);
      console.warn(`[LLM] ${t.label}(${t.model}) 失败，尝试下一个：${e?.message || e}`);
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
/* 流式                                                                */
/* ------------------------------------------------------------------ */
export async function chatStream(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  opts: ChatOptions = {}
): Promise<string> {
  const targets = targetsFor(opts.kind ?? 'chat', opts.model);
  let lastErr: any = null;
  let emittedAny = false;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    let emitted = '';
    const t0 = Date.now();
    try {
      let out: string;
      const onPiece = (piece: string) => {
        emitted += piece;
        emittedAny = true;
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
      return out;
    } catch (e: any) {
      if (opts.signal?.aborted) throw e;
      lastErr = e;
      markModelFailure(t.key, e?.message || String(e), Date.now() - t0);
      // 已经吐过字就不能换模型重来（会重复内容），直接把错误抛出去
      if (emitted) throw e;
      console.warn(`[LLM] 流式 ${t.label}(${t.model}) 失败，尝试下一个：${e?.message || e}`);
    }
  }
  throw lastErr || new Error('所有模型都不可用');
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
        let delta: any = {};
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

/* ------------------------------------------------------------------ */
/* 结构化 JSON（自动备份链 + 多轮降级重试）                             */
/* ------------------------------------------------------------------ */
export async function chatJson<T = any>(messages: ChatMessage[], opts: ChatOptions = {}): Promise<T | null> {
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

/* ------------------------------------------------------------------ */
/* Embedding（可单独配置连接，换聊天模型时保持记忆向量一致）             */
/* ------------------------------------------------------------------ */
const LOCAL_DIM = 512;

/** 本地哈希 n-gram 向量（接口不可用时的兜底，无需联网） */
export function localEmbedding(text: string): number[] {
  const vec = new Array(LOCAL_DIM).fill(0);
  const s = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const chars = Array.from(s);
  const push = (token: string, w: number) => {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = (h >>> 0) % LOCAL_DIM;
    const sign = ((h >>> 8) & 1) === 0 ? 1 : -1;
    vec[idx] += sign * w;
  };
  for (let i = 0; i < chars.length; i++) {
    push(chars[i], 1);
    if (i + 1 < chars.length) push(chars[i] + chars[i + 1], 2);
    if (i + 2 < chars.length) push(chars[i] + chars[i + 1] + chars[i + 2], 1.5);
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

let embeddingApiAvailable: boolean | null = null;
let lastConfigVersion = -1;

const embedCache = new Map<string, number[]>();
const EMBED_CACHE_MAX = 800;

function cacheGet(key: string): number[] | undefined {
  const v = embedCache.get(key);
  if (v) {
    embedCache.delete(key);
    embedCache.set(key, v);
  }
  return v;
}

function cacheSet(key: string, vec: number[]) {
  if (embedCache.size >= EMBED_CACHE_MAX) {
    const oldest = embedCache.keys().next().value;
    if (oldest !== undefined) embedCache.delete(oldest);
  }
  embedCache.set(key, vec);
}

/** 配置变化（换模型/换向量接口）时清空缓存，避免用错向量 */
function syncConfigVersion() {
  const v = getCounter('config_version');
  if (v !== lastConfigVersion) {
    lastConfigVersion = v;
    embedCache.clear();
    embeddingApiAvailable = null;
  }
}

export async function embed(texts: string[]): Promise<number[][]> {
  syncConfigVersion();
  const cfg = llmConfig();
  const input = texts.map((t) => String(t || '').slice(0, 2000));
  if (!input.length) return [];

  const out: (number[] | null)[] = input.map((t) => cacheGet(t) || null);
  const missIndexes = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (!missIndexes.length) return out as number[][];

  const missTexts = missIndexes.map((i) => input[i]);
  const fill = (vecs: number[][]) => {
    missIndexes.forEach((idx, k) => {
      out[idx] = vecs[k];
      cacheSet(input[idx], vecs[k]);
    });
    return out as number[][];
  };

  if (cfg.embeddingModel && cfg.embeddingBaseUrl && embeddingApiAvailable !== false) {
    try {
      const res = await fetchWithTimeout(
        `${cfg.embeddingBaseUrl}/embeddings`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.embeddingApiKey}` },
          body: JSON.stringify({ model: cfg.embeddingModel, input: missTexts }),
        },
        20000
      );
      if (res.ok) {
        const j = await res.json();
        const data = Array.isArray(j?.data) ? j.data : [];
        if (data.length === missTexts.length && Array.isArray(data[0]?.embedding)) {
          embeddingApiAvailable = true;
          return fill(data.map((d: any) => d.embedding as number[]));
        }
      }
      embeddingApiAvailable = false;
    } catch {
      embeddingApiAvailable = false;
    }
  }
  return fill(missTexts.map((t) => localEmbedding(t)));
}

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embed([text]);
  return v;
}

export function embeddingMode(): string {
  syncConfigVersion();
  const cfg = llmConfig();
  if (!cfg.embeddingModel) return 'local(本地哈希向量)';
  return embeddingApiAvailable === false ? `local(降级)` : `api:${cfg.embeddingModel}`;
}
