// 本地知识库：资料列表 / 导入 / 删除（内容只存本机，按请求所指伴侣隔离）
import { addKbDoc, deleteKbDoc, listKbDocs, KB_MAX_DOCS, KB_MAX_DOC_CHARS } from '@/lib/knowledge';
import { withRequestCompanion } from '@/lib/companion';
import { errMsg } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return withRequestCompanion(req, () =>
    Response.json({
      ok: true,
      docs: listKbDocs(),
      limits: { docs: KB_MAX_DOCS, chars: KB_MAX_DOC_CHARS },
    })
  );
}

export async function POST(req: Request) {
  return withRequestCompanion(req, async () => {
    const body = await req.json().catch(() => ({}));
    const title = String(body?.title || '');
    const source = String(body?.source || '');
    const text = String(body?.text || '');
    try {
      const r = await addKbDoc(title, source, text);
      return Response.json({ ok: true, ...r });
    } catch (e) {
      return Response.json({ ok: false, error: errMsg(e) }, { status: 400 });
    }
  });
}

export async function DELETE(req: Request) {
  return withRequestCompanion(req, () => {
    const url = new URL(req.url);
    const id = Number(url.searchParams.get('id') || 0);
    if (!id) return Response.json({ ok: false, error: '缺少 id' }, { status: 400 });
    if (!deleteKbDoc(id)) return Response.json({ ok: false, error: '资料不存在或已删除' }, { status: 404 });
    return Response.json({ ok: true });
  });
}
