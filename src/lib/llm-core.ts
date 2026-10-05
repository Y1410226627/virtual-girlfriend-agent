// LLM 客户端共享内核：目标解析（档案 + 备用链）、请求构造、超时与错误判定、用量计数。
// 说明：本文件被 llm.ts / llm-stream.ts / llm-embedding.ts 共用；只向下依赖 db / profiles，
// 严禁 import 任何 llm-* 文件（否则会与桶文件 llm.ts 形成循环依赖）。
import { llmConfig, getSetting, setSetting, setCounter, bumpCounter } from './db';
import { listProfiles, isCooling, keyHostFor, hostOf } from './profiles';
import { localDateStr } from './utils';

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
export interface LlmTarget {
  key: string;
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: 'zhipu' | 'openai';
}

function isZhipu(baseUrl: string): boolean {
  return /bigmodel\.cn|zhipuai/i.test(baseUrl || '');
}

/** key 里带上档案 id：避免两个档案 baseUrl+model 相同时共用冷却状态或被视为同一条 */
function makeKey(baseUrl: string, model: string, kind: string, id: string) {
  return `${kind}|${id}|${baseUrl}|${model}`;
}

export function targetOf(
  src: { id: string; label: string; baseUrl: string; apiKey: string; model: string },
  kind: 'chat' | 'analysis'
): LlmTarget {
  const baseUrl = (src.baseUrl || '').replace(/\/+$/, '');
  return {
    key: makeKey(baseUrl, src.model, kind, src.id),
    id: src.id,
    label: src.label,
    baseUrl,
    apiKey: src.apiKey,
    model: src.model,
    provider: isZhipu(baseUrl) ? 'zhipu' : 'openai',
  };
}

/* ------------------------------------------------------------------ */
/* URL 与凭据分离（P0-13）：保存的 Key 只发给"它被保存时所属的 host"      */
/* ------------------------------------------------------------------ */
/** 已告警过的 host 组合：同一组合只 console.warn 一次，避免刷屏 */
const warnedKeyHosts = new Set<string>();

/**
 * 纯函数（可测）：按 host 决定是否把"已保存的 Key"附加到目标。
 * 规则：Key 有归属 host 且与目标 host 不一致 → 不发送该 Key，回退 env Key（没有则为空）。
 * 归属 host 或目标 host 为空（无法解析）时不做校验（保守放行）。
 */
export function guardKeyByHost(params: {
  savedKey: string;
  savedHost: string;
  targetUrl: string;
  envKey?: string;
}): { apiKey: string; dropped: boolean } {
  const key = String(params.savedKey || '');
  const savedHost = String(params.savedHost || '').toLowerCase();
  const targetHost = hostOf(params.targetUrl);
  if (!key || !savedHost || !targetHost || savedHost === targetHost) {
    return { apiKey: key, dropped: false };
  }
  return { apiKey: String(params.envKey || ''), dropped: true };
}

function warnKeyHostDrop(warnKey: string, targetUrl: string, savedHost: string) {
  if (warnedKeyHosts.has(warnKey)) return;
  warnedKeyHosts.add(warnKey);
  console.warn(
    `[llm] 已保存的 Key 属于 host「${savedHost}」，与目标「${hostOf(targetUrl) || targetUrl}」不一致，` +
      `本次不发送该 Key（回退环境变量）。如确认要发送，请在设置里同时重新填写接口地址与 Key。`
  );
}

/** 当前档案 + 备用档案，拼成调用链（健康的排前面；正在冷却的放最后） */
export function targetsFor(kind: 'chat' | 'analysis', modelOverride?: string): LlmTarget[] {
  const cfg = llmConfig();
  const profiles = listProfiles();
  // 保存到 settings 的 Key 归属 host（P0-13）。env Key 视为用户自己的环境，不做校验。
  const savedHost = keyHostFor('llm');
  const envKey = process.env.LLM_API_KEY || '';

  let list: LlmTarget[];
  if (profiles.length) {
    const act = profiles.find((p) => p.is_default === 1) || profiles[0]!;
    const ordered = [act, ...profiles.filter((p) => p.id !== act.id).sort((a, b) => a.sort_order - b.sort_order)];
    list = ordered.map((p, i) => {
      const t = targetOf(
        {
          id: String(p.id),
          label: p.label,
          baseUrl: p.base_url,
          apiKey: p.api_key,
          model: (kind === 'analysis' ? p.analysis_model || p.chat_model : p.chat_model) as string,
        },
        kind
      );
      // 只对"激活档案"做 host 校验（它的 url/key 与 settings 镜像，可能被用户单独改了 URL）；
      // 备用档案的 url 与 key 是一起保存的，按原样信任。
      if (i === 0) {
        const g = guardKeyByHost({ savedKey: t.apiKey, savedHost, targetUrl: t.baseUrl, envKey });
        if (g.dropped) {
          warnKeyHostDrop(`chat|${t.id}|${t.baseUrl}`, t.baseUrl, savedHost);
          t.apiKey = g.apiKey;
        }
      }
      return t;
    });
  } else {
    // 无档案：用 settings/env 配置。保存到 settings 的 Key 做 host 校验。
    const settingsKey = getSetting('llm_api_key') || '';
    let apiKey = cfg.apiKey;
    if (settingsKey) {
      const g = guardKeyByHost({ savedKey: settingsKey, savedHost, targetUrl: cfg.baseUrl, envKey });
      if (g.dropped) warnKeyHostDrop(`chat|env|${cfg.baseUrl}`, cfg.baseUrl, savedHost);
      apiKey = g.apiKey;
    }
    list = [
      targetOf(
        {
          id: 'env',
          label: cfg.model,
          baseUrl: cfg.baseUrl,
          apiKey,
          model: kind === 'analysis' ? cfg.analysisModel : cfg.model,
        },
        kind
      ),
    ];
  }

  if (modelOverride) {
    // 指定模型时只走当前档案（用于设置页"测试这个模型"）
    const base = list[0]!;
    list = [{ ...base, model: modelOverride, key: makeKey(base.baseUrl, modelOverride, kind, base.id) }];
  }

  // 健康的优先；正在冷却的排到后面，但不剔除（避免全部冷却时无可用）
  const healthy = list.filter((t) => !isCooling(t.key));
  const cooling = list.filter((t) => isCooling(t.key));
  return [...healthy, ...cooling];
}

/* ------------------------------------------------------------------ */
/* 请求构造                                                            */
/* ------------------------------------------------------------------ */
export function buildBody(target: LlmTarget, messages: ChatMessage[], opts: ChatOptions) {
  const body: Record<string, unknown> = {
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

export function headersFor(target: LlmTarget): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey}` };
}

export function endpointFor(target: LlmTarget, pathname: string): string {
  if (!target.baseUrl) throw new Error('未配置模型接口地址，请在「设置 → 模型」里选择或填写');
  return `${target.baseUrl}${pathname}`;
}

const THINKING_UNSUPPORTED_RE =
  /(chat_template_kwargs|enable_thinking|thinking|unexpected keyword|unknown (field|argument)|template.*not (support|found))/i;

export function isParamError(e: unknown): boolean {
  const msg = String((e as { message?: unknown } | null | undefined)?.message || '');
  return THINKING_UNSUPPORTED_RE.test(msg);
}

/** 只在"所有模型都失败"时才向上抛错；单个模型失败会自动切下一个 */
export async function fetchWithTimeout(url: string, init: RequestInit, ms: number, outerSignal?: AbortSignal) {
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
   
  var __gfLastTarget: { label: string; model: string; baseUrl: string; at: number; fallback: boolean } | undefined;
}

export function noteUsed(target: LlmTarget, fallback: boolean) {
  globalThis.__gfLastTarget = {
    label: target.label,
    model: target.model,
    baseUrl: target.baseUrl,
    at: Date.now(),
    fallback,
  };
  // 备用链切换要留痕：设置页会告诉用户"刚从 A 降级到 B"（否则只会觉得她突然变笨了）
  if (fallback) {
    try {
      setSetting('last_fallback_label', `${target.label || target.model}`.trim());
      setCounter('last_fallback_at', Date.now());
    } catch {
      /* 忽略 */
    }
  }
}

/** 今日调用计数（成本透明：设置页显示）。key 用本地日期，避免东八区 0:00-8:00 记到前一天 */
export function bumpUsage(kind: 'chat' | 'analysis' | 'embedding') {
  try {
    const day = localDateStr();
    bumpCounter(`llm_calls_${day}`, 1);
    bumpCounter(`llm_calls_${kind}_${day}`, 1);
  } catch {
    /* 计数失败不影响调用 */
  }
}