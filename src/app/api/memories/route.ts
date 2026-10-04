// 记忆管理：查看 / 编辑 / 删除 / 新增 / 整理
import {
  listMemories,
  updateMemory,
  deleteMemory,
  createMemoryManually,
  memoryStats,
  backfillEmbeddings,
  refreshMemoryEmbedding,
  forgetSweep,
  listDailySummaries,
} from '@/lib/memory';
import { dbRun, DEFAULT_USER_ID } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const type = url.searchParams.get('type') || undefined;
  const status = url.searchParams.get('status') || 'active';
  const memories = listMemories({ type, status, limit: 400 });
  return Response.json({ memories, stats: memoryStats(), summaries: listDailySummaries(30) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = body?.action || 'create';
  if (action === 'create') {
    const content = String(body.content || '').trim();
    if (!content) return Response.json({ error: '内容不能为空' }, { status: 400 });
    const id = createMemoryManually(body.type || 'semantic', content, Number(body.importance) || 6, body.emotion);
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
    dbRun('DELETE FROM memory_embeddings WHERE memory_id IN (SELECT id FROM memories WHERE user_id = ?)', DEFAULT_USER_ID);
    dbRun('DELETE FROM memories WHERE user_id = ?', DEFAULT_USER_ID);
    return Response.json({ ok: true });
  }
  if (!id) return Response.json({ error: '缺少 id' }, { status: 400 });
  return Response.json({ ok: deleteMemory(id) });
}