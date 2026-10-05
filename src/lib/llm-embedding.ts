// LLM 向量（Embedding）：可单独配置连接 + 本地哈希兜底 + 缓存（换聊天模型时保持记忆向量一致）。
// 依赖 llm-core 的共享内核；严禁 import 桶文件 llm.ts。
import { llmConfig, getCounter, getSetting } from './db';
import { bumpUsage, fetchWithTimeout, guardKeyByHost } from './llm-core';

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
    push(chars[i]!, 1);
    if (i + 1 < chars.length) push(chars[i]! + chars[i + 1]!, 2);
    if (i + 2 < chars.length) push(chars[i]! + chars[i + 1]! + chars[i + 2]!, 1.5);
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

let embeddingApiAvailable: boolean | null = null;
let lastConfigVersion = -1;
/** 上次 embedding 接口失败的时间戳：用于节流重试（失败后每 60 秒才允许再试一次） */
let embeddingApiFailedAt = 0;
const EMBED_RETRY_MS = 60_000;

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
    embeddingApiFailedAt = 0; // 配置变了，允许立刻重试
  }
}

/** 是否允许本次尝试调用 API：接口未失败时总是试；失败后按 EMBED_RETRY_MS 节流重试 */
function shouldTryEmbeddingApi(cfg: { embeddingModel: string; embeddingBaseUrl: string }): boolean {
  if (!cfg.embeddingModel || !cfg.embeddingBaseUrl) return false;
  if (embeddingApiAvailable !== false) return true;
  return Date.now() - embeddingApiFailedAt >= EMBED_RETRY_MS;
}

/** 当前是否处于"API 降级为本地向量"状态（供写入方决定向量标识，便于恢复后重算） */
export function embeddingApiDegraded(): boolean {
  return embeddingApiAvailable === false;
}

export async function embed(texts: string[]): Promise<number[][]> {
  syncConfigVersion();
  const cfg = llmConfig();
  const input = texts.map((t) => String(t || '').slice(0, 2000));
  if (!input.length) return [];

  const out: (number[] | null)[] = input.map((t) => cacheGet(t) || null);
  const missIndexes = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (!missIndexes.length) return out as number[][];

  const missTexts = missIndexes.map((i) => input[i]!);
  const fill = (vecs: number[][]) => {
    missIndexes.forEach((idx, k) => {
      out[idx] = vecs[k]!;
      cacheSet(input[idx]!, vecs[k]!);
    });
    return out as number[][];
  };

  if (shouldTryEmbeddingApi(cfg)) {
    // P0-13：已保存的向量 Key（或回退用的聊天 Key）只发给"保存它时所属的 host"；
    // host 不一致时停止发送该 Key、回退 env（没有则为空），避免改 URL 就把凭据带到未知主机。
    const savedEmbKey = getSetting('embedding_api_key') || '';
    let embKey = cfg.embeddingApiKey;
    if (savedEmbKey) {
      const g = guardKeyByHost({
        savedKey: savedEmbKey,
        savedHost: getSetting('embedding_key_host') || '',
        targetUrl: cfg.embeddingBaseUrl,
        envKey: process.env.EMBEDDING_API_KEY || '',
      });
      if (g.dropped) {
        console.warn('[embedding] 目标地址与已保存向量 Key 的归属主机不一致，已停止发送该 Key（改用环境变量）');
      }
      embKey = g.apiKey;
    } else if (cfg.embeddingApiKey) {
      // 向量接口复用聊天 Key 的情况：按聊天 Key 的归属主机校验
      const g = guardKeyByHost({
        savedKey: cfg.embeddingApiKey,
        savedHost: getSetting('llm_key_host') || '',
        targetUrl: cfg.embeddingBaseUrl,
        envKey: process.env.LLM_API_KEY || '',
      });
      if (g.dropped) {
        console.warn('[embedding] 目标地址与聊天 Key 的归属主机不一致，已停止发送该 Key（改用环境变量）');
      }
      embKey = g.apiKey;
    }
    try {
      const res = await fetchWithTimeout(
        `${cfg.embeddingBaseUrl}/embeddings`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${embKey}` },
          body: JSON.stringify({ model: cfg.embeddingModel, input: missTexts }),
        },
        20000
      );
      if (res.ok) {
        const j = await res.json();
        const data = Array.isArray(j?.data) ? j.data : [];
        if (data.length === missTexts.length && Array.isArray(data[0]?.embedding)) {
          embeddingApiAvailable = true;
          bumpUsage('embedding');
          return fill(data.map((d: { embedding: number[] }) => d.embedding));
        }
      }
      embeddingApiAvailable = false;
      embeddingApiFailedAt = Date.now();
    } catch {
      embeddingApiAvailable = false;
      embeddingApiFailedAt = Date.now();
    }
  }
  return fill(missTexts.map((t) => localEmbedding(t)));
}

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embed([text]);
  return v!;
}

export function embeddingMode(): string {
  syncConfigVersion();
  const cfg = llmConfig();
  if (!cfg.embeddingModel) return 'local(本地哈希向量)';
  return embeddingApiAvailable === false ? `local(降级)` : `api:${cfg.embeddingModel}`;
}