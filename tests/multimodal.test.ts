// 多模态（发图给她看）+ 语音输入（ASR）回归：
//  - 消息组装：带图 → 多模态 content parts；不带图 → 字符串（向后兼容）
//  - 视觉不可用时的纯文字降级（hasImageParts / stripImagesToText）
//  - /api/chat 拒绝超限 / 非法图片（直接调用路由处理函数，构造 Request）
//  - uploads 路径穿越防护（..\、绝对路径、URL 编码变体一律拒绝）
//  - /api/asr 未配置时给出明确错误、GET 返回 enabled=false
// 隐私：使用独立临时库 + 临时上传目录，绝不触碰 data/；全程不发任何真实网络请求。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-test-mm-'));
const DB = path.join(TMP, 'girlfriend.db');
process.env.DB_PATH = DB; // 必须在动态 import 被测模块之前设置
process.env.UPLOADS_DIR = path.join(TMP, 'uploads');

const dbMod = await import('../src/lib/db.ts');
const uploadsMod = await import('../src/lib/uploads.ts');
const engineMod = await import('../src/lib/engine.ts');
const llmMod = await import('../src/lib/llm.ts');
const chatRoute = await import('../src/app/api/chat/route.ts');
const asrRoute = await import('../src/app/api/asr/route.ts');
const uploadRoute = await import('../src/app/api/uploads/[name]/route.ts');

dbMod.getDb(); // 触发建库

after(() => {
  try {
    dbMod.getDb().close();
  } catch {
    /* 已关闭 */
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const PNG_DATA_URL = 'data:image/png;base64,' + Buffer.from('hello-image').toString('base64');

function chatReq(body: unknown): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ */
/* 消息组装                                                            */
/* ------------------------------------------------------------------ */
test('消息组装：带图 → 最后一条用户消息为 content parts（text + image_url）', () => {
  const messages = [
    { role: 'system' as const, content: '你是她' },
    { role: 'user' as const, content: '看这个' },
  ];
  const out = engineMod.withImagesOnLastUserMessage(messages, '看这个', [PNG_DATA_URL]);
  const last = out[out.length - 1]!;
  assert.ok(Array.isArray(last.content), '带图应为 content parts 数组');
  const parts = last.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
  assert.equal(parts[0]!.type, 'text');
  assert.equal(parts[0]!.text, '看这个');
  assert.equal(parts[1]!.type, 'image_url');
  assert.equal(parts[1]!.image_url!.url, PNG_DATA_URL);
  assert.equal(parts.length, 2);
});

test('消息组装：不带图 → content 仍是字符串（向后兼容）', () => {
  const messages = [{ role: 'user' as const, content: '哈喽' }];
  const out = engineMod.withImagesOnLastUserMessage(messages, '哈喽', []);
  assert.equal(typeof out[0]!.content, 'string');
  assert.equal(out[0]!.content, '哈喽');
});

test('视觉降级：hasImageParts 为真 → stripImagesToText 退回纯文字并保留语义', () => {
  const messages = [
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: '看这张' },
        { type: 'image_url' as const, image_url: { url: PNG_DATA_URL } },
      ],
    },
  ];
  assert.equal(llmMod.hasImageParts(messages), true);
  const stripped = llmMod.stripImagesToText(messages);
  assert.equal(llmMod.hasImageParts(stripped), false);
  assert.equal(typeof stripped[0]!.content, 'string');
  assert.match(String(stripped[0]!.content), /看这张/);
  assert.match(String(stripped[0]!.content), /图片/);
});

/* ------------------------------------------------------------------ */
/* /api/chat 图片校验（拒绝路径都在 buildChatStream 之前返回，不触发 LLM） */
/* ------------------------------------------------------------------ */
test('chat 拒绝：images 不是数组', async () => {
  const res = await chatRoute.POST(chatReq({ content: 'hi', images: 'nope' }));
  assert.equal(res.status, 400);
});

test('chat 拒绝：超过 2 张', async () => {
  const res = await chatRoute.POST(chatReq({ content: 'hi', images: [PNG_DATA_URL, PNG_DATA_URL, PNG_DATA_URL] }));
  assert.equal(res.status, 400);
});

test('chat 拒绝：非图片前缀 / 非白名单格式', async () => {
  const a = await chatRoute.POST(chatReq({ content: 'hi', images: ['data:text/plain;base64,AAAA'] }));
  assert.equal(a.status, 400);
  const b = await chatRoute.POST(chatReq({ content: 'hi', images: ['not-a-data-url'] }));
  assert.equal(b.status, 400);
  // svg 刻意不在白名单（可内联脚本）
  const c = await chatRoute.POST(chatReq({ content: 'hi', images: ['data:image/svg+xml;base64,AAAA'] }));
  assert.equal(c.status, 400);
});

test('chat 拒绝：单张超过 3MB', async () => {
  const big = 'data:image/png;base64,' + Buffer.alloc(3 * 1024 * 1024 + 8).toString('base64');
  const res = await chatRoute.POST(chatReq({ content: 'hi', images: [big] }));
  assert.equal(res.status, 400);
});

test('chat 拒绝：整包超过 6MB（413）', async () => {
  // 真实浏览器请求会带 Content-Length；这里显式构造该头部来验证整包上限拦截
  const res = await chatRoute.POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'content-length': String(7 * 1024 * 1024) },
      body: '{"content":"hi"}',
    })
  );
  assert.equal(res.status, 413);
});

/* ------------------------------------------------------------------ */
/* uploads：落盘 / 读回 / 路径穿越防护                                  */
/* ------------------------------------------------------------------ */
test('uploads：落盘后用文件名读回（dataURL 往返一致）', async () => {
  const rel = uploadsMod.saveUpload(PNG_DATA_URL);
  assert.match(rel, /^uploads\/[A-Za-z0-9._-]+\.png$/);
  assert.equal(uploadsMod.imageDataUrlFor(rel), PNG_DATA_URL);

  const name = rel.split('/').pop() as string;
  const res = await uploadRoute.GET(new Request(`http://localhost/api/uploads/${name}`), {
    params: Promise.resolve({ name }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(String(res.headers.get('cache-control')), /max-age=31536000/);
});

test('uploads：路径穿越 / 非法文件名一律拒绝', () => {
  const bad = [
    '..\\secret.jpg',
    '../secret.jpg',
    '../../etc/passwd',
    '..%2fsecret.jpg',
    '%2e%2e%2fsecret.jpg',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'a/b.jpg',
    'a\\b.jpg',
    '..',
    '.',
    '',
    'name with space.jpg',
  ];
  for (const n of bad) {
    assert.equal(uploadsMod.resolveUploadPath(n), null, `应拒绝：${n}`);
  }
  // 合法名（生成的形状）可以通过
  assert.ok(uploadsMod.resolveUploadPath('1700000000000-ab12cd34ef56.jpg'));
});

test('uploads 路由：穿越名一律 404，且不读出目录外文件', async () => {
  for (const name of ['../secret.jpg', '..%2fsecret.jpg', '%2e%2e%2fsecret.jpg', 'C:\\Windows\\win.ini']) {
    const res = await uploadRoute.GET(new Request('http://localhost/api/uploads/x'), {
      params: Promise.resolve({ name }),
    });
    assert.equal(res.status, 404, `应 404：${name}`);
  }
});

/* ------------------------------------------------------------------ */
/* ASR 未配置                                                          */
/* ------------------------------------------------------------------ */
test('ASR 未配置：GET enabled=false；POST 返回明确错误', async () => {
  const g = await asrRoute.GET();
  const gj = (await g.json()) as { enabled?: boolean };
  assert.equal(gj.enabled, false);

  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'voice.webm');
  const res = await asrRoute.POST(new Request('http://localhost/api/asr', { method: 'POST', body: fd }));
  assert.equal(res.status, 400);
  const j = (await res.json()) as { error?: string };
  assert.match(String(j.error), /未配置/);
});