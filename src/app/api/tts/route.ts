// 语音条（TTS）：把她的回复交给兼容 OpenAI /audio/speech 的服务朗读成 mp3
// 未配置时返回 400，前端据此降级（不渲染播放按钮），绝不报错白屏
import { getSetting, boolSetting } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 表情包 token：朗读时要剔除（否则会把 [[sticker:xx]] 念出来）
const STICKER_TOKEN_RE = /\[\[\s*(?:sticker|表情包)\s*[:：]?\s*[a-z_]+\s*\]\]/gi;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  // 清洗：去掉表情包标记 → 掐头去尾空白 → 最多 300 字
  let text = String(body?.text || '').replace(STICKER_TOKEN_RE, ' ').replace(/\s+/g, ' ').trim();
  text = text.slice(0, 300);
  if (!text) return Response.json({ error: '没有可朗读的内容' }, { status: 400 });

  const enabled = boolSetting('tts_enabled', false);
  const baseUrl = String(getSetting('tts_base_url') || '').replace(/\/+$/, '');
  const apiKey = String(getSetting('tts_api_key') || '');
  const model = String(getSetting('tts_model') || '') || 'tts-1';
  const voice = String(getSetting('tts_voice') || '') || 'alloy';
  // 未启用 / 缺地址 / 缺 Key → 直接告诉前端"未配置"（前端不会显示按钮，这里是兜底）
  if (!enabled || !baseUrl || !apiKey || !/^https?:\/\//.test(baseUrl)) {
    return Response.json({ error: '未配置语音服务' }, { status: 400 });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: text, voice, response_format: 'mp3' }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      return Response.json(
        { error: `语音服务返回 ${res.status}${detail ? '：' + detail.slice(0, 120) : ''}` },
        { status: 502 }
      );
    }
    // 流式把音频透传给前端
    return new Response(res.body, {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    const eo = e as { name?: string; message?: string };
    const msg = eo?.name === 'AbortError' ? '语音服务超时（30 秒）' : eo?.message || '语音合成失败';
    return Response.json({ error: msg }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}