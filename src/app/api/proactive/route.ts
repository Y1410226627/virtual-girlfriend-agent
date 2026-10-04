// 主动消息：状态查看 / 手动触发一次检查
import { tickProactive, proactiveStatus, listProactive } from '@/lib/proactive';
import { listMessages } from '@/lib/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ status: proactiveStatus(), recent: listProactive(20) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const force = !!body?.force; // 手动触发时忽略时间/频率限制（方便体验）
  const result = await tickProactive(force);
  return Response.json({
    ...result,
    status: proactiveStatus(),
    messages: result.sent ? listMessages({ limit: 5 }) : undefined,
  });
}