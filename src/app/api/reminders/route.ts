// 提醒：查看 / 取消（创建由聊天消息自动识别，见 src/lib/reminders.ts）
import { cancelReminder, listReminders } from '@/lib/reminders';
import { withRequestCompanion } from '@/lib/companion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return withRequestCompanion(req, () => Response.json({ ok: true, reminders: listReminders() }));
}

export async function DELETE(req: Request) {
  return withRequestCompanion(req, () => {
    const url = new URL(req.url);
    const id = Number(url.searchParams.get('id') || 0);
    if (!id) return Response.json({ ok: false, error: '缺少 id' }, { status: 400 });
    if (!cancelReminder(id)) {
      return Response.json({ ok: false, error: '提醒不存在或已发送' }, { status: 404 });
    }
    return Response.json({ ok: true });
  });
}
