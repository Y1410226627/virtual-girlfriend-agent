// 记忆系统：向量检索 + 关键词/重要度/新鲜度/阶段相关度评分 + 去重 + 遗忘 + 摘要
import { dbAll, dbGet, dbRun, DEFAULT_USER_ID, numSetting } from './db';
import { cosine, nowIso, hoursSince, daysSince, clamp, round1, safeJson } from './utils';
import { embed, embedOne } from './llm';
import type { MemoryRow, MemoryUpdate } from './types';
import { getRelationshipState } from './relationship';

const TYPE_LABELS: Record<string, string> = {
  semantic: '事实',
  episodic: '事件',
  emotional: '情绪',
  relationship: '关系',
  summary: '回顾',
  personality: '性格',
  attachment: '依恋',
};

export function typeLabel(t: string): string {
  return TYPE_LABELS[t] || t;
}

/* ---------------------- 写入 ---------------------- */
export async function addMemory(
  update: MemoryUpdate,
  sourceMessageId?: number | null
): Promise<number | null> {
  const content = String(update.content || '').trim();
  if (content.length < 2) return null;
  const type = update.type || 'episodic';
  const importance = clamp(Number(update.importance) || 5, 0, 10);

  const vec = await embedOne(content);

  // 去重：向量相似度 > 0.9 合并；同一属性新值覆盖旧值（保留历史版本）
  const existing = dbAll<MemoryRow & { vector: string | null }>(
    `SELECT m.*, e.vector AS vector FROM memories m
     LEFT JOIN memory_embeddings e ON e.memory_id = m.id
     WHERE m.user_id = ? AND m.status = 'active' AND m.type = ?
     ORDER BY m.id DESC LIMIT 200`,
    DEFAULT_USER_ID,
    type
  );

  let best: { row: (typeof existing)[number]; sim: number } | null = null;
  for (const row of existing) {
    const v = safeJson<number[]>(row.vector, []);
    if (!v.length) continue;
    const sim = cosine(vec, v);
    if (!best || sim > best.sim) best = { row, sim };
  }

  if (best && best.sim > 0.92) {
    // 合并：保留更重要的版本
    if (importance > Number(best.row.importance)) {
      dbRun(
        'UPDATE memories SET importance = ?, content = ?, emotion = COALESCE(?, emotion), last_accessed_at = ? WHERE id = ?',
        importance,
        content,
        update.emotion || null,
        nowIso(),
        best.row.id
      );
    }
    return best.row.id;
  }

  const expiry =
    update.expires_at || (type === 'episodic' && importance < 4 ? null : null);

  const { lastInsertRowid: id } = dbRun(
    `INSERT INTO memories (user_id, type, content, importance, emotion, source_message_id, created_at, last_accessed_at, expires_at, status, access_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'active', 0)`,
    DEFAULT_USER_ID,
    type,
    content,
    importance,
    update.emotion || null,
    sourceMessageId ?? null,
    nowIso(),
    expiry
  );

  dbRun(
    `INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)`,
    id,
    'auto',
    vec.length,
    JSON.stringify(vec.map((x) => Math.round(x * 10000) / 10000)),
    nowIso()
  );

  // 同一属性被新值覆盖 → 旧记录标记 superseded（保留历史）
  if (best && best.sim > 0.85 && (type === 'semantic' || type === 'relationship')) {
    dbRun("UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?", id, best.row.id);
  }

  return id;
}

/* ---------------------- 检索评分 ---------------------- */
/**
 * score = 0.5 * 向量相似度 + 0.2 * 重要度 + 0.15 * 时间新鲜度 + 0.15 * 关系阶段相关度
 * 重要事实不衰减；普通事件半衰期 14 天
 */
export async function retrieveMemories(query: string, topK?: number): Promise<MemoryRow[]> {
  const k = topK ?? Math.max(3, numSetting('memory_top_k', 8));
  const qVec = await embedOne(query);
  const stage = getRelationshipState().stage;

  const rows = dbAll<MemoryRow & { vector: string | null }>(
    `SELECT m.*, e.vector AS vector FROM memories m
     LEFT JOIN memory_embeddings e ON e.memory_id = m.id
     WHERE m.user_id = ? AND m.status = 'active'
       AND (m.expires_at IS NULL OR m.expires_at > ?)
     ORDER BY m.id DESC LIMIT 800`,
    DEFAULT_USER_ID,
    nowIso()
  );

  const scored = rows.map((row) => {
    const v = safeJson<number[]>(row.vector, []);
    const vecSim = v.length ? Math.max(0, cosine(qVec, v)) : 0;
    const importance = Number(row.importance) / 10;

    const ageDays = daysSince(row.created_at);
    const halfLife = Number(row.importance) >= 8 ? 100000 : 14; // 重要事实不衰减
    const recency = Math.exp(-ageDays / halfLife);

    let stageRel = 0.8;
    if (row.type === 'relationship' || row.type === 'attachment') stageRel = stage >= 2 ? 1 : 0.6;
    else if (row.type === 'episodic' || row.type === 'emotional') stageRel = 1;
    else if (row.type === 'semantic') stageRel = 0.9;

    const score = 0.5 * vecSim + 0.2 * importance + 0.15 * recency + 0.15 * stageRel;
    return { row, score, vecSim };
  });

  scored.sort((a, b) => b.score - a.score);
  const picked = scored.filter((s) => s.vecSim > 0.05 || Number(s.row.importance) >= 8).slice(0, k).map((s) => s.row);
  const fallback = picked.length ? picked : scored.slice(0, Math.min(2, k)).map((s) => s.row);

  // 更新访问时间
  for (const m of fallback) {
    dbRun(
      'UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?',
      nowIso(),
      m.id
    );
  }
  return fallback;
}

/** 与当前话题相关的记忆（不做向量，纯类型筛选，用于关系/依恋记忆注入） */
export function memoriesByType(types: string[], limit = 6): MemoryRow[] {
  const placeholders = types.map(() => '?').join(',');
  return dbAll<MemoryRow>(
    `SELECT * FROM memories WHERE user_id = ? AND status = 'active' AND type IN (${placeholders})
     ORDER BY importance DESC, id DESC LIMIT ?`,
    DEFAULT_USER_ID,
    ...types,
    limit
  );
}

/**
 * 稳定事实：高重要度的语义记忆（名字、生日、偏好、习惯…）。
 * 与"按当前话题检索"互补——保证无论聊什么，这些事永远在她的脑子里，不会重复问。
 */
export function stableFacts(limit = 12): MemoryRow[] {
  return dbAll<MemoryRow>(
    `SELECT * FROM memories WHERE user_id = ? AND status = 'active' AND type = 'semantic' AND importance >= 6
     ORDER BY importance DESC, id DESC LIMIT ?`,
    DEFAULT_USER_ID,
    limit
  );
}

export function formatMemoryBlock(list: MemoryRow[]): string {
  if (!list.length) return '（暂时没有相关记忆）';
  return list
    .map((m) => {
      const d = new Date(m.created_at);
      const when = `${d.getMonth() + 1}月${d.getDate()}日`;
      const emotion = m.emotion ? `·${m.emotion}` : '';
      return `- [${typeLabel(m.type)}${emotion}·${when}] ${m.content}`;
    })
    .join('\n');
}

/* ---------------------- 遗忘 / 归档 ---------------------- */
/** 低重要度且 30 天未检索 → 归档；过期的 → 归档 */
export function forgetSweep(): number {
  const { changes: c1 } = dbRun(
    `UPDATE memories SET status = 'archived' WHERE user_id = ? AND status = 'active'
       AND importance <= 3
       AND (last_accessed_at IS NULL OR last_accessed_at < ?)
       AND created_at < ?`,
    DEFAULT_USER_ID,
    new Date(Date.now() - 30 * 86400000).toISOString(),
    new Date(Date.now() - 30 * 86400000).toISOString()
  );
  const { changes: c2 } = dbRun(
    `UPDATE memories SET status = 'archived' WHERE user_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at < ?`,
    DEFAULT_USER_ID,
    nowIso()
  );
  return c1 + c2;
}

/* ---------------------- 管理（记忆页） ---------------------- */
export function listMemories(opts: { type?: string; status?: string; limit?: number } = {}): MemoryRow[] {
  const { type, status = 'active', limit = 300 } = opts;
  if (type) {
    return dbAll<MemoryRow>(
      'SELECT * FROM memories WHERE user_id = ? AND status = ? AND type = ? ORDER BY created_at DESC LIMIT ?',
      DEFAULT_USER_ID,
      status,
      type,
      limit
    );
  }
  return dbAll<MemoryRow>(
    'SELECT * FROM memories WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?',
    DEFAULT_USER_ID,
    status,
    limit
  );
}

export function updateMemory(id: number, fields: { content?: string; importance?: number; emotion?: string; status?: string }) {
  const cur = dbGet<MemoryRow>('SELECT * FROM memories WHERE id = ? AND user_id = ?', id, DEFAULT_USER_ID);
  if (!cur) return false;
  dbRun(
    'UPDATE memories SET content = ?, importance = ?, emotion = ?, status = ? WHERE id = ?',
    fields.content ?? cur.content,
    fields.importance !== undefined ? clamp(Number(fields.importance), 0, 10) : cur.importance,
    fields.emotion ?? cur.emotion,
    fields.status ?? cur.status,
    id
  );
  return true;
}

export function deleteMemory(id: number): boolean {
  dbRun('DELETE FROM memory_embeddings WHERE memory_id = ?', id);
  const { changes } = dbRun('DELETE FROM memories WHERE id = ? AND user_id = ?', id, DEFAULT_USER_ID);
  return changes > 0;
}

export function createMemoryManually(type: string, content: string, importance = 6, emotion?: string): number {
  const { lastInsertRowid } = dbRun(
    `INSERT INTO memories (user_id, type, content, importance, emotion, created_at, status, access_count)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 0)`,
    DEFAULT_USER_ID,
    type,
    content,
    clamp(importance, 0, 10),
    emotion || null,
    nowIso()
  );
  return lastInsertRowid;
}

/** 补齐缺失的向量（例如手工新增的记忆） */
export async function backfillEmbeddings(): Promise<number> {
  const rows = dbAll<any>(
    `SELECT m.id, m.content FROM memories m
     LEFT JOIN memory_embeddings e ON e.memory_id = m.id
     WHERE m.user_id = ? AND e.memory_id IS NULL LIMIT 50`,
    DEFAULT_USER_ID
  );
  if (!rows.length) return 0;
  const vecs = await embed(rows.map((r) => r.content));
  rows.forEach((r, i) => {
    dbRun(
      `INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)`,
      r.id,
      'auto',
      vecs[i].length,
      JSON.stringify(vecs[i].map((x) => Math.round(x * 10000) / 10000)),
      nowIso()
    );
  });
  return rows.length;
}

/* ---------------------- 每日摘要 ---------------------- */
export function saveDailySummary(date: string, summary: string, meta?: any): void {
  dbRun(
    `INSERT INTO daily_summaries (user_id, date, summary, meta, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET summary = excluded.summary, meta = excluded.meta, created_at = excluded.created_at`,
    DEFAULT_USER_ID,
    date,
    summary,
    meta ? JSON.stringify(meta) : null,
    nowIso()
  );
}

export function listDailySummaries(limit = 60) {
  return dbAll<any>(
    'SELECT * FROM daily_summaries WHERE user_id = ? ORDER BY date DESC LIMIT ?',
    DEFAULT_USER_ID,
    limit
  );
}

export function recentMessagesForSummary(date: string) {
  return dbAll<any>(
    `SELECT m.*, p.agent_name FROM messages m LEFT JOIN personas p ON p.user_id = m.user_id
     WHERE m.user_id = ? AND date(m.created_at, 'localtime') = ? ORDER BY m.id ASC`,
    DEFAULT_USER_ID,
    date
  );
}

export function memoryStats() {
  const rows = dbAll<{ type: string; c: number }>(
    "SELECT type, COUNT(*) AS c FROM memories WHERE user_id = ? AND status = 'active' GROUP BY type",
    DEFAULT_USER_ID
  );
  const total = dbAll<{ c: number }>(
    "SELECT COUNT(*) AS c FROM memories WHERE user_id = ? AND status = 'active'",
    DEFAULT_USER_ID
  )[0];
  const archived = dbAll<{ c: number }>(
    "SELECT COUNT(*) AS c FROM memories WHERE user_id = ? AND status = 'archived'",
    DEFAULT_USER_ID
  )[0];
  return {
    total: Number(total?.c || 0),
    archived: Number(archived?.c || 0),
    byType: rows.map((r) => ({ type: r.type, label: typeLabel(r.type), count: Number(r.c) })),
  };
}