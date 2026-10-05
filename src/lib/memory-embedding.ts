// 记忆向量：向量模型标识、缺失向量回填、单条记忆向量刷新
import { dbAll, dbGet, dbRun, DEFAULT_USER_ID, llmConfig } from './db';
import { nowIso } from './utils';
import { embed, embedOne } from './llm';

/** 当前向量模型标识：换模型/换接口后，旧向量会被识别出来并重新计算 */
export function embedModelTag(): string {
  try {
    const cfg = llmConfig();
    return cfg.embeddingModel ? `api:${cfg.embeddingModel}@${cfg.embeddingBaseUrl || ''}` : 'local';
  } catch {
    return 'local';
  }
}

/** 补齐缺失向量；换过向量模型/接口时，旧向量也会被识别出来并重算 */
export async function backfillEmbeddings(batch = 50): Promise<number> {
  const tag = embedModelTag();
  const rows = dbAll<{ id: number; content: string }>(
    `SELECT m.id, m.content FROM memories m
     LEFT JOIN memory_embeddings e ON e.memory_id = m.id
     WHERE m.user_id = ? AND m.status = 'active'
       AND (e.memory_id IS NULL OR e.model IS NULL OR e.model != ?)
     ORDER BY m.id DESC LIMIT ?`,
    DEFAULT_USER_ID,
    tag,
    batch
  );
  if (!rows.length) return 0;
  const vecs = await embed(rows.map((r) => r.content));
  let ok = 0;
  rows.forEach((r, i) => {
    const v = vecs[i];
    // 逐条校验：部分失败时长度不足会让 vecs[i].length 直接抛 TypeError 中断整批
    if (!Array.isArray(v) || !v.length) return;
    dbRun(
      `INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)`,
      r.id,
      tag,
      v.length,
      JSON.stringify(v.map((x) => Math.round(x * 10000) / 10000)),
      nowIso()
    );
    ok++;
  });
  return ok;
}

/** 单条记忆内容被编辑后：同步重算它的向量 */
export async function refreshMemoryEmbedding(id: number): Promise<boolean> {
  const row = dbGet<{ id: number; content: string }>('SELECT id, content FROM memories WHERE id = ? AND user_id = ?', id, DEFAULT_USER_ID);
  if (!row) return false;
  const vec = await embedOne(String(row.content || ''));
  dbRun(
    `INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)`,
    id,
    embedModelTag(),
    vec.length,
    JSON.stringify(vec.map((x) => Math.round(x * 10000) / 10000)),
    nowIso()
  );
  return true;
}