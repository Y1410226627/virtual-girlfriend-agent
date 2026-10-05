// 消息列表 / 清空聊天
import { listMessages, messageCount } from '@/lib/engine';
import { dbAll, DEFAULT_USER_ID } from '@/lib/db';
import type { MessageRow } from '@/lib/types';
import { deleteMessageById, wipeAllMessages } from '@/lib/messageActions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const afterId = Number(url.searchParams.get('afterId') || 0);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
  // P1-51 历史分页：beforeId → 返回该 id 之前最近的 limit 条（升序），用于"加载更早的消息"。
  // 缺省行为不变（最近 limit 条 / afterId 增量拉取）。
  const beforeId = Number(url.searchParams.get('beforeId') || 0);
  if (beforeId > 0) {
    const rows = dbAll<MessageRow>(
      'SELECT * FROM messages WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
      DEFAULT_USER_ID,
      beforeId,
      limit
    ).reverse();
    return Response.json({ messages: rows, total: messageCount(), hasMore: rows.length === limit });
  }
  const rows = listMessages({ afterId: afterId || undefined, limit });
  return Response.json({ messages: rows, total: messageCount() });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const idParam = url.searchParams.get('id');
  const cascade = url.searchParams.get('cascade') === '1';

  // 带 id：删除单条消息。id 非法（含负数临时 id）直接 400，绝不退化成"清空全部"
  if (idParam !== null) {
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) {
      return Response.json({ error: '消息 id 无效' }, { status: 400 });
    }
    const report = deleteMessageById(id, cascade);
    return Response.json(report, { status: report.ok ? 200 : 400 });
  }

  // 清空全部聊天记录：必须显式 all=1，避免误传参数（如负 id）清库
  if (url.searchParams.get('all') === '1') {
    wipeAllMessages();
    return Response.json({ ok: true });
  }

  return Response.json({ error: '缺少 id，或需显式 all=1 才能清空全部聊天记录' }, { status: 400 });
}