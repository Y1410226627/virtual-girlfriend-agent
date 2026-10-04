// 消息列表 / 清空聊天
import { listMessages, messageCount } from '@/lib/engine';
import { dbRun, DEFAULT_USER_ID } from '@/lib/db';
import { deleteMessageById } from '@/lib/messageActions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const afterId = Number(url.searchParams.get('afterId') || 0);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
  const rows = listMessages({ afterId: afterId || undefined, limit });
  return Response.json({ messages: rows, total: messageCount() });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = Number(url.searchParams.get('id') || 0);
  const cascade = url.searchParams.get('cascade') === '1';

  // 删除单条消息（可选撤销它产生的影响）
  if (id > 0) {
    const report = deleteMessageById(id, cascade);
    return Response.json(report, { status: report.ok ? 200 : 400 });
  }

  // 没有 id：清空全部聊天记录
  dbRun('DELETE FROM messages WHERE user_id = ?', DEFAULT_USER_ID);
  return Response.json({ ok: true });
}