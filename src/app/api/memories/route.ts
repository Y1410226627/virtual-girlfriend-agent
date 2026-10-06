// 记忆管理：查看 / 编辑 / 删除 / 新增 / 整理
import {
  updateMemory,
  deleteMemory,
  createMemoryManually,
  memoryStats,
  backfillEmbeddings,
  refreshMemoryEmbedding,
  forgetSweep,
  listDailySummaries,
  wipeAllMemories,
} from '@/lib/memory';
import { cAll } from '@/lib/db';
import { clamp, truncate } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** memories 表只读列（星图聚合用） */
interface TopAccessedRow {
  id: number;
  content: string | null;
  importance: number | null;
  access_count: number | null;
  type: string | null;
}
interface ScatterRow {
  id: number;
  importance: number | null;
  access_count: number | null;
  content: string | null;
}

/**
 * 记忆星图：在原有 memoryStats() 基础上，追加"最常想起 / 重要度分布 / 散点 / 状态计数"。
 * 全部在服务端聚合，前端只拿结果，不拉全量再算。
 * 复用 memoryStats() 的 total / archived / byType，保持既有字段不变。
 */
function starStats() {
  const base = memoryStats();

  // 状态计数：active / archived / superseded（active、archived 复用 memoryStats 的结果）
  const superseded = Number(
    cAll<{ c: number }>(
      "SELECT COUNT(*) AS c FROM memories WHERE companion_id = ? AND status = 'superseded'"
    )[0]?.c || 0
  );
  const counts = {
    active: Number(base.total || 0),
    archived: Number(base.archived || 0),
    superseded,
  };

  // 最常想起：active 记忆按 access_count 倒序取前 10
  const topAccessed = cAll<TopAccessedRow>(
    `SELECT id, content, importance, access_count, type FROM memories
     WHERE companion_id = ? AND status = 'active'
     ORDER BY access_count DESC, importance DESC, id DESC LIMIT 10`
  ).map((m) => ({
    id: m.id,
    content: truncate(String(m.content || ''), 60),
    importance: Number(m.importance || 0),
    access_count: Number(m.access_count || 0),
    type: m.type,
  }));

  // 重要度分布：0-2 / 3-5 / 6-8 / 9-10 四档的 active 计数
  const bucketRows = cAll<{ b: number; c: number }>(
    `SELECT CASE
        WHEN importance <= 2 THEN 0
        WHEN importance <= 5 THEN 1
        WHEN importance <= 8 THEN 2
        ELSE 3 END AS b,
       COUNT(*) AS c
     FROM memories WHERE companion_id = ? AND status = 'active'
     GROUP BY b`
  );
  const importanceBuckets = ['0-2', '3-5', '6-8', '9-10'].map((label, i) => ({
    label,
    count: Number(bucketRows.find((r) => Number(r.b) === i)?.c || 0),
  }));

  // 散点：active 记忆按重要度倒序取最多 200 条
  const scatter = cAll<ScatterRow>(
    `SELECT id, importance, access_count, content FROM memories
     WHERE companion_id = ? AND status = 'active'
     ORDER BY importance DESC, access_count DESC, id DESC LIMIT 200`
  ).map((m) => ({
    id: m.id,
    importance: Number(m.importance || 0),
    access_count: Number(m.access_count || 0),
    content: truncate(String(m.content || ''), 40),
  }));

  return { ...base, counts, topAccessed, importanceBuckets, scatter };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const type = url.searchParams.get('type') || undefined;
  const status = url.searchParams.get('status') || 'active';
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 100));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const memories = type
    ? cAll(
        'SELECT * FROM memories WHERE companion_id = ? AND status = ? AND type = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        status, type, limit, offset
      )
    : cAll(
        'SELECT * FROM memories WHERE companion_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        status, limit, offset
      );
  return Response.json({ memories, stats: starStats(), summaries: listDailySummaries(30) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = body?.action || 'create';
  if (action === 'create') {
    const content = String(body.content || '').trim();
    if (!content) return Response.json({ error: '内容不能为空' }, { status: 400 });
    const imp = body.importance !== undefined ? Number(body.importance) : 6;
    const importance = isFinite(imp) ? clamp(imp, 0, 10) : 6;
    const id = createMemoryManually(body.type || 'semantic', content, importance, body.emotion);
    await backfillEmbeddings();
    return Response.json({ ok: true, id });
  }
  if (action === 'backfill') {
    const n = await backfillEmbeddings();
    return Response.json({ ok: true, count: n });
  }
  if (action === 'forget') {
    const n = forgetSweep();
    return Response.json({ ok: true, archived: n });
  }
  return Response.json({ error: '未知操作' }, { status: 400 });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = Number(body?.id);
  if (!id) return Response.json({ error: '缺少 id' }, { status: 400 });
  const ok = updateMemory(id, {
    content: body.content,
    importance: body.importance !== undefined ? Number(body.importance) : undefined,
    emotion: body.emotion,
    status: body.status,
  });
  // 内容被编辑 → 重算这一条的向量（否则语义检索会按旧内容走）
  if (ok && body.content !== undefined) await refreshMemoryEmbedding(id);
  return Response.json({ ok });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = Number(url.searchParams.get('id') || 0);
  const all = url.searchParams.get('all');
  if (all === '1') {
    wipeAllMemories();
    return Response.json({ ok: true });
  }
  if (!id) return Response.json({ error: '缺少 id' }, { status: 400 });
  // 删 0 行不能包装成成功：否则前端会谎报"已删除"
  if (!deleteMemory(id)) return Response.json({ ok: false, error: '记忆不存在或已删除' }, { status: 404 });
  return Response.json({ ok: true });
}