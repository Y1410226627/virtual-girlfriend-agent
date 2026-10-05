// 记忆系统：向量检索 + 关键词/重要度/新鲜度/阶段相关度评分 + 去重 + 遗忘 + 摘要
import { dbAll, dbGet, dbRun, tx, DEFAULT_USER_ID, numSetting } from './db';
import { cosine, nowIso, daysSince, clamp, truncate, errMsg } from './utils';
import { embed, embedOne } from './llm';
import type { MemoryRow, MessageRow, MemoryUpdate } from './types';
import { getRelationshipState } from './relationship';
import {
  storedEmbeddingTag,
  getMemoryVector,
  invalidateMemoryVectorCache,
  clearMemoryVectorCache,
} from './memory-embedding';

export { backfillEmbeddings, refreshMemoryEmbedding } from './memory-embedding';

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

interface DailySummaryRow {
  id: number;
  user_id: number;
  date: string;
  summary: string;
  meta: string | null;
  created_at: string;
}

/* ---------------------- 写入 ---------------------- */
/** 记忆写入输入：在 MemoryUpdate 之上附加可选的事实键（P1-20） */
export interface MemoryUpdateInput extends MemoryUpdate {
  /** 事实键：同一事实的稳定标识（如 preference.drink / identity.job / identity.city）；缺省则回退向量判重 */
  fact_key?: string | null;
}

/** 归一化事实键：仅接受非空字符串，trim 后限长 40 字 */
export function normalizeFactKey(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, 40) : null;
}

export async function addMemory(
  update: MemoryUpdateInput,
  sourceMessageId?: number | null
): Promise<number | null> {
  const content = String(update.content || '').trim();
  if (content.length < 2) return null;
  const vec = await embedOne(content);
  // 一次逻辑写入的所有语句放进同一事务：避免"记忆已写入但向量缺失/脱节"的中间态
  return tx(() => writeMemorySync(update, content, vec, sourceMessageId));
}

/**
 * 同步写入单条记忆（向量已算好）——单条 addMemory 与批量 addMemoriesBatch 共用。
 * 判重：有 fact_key 时以事实键为准（同一事实换说法 → supersede 旧条）；缺省时回退原向量相似度路径。
 * 必须由调用方包在事务内。
 */
function writeMemorySync(
  update: MemoryUpdateInput,
  content: string,
  vec: number[],
  sourceMessageId?: number | null
): number {
  const type = update.type || 'episodic';
  const importance = clamp(Number(update.importance) || 5, 0, 10);
  const factKey = normalizeFactKey(update.fact_key);
  const expiry = update.expires_at || null;
  const now = nowIso();
  const storeVec = () => JSON.stringify(vec.map((x) => Math.round(x * 10000) / 10000));

  // ---- P1-20：有事实键时以事实键判重（同一事实换说法 → 覆盖旧条，保留历史版本） ----
  if (factKey) {
    const sameFact = dbAll<MemoryRow>(
      `SELECT * FROM memories WHERE user_id = ? AND status = 'active' AND fact_key = ? ORDER BY id DESC LIMIT 20`,
      DEFAULT_USER_ID,
      factKey
    );
    const target = sameFact[0];
    // 内容几乎一致 → 视为重复上报，不新建也不覆盖，只续命
    if (target && correctionTextScore(content, String(target.content || '')) >= 0.9) {
      dbRun('UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?', now, target.id);
      return target.id;
    }
    const { lastInsertRowid: id } = dbRun(
      `INSERT INTO memories (user_id, type, content, importance, emotion, source_message_id, fact_key, created_at, last_accessed_at, expires_at, status, access_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'active', 0)`,
      DEFAULT_USER_ID,
      type,
      content,
      importance,
      update.emotion || null,
      sourceMessageId ?? null,
      factKey,
      now,
      expiry
    );
    dbRun(
      `INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)`,
      id,
      storedEmbeddingTag(),
      vec.length,
      storeVec(),
      now
    );
    invalidateMemoryVectorCache(id);
    // 同一事实键的旧 active 条统一标记 superseded，指向新条（保留历史）
    for (const row of sameFact) {
      dbRun("UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?", id, row.id);
    }
    return id;
  }

  // ---- 无事实键：原向量相似度路径（保持旧行为） ----
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
    const v = getMemoryVector(row.id, row.vector);
    if (!v.length) continue;
    const sim = cosine(vec, v);
    if (!best || sim > best.sim) best = { row, sim };
  }

  const isFactType = type === 'semantic' || type === 'relationship';
  const contentChanged = !!best && String(best.row.content || '').trim() !== content;

  // 原地合并的判定：
  // - 极高相似（>0.92）且（非事实类，或事实类但说法一致）
  // - 灰区（0.85~0.92）的非事实类近似：同类相近应合并，避免两条近似记忆同时 active 挤占 top_k
  // 事实类的新说法不在这里吞掉：走插入 + 把旧值标 superseded，保留历史版本
  const oldContent = best ? String(best.row.content || '').trim() : '';
  const grayZone = !!best && best.sim > 0.85 && best.sim <= 0.92;
  const mergeInPlace =
    !!best && !(isFactType && contentChanged) && (best.sim > 0.92 || (!isFactType && grayZone));

  if (best && mergeInPlace) {
    // 灰区合并保留信息更全的一条（更长者），避免用较短的近义句覆盖掉完整信息
    const finalContent = grayZone && oldContent.length > content.length ? oldContent : content;
    const newImportance = Math.max(Number(best.row.importance) || 0, importance);
    dbRun(
      `UPDATE memories SET importance = ?, content = ?, emotion = COALESCE(?, emotion),
         source_message_id = COALESCE(?, source_message_id), last_accessed_at = ?, access_count = access_count + 1
       WHERE id = ?`,
      newImportance,
      finalContent,
      update.emotion || null,
      sourceMessageId ?? null,
      now,
      best.row.id
    );
    if (finalContent !== oldContent) {
      // 内容变了向量必须重算，否则检索会和内容脱节
      dbRun(
        `INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)`,
        best.row.id,
        storedEmbeddingTag(),
        vec.length,
        storeVec(),
        now
      );
      invalidateMemoryVectorCache(best.row.id);
    }
    return best.row.id;
  }

  const { lastInsertRowid: id } = dbRun(
    `INSERT INTO memories (user_id, type, content, importance, emotion, source_message_id, created_at, last_accessed_at, expires_at, status, access_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'active', 0)`,
    DEFAULT_USER_ID,
    type,
    content,
    importance,
    update.emotion || null,
    sourceMessageId ?? null,
    now,
    expiry
  );

  dbRun(
    `INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)`,
    id,
    storedEmbeddingTag(),
    vec.length,
    storeVec(),
    now
  );
  invalidateMemoryVectorCache(id);

  // 同一属性被新值覆盖 → 旧记录标记 superseded（保留历史）
  if (best && best.sim > 0.85 && isFactType) {
    dbRun("UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?", id, best.row.id);
  }

  return id;
}

/**
 * 批量写入记忆（P1-23）：一次 embed(texts) 算完全部向量，再在同一事务内逐条判重 + 同步插入。
 * 逐条用嵌套 savepoint 隔离：单条失败只跳过它，不影响整批（保持分析阶段逐条容错的语义）。
 * 返回与入参等长的 id 数组（写不进去的位置为 null）。
 */
export async function addMemoriesBatch(
  updates: MemoryUpdateInput[],
  sourceMessageId?: number | null
): Promise<Array<number | null>> {
  const items = updates.map((u) => ({ update: u, content: String(u.content || '').trim() }));
  const embeddable = items.filter((x) => x.content.length >= 2);
  if (!embeddable.length) return items.map(() => null);

  const vecs = await embed(embeddable.map((x) => x.content));
  const vecByIndex = new Map<number, number[]>();
  embeddable.forEach((x, k) => vecByIndex.set(items.indexOf(x), vecs[k] ?? []));

  const ids: Array<number | null> = items.map(() => null);
  tx(() => {
    items.forEach((it, i) => {
      if (it.content.length < 2) return;
      try {
        // 嵌套 tx → savepoint：单条失败仅回滚该条
        ids[i] = tx(() => writeMemorySync(it.update, it.content, vecByIndex.get(i) || [], sourceMessageId));
      } catch (e) {
        console.warn('[memory] 批量写入单条失败:', errMsg(e));
      }
    });
  });
  return ids;
}

/* ---------------------- 记忆纠正（用户明确指出她记错了） ---------------------- */
/** 中文按 2-gram 切分的字符集合：无空格文本也能粗略衡量重合度 */
function charBigrams(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/**
 * 文本兜底相似度（向量缺失/失败时使用）。
 * 只有"几乎就是同一条记忆"才给高分，避免共享一个常见词的误判：
 * - 完全一致 → 1（名字纠正这类短文本也成立）
 * - 包含关系仅在短句覆盖长句 ≥80% 且长句不超过短句 2 倍时 → 1，否则证据不足 → 0.5
 * - 其余走 2-gram Jaccard，但任一条 <6 字直接判 0（中文短句 2-gram 覆盖率天然偏高）
 */
function correctionTextScore(hint: string, content: string): number {
  const h = hint.replace(/\s+/g, '');
  const c = content.replace(/\s+/g, '');
  if (!h || !c) return 0;
  if (h === c) return 1;
  const short = h.length <= c.length ? h : c;
  const long = h.length <= c.length ? c : h;
  if (long.includes(short)) {
    if (short.length >= 4 && short.length >= 0.8 * long.length && long.length <= 2 * short.length) return 1;
    return 0.5;
  }
  if (h.length < 6 || c.length < 6) return 0;
  const A = charBigrams(h);
  const B = charBigrams(c);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 记忆纠正：用户明确纠正她记错的事实时调用。
 * 优先用 oldFactKey（事实键）精确命中目标；没有键或键没命中时回退向量/文本相似度。
 * 找到目标 → 标记 status='superseded' 并把 superseded_by 指向新记忆，再插入新的正确语义记忆；
 * 没命中就只插入新记忆。全程在一个事务里完成，只改状态字段，不删除任何数据。
 */
export async function applyMemoryCorrection(
  oldHint: string,
  newFact: string,
  sourceMessageId?: number | null,
  oldFactKey?: string | null
): Promise<{ newMemoryId: number | null; supersededId: number | null }> {
  const hint = String(oldHint || '').trim();
  const fact = String(newFact || '').trim();
  if (fact.length < 2) return { newMemoryId: null, supersededId: null };
  const oldKey = normalizeFactKey(oldFactKey);

  // 向量计算放在事务外：embed 是异步的，事务体必须保持同步才能保证原子性
  let hintVec: number[] = [];
  if (hint) {
    try {
      hintVec = await embedOne(hint);
    } catch {
      hintVec = [];
    }
  }
  const factVec = await embedOne(fact);

  return tx(() => {
    // 1) 有 old_fact_key → 优先按事实键精确命中目标记忆
    let target: MemoryRow | null = null;
    if (oldKey) {
      const byKey = dbGet<MemoryRow>(
        `SELECT * FROM memories WHERE user_id = ? AND status = 'active' AND fact_key = ? ORDER BY id DESC LIMIT 1`,
        DEFAULT_USER_ID,
        oldKey
      );
      if (byKey) target = byKey;
    }

    // 2) 无键 / 键没命中 → 回退：在 active 语义记忆里找最相近的旧记忆（向量优先，缺失/失败用文本兜底）
    if (!target) {
      const candidates = dbAll<MemoryRow & { vector: string | null }>(
        `SELECT m.*, e.vector AS vector FROM memories m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id
         WHERE m.user_id = ? AND m.status = 'active' AND m.type = 'semantic'
         ORDER BY m.id DESC LIMIT 400`,
        DEFAULT_USER_ID
      );

      let best: { row: MemoryRow; sim: number } | null = null;
      for (const row of candidates) {
        const v = getMemoryVector(row.id, row.vector);
        const vecSim = hintVec.length && v.length ? Math.max(0, cosine(hintVec, v)) : 0;
        const textSim = hint ? correctionTextScore(hint, String(row.content || '')) : 0;
        const sim = Math.max(vecSim, textSim);
        if (!best || sim > best.sim) best = { row, sim };
      }

      // 阈值上调：文本兜底只在"几乎同一条"时接近满分，0.62 以上才认作同一件事，避免误伤相近但不同的记忆
      if (best && best.sim >= 0.62) target = best.row;
    }

    // 3) 插入新的正确记忆（importance 8；沿用 old_fact_key，保持该事实的稳定标识）
    const { lastInsertRowid: newId } = dbRun(
      `INSERT INTO memories (user_id, type, content, importance, emotion, source_message_id, fact_key, created_at, last_accessed_at, expires_at, status, access_count)
       VALUES (?, 'semantic', ?, 8, NULL, ?, ?, ?, NULL, NULL, 'active', 0)`,
      DEFAULT_USER_ID,
      fact,
      sourceMessageId ?? null,
      oldKey,
      nowIso()
    );
    dbRun(
      `INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)`,
      newId,
      storedEmbeddingTag(),
      factVec.length,
      JSON.stringify(factVec.map((x) => Math.round(x * 10000) / 10000)),
      nowIso()
    );
    invalidateMemoryVectorCache(newId);

    // 4) 命中旧记忆 → 标记 superseded 并指向新记忆（保留历史，不删除）
    let supersededId: number | null = null;
    if (target) {
      dbRun("UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?", newId, target.id);
      supersededId = target.id;
    }

    return { newMemoryId: newId, supersededId };
  });
}

/* ---------------------- 检索评分 ---------------------- */
export interface RetrieveMemoriesOptions {
  /** 额外查询：与主查询并行检索，合并后取最大相似度（用于多角度命中同一条记忆） */
  extraQueries?: string[];
  topK?: number;
}

/** 单条记忆在某次检索中的命中（id + 相似度） */
export interface QueryHit {
  id: number;
  sim: number;
}

/**
 * 纯函数：把"每个查询各返回的一批 {id, sim}"按 id 合并去重——
 * 同一条记忆取各查询中的**最大相似度**，再按相似度降序（同分按 id 稳定）排列。
 * 这是多查询检索的 rerank 核心，抽出来便于脱离网络做确定性测试。
 */
export function mergeQueryHits(hitLists: QueryHit[][]): QueryHit[] {
  const best = new Map<number, number>();
  for (const hits of hitLists) {
    for (const h of hits) {
      const cur = best.get(h.id);
      if (cur === undefined || h.sim > cur) best.set(h.id, h.sim);
    }
  }
  return [...best.entries()]
    .map(([id, sim]) => ({ id, sim }))
    .sort((a, b) => b.sim - a.sim || a.id - b.id);
}

/** 兼容旧调用：第二参数既可以是 topK 数字，也可以是选项对象 */
function normalizeRetrieveOptions(opts?: number | RetrieveMemoriesOptions): RetrieveMemoriesOptions {
  if (typeof opts === 'number') return { topK: opts };
  return opts ?? {};
}

/**
 * score = 0.5 * 向量相似度 + 0.2 * 重要度 + 0.15 * 时间新鲜度 + 0.15 * 关系阶段相关度
 * 重要事实不衰减；普通事件半衰期 14 天
 *
 * 多查询：主查询与各 extraQuery 并行 embed，分别对候选打分后按 id 合并取最大相似度，再 rerank 取 topK。
 * 只传 query（或旧的数字 topK）时与原行为等价。
 */
export async function retrieveMemories(
  query: string,
  opts?: number | RetrieveMemoriesOptions
): Promise<MemoryRow[]> {
  const { extraQueries, topK } = normalizeRetrieveOptions(opts);
  const k = topK ?? Math.max(3, numSetting('memory_top_k', 8));

  // 主查询 + 额外查询去重后并行 embed；全为空时退化为空串（与原行为一致）
  const nonEmpty = [query, ...(extraQueries || [])].map((q) => String(q || '').trim()).filter(Boolean);
  const uniqueQueries = nonEmpty.length ? [...new Set(nonEmpty)] : [''];
  const qVecs = await Promise.all(uniqueQueries.map((q) => embedOne(q)));

  const stage = getRelationshipState().stage;

  const rows = dbAll<MemoryRow & { vector: string | null }>(
    `SELECT m.*, e.vector AS vector FROM memories m
     LEFT JOIN memory_embeddings e ON e.memory_id = m.id
     WHERE m.user_id = ? AND m.status = 'active'
       AND (m.expires_at IS NULL OR m.expires_at > ?)
       AND (
         m.id IN (SELECT id FROM memories WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 600)
         OR m.importance >= 7
         OR (m.last_accessed_at IS NOT NULL AND m.last_accessed_at > ?)
       )
     ORDER BY m.id DESC LIMIT 1500`,
    DEFAULT_USER_ID,
    nowIso(),
    DEFAULT_USER_ID,
    new Date(Date.now() - 30 * 86400000).toISOString()
  );

  // 每个查询各自给所有候选算相似度（向量只解析一次），再按 id 合并取最大相似度
  const hitLists: QueryHit[][] = qVecs.map((qVec) =>
    rows.map((row) => {
      const v = getMemoryVector(row.id, row.vector);
      return { id: row.id, sim: v.length ? Math.max(0, cosine(qVec, v)) : 0 };
    })
  );
  const merged = mergeQueryHits(hitLists);
  const rowById = new Map(rows.map((r) => [r.id, r] as const));

  const scored = merged
    .map((hit) => {
      const row = rowById.get(hit.id)!;
      const vecSim = hit.sim;
      const importance = Number(row.importance) / 10;

      // 新鲜度以"最后一次被想起"为准（被回忆的记忆会续命，不再只看出生日期）
      const ageDays = daysSince(row.last_accessed_at || row.created_at);
      const halfLife = Number(row.importance) >= 8 ? 100000 : 14; // 重要事实不衰减
      const recency = Math.exp(-ageDays / halfLife);

      let stageRel = 0.8;
      if (row.type === 'relationship' || row.type === 'attachment') stageRel = stage >= 2 ? 1 : 0.6;
      else if (row.type === 'episodic' || row.type === 'emotional') stageRel = 1;
      else if (row.type === 'semantic') stageRel = 0.9;

      const score = 0.5 * vecSim + 0.2 * importance + 0.15 * recency + 0.15 * stageRel;
      return { row, score, vecSim };
    })
    .sort((a, b) => b.score - a.score);
  const maxSim = scored.length ? Math.max(...scored.map((s) => s.vecSim)) : 0;
  // 入选门槛：绝对相关 / 相对最高分 / 高重要度（原来 vecSim>0.05 几乎等于"随便选"，噪声挤占名额）
  const picked = scored
    .filter((s) => {
      if (Number(s.row.importance) >= 8) return true;
      if (s.vecSim >= 0.3) return true;
      return maxSim >= 0.3 && s.vecSim >= 0.55 * maxSim && s.vecSim >= 0.18;
    })
    .slice(0, k)
    .map((s) => s.row);
  const fallback = picked.length ? picked : scored.slice(0, Math.min(2, k)).map((s) => s.row);

  // 只有真正命中的记忆才算"被想起"（兜底返回的不计入，避免 access_count 被污染）
  for (const m of picked) {
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
    `SELECT * FROM memories WHERE user_id = ? AND status = 'active' AND type = 'semantic' AND importance >= 5
     ORDER BY importance DESC, id DESC LIMIT ?`,
    DEFAULT_USER_ID,
    limit
  );
}

/**
 * 把记忆格式化为注入 system 的文本。
 * 记忆内容来自用户/模型，属于"数据"而非指令 → 统一包在 <DATA> 里（配合 system 里的防注入声明）。
 */
export function formatMemoryBlock(list: MemoryRow[]): string {
  if (!list.length) return '（暂时没有相关记忆）';
  const body = list
    .map((m) => {
      const d = new Date(m.created_at);
      const when = `${d.getMonth() + 1}月${d.getDate()}日`;
      const emotion = m.emotion ? `·${m.emotion}` : '';
      return `- [${typeLabel(m.type)}${emotion}·${when}] ${m.content}`;
    })
    .join('\n');
  return `<DATA>\n${body}\n</DATA>`;
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
  return tx(() => {
    dbRun('DELETE FROM memory_embeddings WHERE memory_id = ?', id);
    const { changes } = dbRun('DELETE FROM memories WHERE id = ? AND user_id = ?', id, DEFAULT_USER_ID);
    invalidateMemoryVectorCache(id);
    return changes > 0;
  });
}

/** 清空该用户全部记忆及其向量（设置页"重置记忆"用；先删向量再删记忆，同一事务保证原子性） */
export function wipeAllMemories(): void {
  tx(() => {
    dbRun('DELETE FROM memory_embeddings WHERE memory_id IN (SELECT id FROM memories WHERE user_id = ?)', DEFAULT_USER_ID);
    dbRun('DELETE FROM memories WHERE user_id = ?', DEFAULT_USER_ID);
  });
  clearMemoryVectorCache();
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

/* ---------------------- 每日摘要 ---------------------- */
export function saveDailySummary(date: string, summary: string, meta?: unknown): void {
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
  return dbAll<DailySummaryRow>(
    'SELECT * FROM daily_summaries WHERE user_id = ? ORDER BY date DESC LIMIT ?',
    DEFAULT_USER_ID,
    limit
  );
}

/**
 * 最近几天的回顾（每日摘要）→ 注入 Prompt，让她真的"记得"这些日子。
 * 明确标注为"历史记录（当时的状态，不代表现在）"，避免把旧数值当成当前状态；
 * 摘要文本属于数据 → 包在 <DATA> 里。
 */
export function dailySummaryBlock(days = 2): string {
  const rows = dbAll<{ date: string; summary: string; created_at: string }>(
    'SELECT date, summary, created_at FROM daily_summaries WHERE user_id = ? ORDER BY date DESC LIMIT ?',
    DEFAULT_USER_ID,
    days
  );
  if (!rows.length) return '';
  const lines = rows.map((r) => `- ${String(r.date)}（当时）：${truncate(String(r.summary || ''), 220)}`);
  return [
    '【这天的历史记录｜以下是过去某天的状态快照，只代表"当时"，不代表现在的状态，也不要当成此刻正在发生的事】',
    '<DATA>',
    ...lines,
    '</DATA>',
  ].join('\n');
}

export function recentMessagesForSummary(date: string) {
  return dbAll<MessageRow & { agent_name: string | null }>(
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