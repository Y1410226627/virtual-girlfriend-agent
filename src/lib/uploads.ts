// 上传图片（他发给她看的照片）：dataURL → 落盘 → 读取。
// 纯本地：图片只写进本机 data/uploads（可用 UPLOADS_DIR 覆盖，便于测试隔离），
// 绝不外传；路径穿越在这里统一拦住。
//
// 本文件只依赖 node 内置模块，不 import 任何 lib 其它模块（避免与桶文件成环）。
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** 单轮最多附几张图 */
export const MAX_IMAGES = 2;
/** 单张图片解码后的字节上限（3MB） */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** 整包（含 base64 膨胀）请求体上限（6MB） */
export const MAX_BODY_BYTES = 6 * 1024 * 1024;

/** 允许的图片类型 → 扩展名。刻意不收 svg（可内联脚本，有 XSS 风险） */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** 上传目录：与 DB_PATH 同款风格，可用环境变量 UPLOADS_DIR 覆盖（测试用临时目录） */
export function resolveUploadsDir(): string {
  const p = process.env.UPLOADS_DIR || path.join('data', 'uploads');
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

/** 解析 data:image/...;base64,... —— 非白名单格式返回 null */
export function parseImageDataUrl(dataUrl: string): { mime: string; ext: string; buffer: Buffer } | null {
  const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(String(dataUrl || '').trim());
  if (!m) return null;
  const mime = m[1]!.toLowerCase();
  const ext = EXT_BY_MIME[mime];
  if (!ext) return null;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(m[2]!, 'base64');
  } catch {
    return null;
  }
  if (!buffer.length) return null;
  return { mime, ext, buffer };
}

/** 校验一张图片 dataURL：类型 / 尺寸。返回 bytes 便于调用方做总量控制 */
export function validateImageDataUrl(dataUrl: unknown): { ok: true; bytes: number } | { ok: false; error: string } {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return { ok: false, error: '只接受图片（需以 data:image/ 开头）' };
  }
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) return { ok: false, error: '不支持的图片格式（仅支持 JPEG / PNG / WebP / GIF）' };
  if (parsed.buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: `单张图片不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB` };
  }
  return { ok: true, bytes: parsed.buffer.length };
}

/** 把一张图片 dataURL 写进上传目录，返回相对路径（如 uploads/1700000000-ab12cd.jpg） */
export function saveUpload(dataUrl: string, dir: string = resolveUploadsDir()): string {
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) throw new Error('无效的图片数据');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${randomBytes(6).toString('hex')}.${parsed.ext}`;
  fs.writeFileSync(path.join(dir, name), parsed.buffer);
  return `uploads/${name}`;
}

/** 文件名严格白名单：只允许 [A-Za-z0-9._-]+（不含路径分隔符） */
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * 把外部传入的文件名解析成上传目录内的绝对路径；任何越界/非法名返回 null。
 * 双重防护：白名单正则 + resolve 后必须仍落在目录内（拦住 ".."、绝对路径、编码变体）。
 */
export function resolveUploadPath(name: string, dir: string = resolveUploadsDir()): string | null {
  const n = String(name || '');
  if (!SAFE_NAME_RE.test(n) || n === '.' || n === '..') return null;
  const base = path.resolve(dir);
  const full = path.resolve(base, n);
  if (!full.startsWith(base + path.sep)) return null;
  return full;
}

/** 由扩展名推断 Content-Type（供只读路由使用）；未知返回 null */
export function contentTypeForUpload(name: string): string | null {
  const ext = String(name || '').split('.').pop()?.toLowerCase() || '';
  return MIME_BY_EXT[ext] ?? null;
}

/** 读取一张已落盘图片 → dataURL（文件缺失 / 非法名返回 null） */
export function imageDataUrlFor(storedPath: string, dir: string = resolveUploadsDir()): string | null {
  const name = String(storedPath || '').split('/').pop() || '';
  const full = resolveUploadPath(name, dir);
  if (!full) return null;
  const mime = contentTypeForUpload(name);
  if (!mime) return null;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(full);
  } catch {
    return null;
  }
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** 批量读取 → dataURL 列表（跳过错失的文件），供组装多模态消息使用 */
export function loadImageDataUrls(storedPaths: string[], dir: string = resolveUploadsDir()): string[] {
  const out: string[] = [];
  for (const p of storedPaths || []) {
    const d = imageDataUrlFor(p, dir);
    if (d) out.push(d);
  }
  return out;
}

/** 从消息 meta 里解析出图片相对路径列表（容错：非法 JSON / 非数组 → 空） */
export function parseMetaImages(meta: string | null | undefined): string[] {
  if (!meta) return [];
  try {
    const obj = JSON.parse(String(meta)) as { images?: unknown };
    const arr = obj?.images;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, MAX_IMAGES);
  } catch {
    return [];
  }
}