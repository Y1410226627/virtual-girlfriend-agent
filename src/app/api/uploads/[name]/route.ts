// 只读图片：返回 data/uploads 下的图片（他发给她的照片）。
// 严格防路径穿越：文件名只允许 [A-Za-z0-9._-]+，且 resolve 后必须仍在上传目录内。
import fs from 'node:fs';
import { resolveUploadPath, contentTypeForUpload } from '@/lib/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const full = resolveUploadPath(name);
  const mime = contentTypeForUpload(name);
  if (!full || !mime) return new Response('Not Found', { status: 404 });
  let buf: Buffer;
  try {
    buf = fs.readFileSync(full);
  } catch {
    return new Response('Not Found', { status: 404 });
  }
  // 文件名 = 时间戳+随机，内容不会变 → 可长缓存
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}