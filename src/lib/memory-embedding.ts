// 记忆向量：向量模型标识、缺失向量回填、单条记忆向量刷新
import { dbRun, cAll, cGet, llmConfig } from './db';
import { nowIso, safeJson } from './utils';
import { embed, embedOne } from './llm';
import { embeddingApiDegraded } from './llm-embedding';

/** 当前向量模型标识：换模型/换接口后，旧向量会被识别出来并重新计算 */
export function embedModelTag(): string {
  try {
    const cfg = llmConfig();
    return cfg.embeddingModel ? `api:${cfg.embeddingModel}@${cfg.embeddingBaseUrl || ''}` : 'local';
  } catch {
    return 'local';
  }
}

/** 本地降级向量的独立标识：与上面的 API 期望标识不同 → API 恢复后能被 backfillEmbeddings 识别并重算 */
const DEGRADED_EMBED_TAG = 'local-degraded';

/**
 * 写入时实际使用的向量标识。
 * - API 正常（或未配置接口走本地哈希）→ 与 embedModelTag 一致；
 * - API 配置了但当前降级为本地兜底 → 用独立标识，保证旧降级向量在接口恢复后被重算，
 *   而不是被当成"已经是 API 向量"而永久检索不到。
 */
export function storedEmbeddingTag(): string {
  try {
    const cfg = llmConfig();
    if (cfg.embeddingModel && embeddingApiDegraded()) return DEGRADED_EMBED_TAG;
    return embedModelTag();
  } catch {
    return embedModelTag();
  }
}

/* ------------------------------------------------------------------ */
/* 向量解析缓存：检索每轮都会重复 JSON.parse 同一批行，按 memory_id 缓存解析结果   */
/* 正确性保证：命中要求"原始 JSON 字符串完全一致"，任何写入导致内容变化都会自动失效 */
/* ------------------------------------------------------------------ */
const MEM_VEC_CACHE_MAX = 2000;
interface CachedVec {
  json: string | null;
  vec: number[];
}
const memVecCache = new Map<number, CachedVec>();

/** 取（并缓存）某条记忆的解析后向量；json 与缓存不一致时重新解析，保证结果与直接 safeJson 完全一致 */
export function getMemoryVector(id: number, json: string | null): number[] {
  const hit = memVecCache.get(id);
  if (hit && hit.json === json) return hit.vec;
  const vec = safeJson<number[]>(json, []);
  if (memVecCache.size >= MEM_VEC_CACHE_MAX && !memVecCache.has(id)) {
    const oldest = memVecCache.keys().next().value;
    if (oldest !== undefined) memVecCache.delete(oldest);
  }
  memVecCache.set(id, { json, vec });
  return vec;
}

/** 某条记忆向量被重写/删除后失效对应缓存 */
export function invalidateMemoryVectorCache(id: number): void {
  memVecCache.delete(id);
}

/** 清空全部向量解析缓存（重置记忆时使用） */
export function clearMemoryVectorCache(): void {
  memVecCache.clear();
}

/** 补齐缺失向量；换过向量模型/接口时，旧向量也会被识别出来并重算 */
export async function backfillEmbeddings(batch = 50): Promise<number> {
  const queryTag = embedModelTag();
  const rows = cAll<{ id: number; content: string }>(
    `SELECT m.id, m.content FROM memories m
     LEFT JOIN memory_embeddings e ON e.memory_id = m.id
     WHERE m.companion_id = ? AND m.status = 'active'
       AND (e.memory_id IS NULL OR e.model IS NULL OR e.model != ?)
     ORDER BY m.id DESC LIMIT ?`,
    queryTag,
    batch
  );
  if (!rows.length) return 0;
  const vecs = await embed(rows.map((r) => r.content));
  // 本次实际写入用的标识：接口仍失败时写降级标识，避免把本地向量冒充成 API 向量
  const storeTag = storedEmbeddingTag();
  let ok = 0;
  rows.forEach((r, i) => {
    const v = vecs[i];
    // 逐条校验：部分失败时长度不足会让 vecs[i].length 直接抛 TypeError 中断整批
    if (!Array.isArray(v) || !v.length) return;
    dbRun(
      `INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)`,
      r.id,
      storeTag,
      v.length,
      JSON.stringify(v.map((x) => Math.round(x * 10000) / 10000)),
      nowIso()
    );
    invalidateMemoryVectorCache(r.id);
    ok++;
  });
  return ok;
}

/** 单条记忆内容被编辑后：同步重算它的向量 */
export async function refreshMemoryEmbedding(id: number): Promise<boolean> {
  const row = cGet<{ id: number; content: string }>('SELECT id, content FROM memories WHERE companion_id = ? AND id = ?', id);
  if (!row) return false;
  const vec = await embedOne(String(row.content || ''));
  dbRun(
    `INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)`,
    id,
    storedEmbeddingTag(),
    vec.length,
    JSON.stringify(vec.map((x) => Math.round(x * 10000) / 10000)),
    nowIso()
  );
  invalidateMemoryVectorCache(id);
  return true;
}