// 本地知识库：导入资料 → 按句切块 → 向量化 → 混合检索 → 注入提示词
// 参考 AstrBot 的 knowledge_base（SQLite + dense/sparse 融合 + 重排）但按本项目约束化简：
//   - 零新增依赖；向量复用现有 embedding 配置（未配置时自动走本地哈希向量）
//   - 数据按 companion_id 隔离，全部留在本机，不上传任何内容
import { cAll, cGet, cRun, dbAll, tx } from './db';
import { cId } from './companion-context';
import { errMsg, nowIso, safeJson } from './utils';
import { embed, embedOne } from './llm';
import { embedModelTag, storedEmbeddingTag } from './memory-embedding';

export const KB_MAX_DOCS = 30;
export const KB_MAX_DOC_CHARS = 60000;
export const KB_CHUNK_MAX = 420;
const KB_CHUNK_OVERLAP = 60;
const KB_TOP_K = 3;
const KB_MIN_SCORE = 0.08;
const KB_MAX_INJECT_CHARS = 1100;
const KB_SCAN_LIMIT = 800;

export interface KbDocRow {
  id: number;
  title: string;
  source: string | null;
  char_count: number;
  chunk_count: number;
  created_at: string;
}

export interface KbHit {
  title: string;
  content: string;
  score: number;
}

/**
 * 按句末标点/换行切句；超长句再按块上限硬切。
 * 保证：任何输入都能切成 ≤ KB_CHUNK_MAX 的非空块（长文本不丢内容）。
 */
export function chunkText(input: string): string[] {
  const text = String(input || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const units = text
    .split(/(?<=[。！？!?；;…\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  const flush = () => {
    const v = cur.trim();
    if (v) chunks.push(v);
    cur = '';
  };
  for (const unit of units) {
    let s = unit;
    // 超长单句：硬切（不重叠，避免块越界）
    while (s.length > KB_CHUNK_MAX) {
      flush();
      chunks.push(s.slice(0, KB_CHUNK_MAX));
      s = s.slice(KB_CHUNK_MAX);
    }
    if (!s) continue;
    if (cur && cur.length + s.length > KB_CHUNK_MAX) {
      flush();
      // 相邻块留一点重叠，避免语义被切断（重叠不越界才加）
      const prev = chunks[chunks.length - 1] ?? '';
      const carry = prev.slice(-KB_CHUNK_OVERLAP).trim();
      cur = carry && carry.length + s.length <= KB_CHUNK_MAX ? carry + s : s;
    } else {
      cur += s;
    }
  }
  flush();
  return chunks.filter((c) => c.length > 0);
}

/** 关键词重合度 0~1（中文按字二元组，不依赖分词；用于向量不可用时的兜底与融合） */
export function keywordScore(query: string, text: string): number {
  const q = bigramSet(query);
  if (!q.size) return 0;
  const t = bigramSet(text);
  let hit = 0;
  for (const g of q) if (t.has(g)) hit++;
  return hit / q.size;
}

function bigramSet(s: string): Set<string> {
  const t = String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/** 资料列表（不含正文；正文在 kb_chunks 里） */
export function listKbDocs(): KbDocRow[] {
  return cAll<KbDocRow>(
    'SELECT id, title, source, char_count, chunk_count, created_at FROM kb_docs WHERE companion_id = ? ORDER BY id DESC'
  ).map((d) => ({
    id: Number(d.id),
    title: String(d.title || ''),
    source: d.source ? String(d.source) : null,
    char_count: Number(d.char_count || 0),
    chunk_count: Number(d.chunk_count || 0),
    created_at: String(d.created_at || ''),
  }));
}

/** 导入一篇资料：正文与块先落库，再尽力生成向量（向量失败不阻塞导入，检索会用关键词兜底） */
export async function addKbDoc(
  title: string,
  source: string,
  text: string
): Promise<{ id: number; chunks: number }> {
  const t = String(title || '').trim().slice(0, 80) || '未命名资料';
  const src = String(source || '').trim().slice(0, 120);
  const body = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!body) throw new Error('资料内容为空');
  if (body.length > KB_MAX_DOC_CHARS) {
    throw new Error(`单篇资料最多 ${KB_MAX_DOC_CHARS} 字（当前 ${body.length} 字），请拆开导入`);
  }
  const count = Number(cGet<{ c: number }>('SELECT COUNT(*) AS c FROM kb_docs WHERE companion_id = ?')?.c || 0);
  if (count >= KB_MAX_DOCS) throw new Error(`最多保存 ${KB_MAX_DOCS} 篇资料，请先删除一些`);
  const chunks = chunkText(body);
  if (!chunks.length) throw new Error('资料内容为空');
  const now = nowIso();
  const id = tx(() => {
    const res = cRun(
      'INSERT INTO kb_docs (companion_id, title, source, char_count, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      t,
      src || null,
      body.length,
      chunks.length,
      now
    );
    const docId = Number(res.lastInsertRowid || 0);
    chunks.forEach((c, i) => {
      cRun(
        'INSERT INTO kb_chunks (companion_id, doc_id, seq, content, created_at) VALUES (?, ?, ?, ?, ?)',
        docId,
        i,
        c,
        now
      );
    });
    return docId;
  });
  try {
    await backfillKbEmbeddings(id);
  } catch (e) {
    // 向量服务不可用不影响导入：检索时会退回关键词匹配
    console.warn('[kb] 向量化失败，将使用关键词检索:', errMsg(e));
  }
  return { id, chunks: chunks.length };
}

/** 删除一篇资料（连同块与向量）；返回 false=不存在，避免前端谎报成功 */
export function deleteKbDoc(id: number): boolean {
  return tx(() => {
    const doc = cGet<{ id: number }>('SELECT id FROM kb_docs WHERE companion_id = ? AND id = ?', id);
    if (!doc) return false;
    cRun(
      'DELETE FROM kb_chunk_embeddings WHERE companion_id = ? AND chunk_id IN (SELECT id FROM kb_chunks WHERE companion_id = ? AND doc_id = ?)',
      id,
      id
    );
    cRun('DELETE FROM kb_chunks WHERE companion_id = ? AND doc_id = ?', id);
    cRun('DELETE FROM kb_docs WHERE companion_id = ? AND id = ?', id);
    return true;
  });
}

/** 补齐/重算向量（换过向量模型时旧向量会被识别并重算） */
export async function backfillKbEmbeddings(docId?: number, batch = 64): Promise<number> {
  const wantTag = embedModelTag();
  const where = docId ? 'AND k.doc_id = ?' : '';
  const params = docId ? [wantTag, docId, batch] : [wantTag, batch];
  const rows = dbAll<{ id: number; content: string }>(
    `SELECT k.id, k.content FROM kb_chunks k
     LEFT JOIN kb_chunk_embeddings e ON e.chunk_id = k.id
     WHERE k.companion_id = ? AND (e.chunk_id IS NULL OR e.model IS NULL OR e.model != ?) ${where}
     ORDER BY k.id ASC LIMIT ?`,
    cId(),
    ...params
  );
  if (!rows.length) return 0;
  const vecs = await embed(rows.map((r) => r.content));
  const storeTag = storedEmbeddingTag();
  let ok = 0;
  rows.forEach((r, i) => {
    const v = vecs[i];
    if (!Array.isArray(v) || !v.length) return;
    cRun(
      'INSERT OR REPLACE INTO kb_chunk_embeddings (companion_id, chunk_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      r.id,
      storeTag,
      v.length,
      JSON.stringify(v.map((x) => Math.round(x * 10000) / 10000)),
      nowIso()
    );
    ok++;
  });
  return ok;
}

/** 检索：向量余弦为主、关键词重合为辅（向量缺失时纯关键词），返回最相关的 k 段 */
export async function searchKb(query: string, k = KB_TOP_K): Promise<KbHit[]> {
  const q = String(query || '').trim();
  if (!q) return [];
  const docCount = Number(cGet<{ c: number }>('SELECT COUNT(*) AS c FROM kb_docs WHERE companion_id = ?')?.c || 0);
  if (!docCount) return [];
  const rows = dbAll<{ id: number; content: string; title: string; model: string | null; vector: string | null }>(
    `SELECT k.id, k.content, d.title, e.model, e.vector
     FROM kb_chunks k
     JOIN kb_docs d ON d.id = k.doc_id AND d.companion_id = k.companion_id
     LEFT JOIN kb_chunk_embeddings e ON e.chunk_id = k.id
     WHERE k.companion_id = ? ORDER BY k.id DESC LIMIT ?`,
    cId(),
    KB_SCAN_LIMIT
  );
  if (!rows.length) return [];
  let qv: number[] = [];
  try {
    qv = await embedOne(q);
  } catch {
    qv = [];
  }
  const tag = storedEmbeddingTag();
  const hits: KbHit[] = [];
  for (const r of rows) {
    const text = String(r.content || '');
    const vec = r.vector && r.model === tag ? safeJson<number[]>(r.vector, []) : [];
    const kw = keywordScore(q, text);
    const cos = qv.length && vec.length === qv.length ? cosine(qv, vec) : 0;
    const vecOk = qv.length > 0 && vec.length === qv.length;
    const score = vecOk ? 0.7 * cos + 0.3 * kw : kw;
    if (score >= KB_MIN_SCORE) hits.push({ title: String(r.title || ''), content: text, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.max(1, k));
}

/** 把检索结果拼成提示词块（<DATA> 包裹用户资料；引导语在外，遵循项目既有约定） */
export function formatKbBlock(hits: KbHit[]): string {
  if (!hits.length) return '';
  let body = '';
  for (const h of hits) {
    const piece = `《${h.title}》${h.content}`;
    if (body.length + piece.length > KB_MAX_INJECT_CHARS) break;
    body += (body ? '\n' : '') + piece;
  }
  if (!body) return '';
  return `【你读过的资料】<DATA>${body}</DATA>。这些是你确实看过的内容（可能是他给你的设定、日记或资料）。只有当本轮话题确实相关时，才可以自然地引用其中的细节；不要整段背诵，也不要说"根据资料""知识库"这类字眼。`;
}

/** 引擎用：检索 + 拼块，任何异常都安静降级为空（绝不打断正常回复） */
export async function buildKbBlock(query: string): Promise<string> {
  try {
    return formatKbBlock(await searchKb(query));
  } catch {
    return '';
  }
}
