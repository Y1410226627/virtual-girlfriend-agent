// 语音输入（ASR）：把浏览器录的一段音频转成文字。
// 音频只发往"用户自己配置的"兼容 OpenAI /audio/transcriptions 的端点（与本应用其它 LLM 调用一致），
// 不接任何第三方；未配置时 POST 返回 400、GET 返回 enabled=false（前端据此不显示麦克风按钮）。
import { getSetting, boolSetting } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 读出当前 ASR 配置（Key 不落日志、不回传） */
function asrConfig() {
  const enabled = boolSetting('asr_enabled', false);
  const baseUrl = String(getSetting('asr_base_url') || '').replace(/\/+$/, '');
  const apiKey = String(getSetting('asr_api_key') || '');
  const model = String(getSetting('asr_model') || '') || 'whisper-1';
  const configured = enabled && !!baseUrl && !!apiKey && /^https?:\/\//.test(baseUrl);
  return { enabled, configured, baseUrl, apiKey, model };
}

/** 前端用来判断是否显示麦克风按钮；绝不暴露 Key */
export async function GET() {
  const cfg = asrConfig();
  return Response.json({ enabled: cfg.configured, model: cfg.model });
}

export async function POST(req: Request) {
  const cfg = asrConfig();
  if (!cfg.configured) return Response.json({ error: '未配置语音识别服务' }, { status: 400 });

  // 收前端上传的音频（multipart/form-data，字段名 file）
  let file: Blob;
  try {
    const form = await req.formData();
    const f = form.get('file');
    if (!(f instanceof Blob) || f.size === 0) {
      return Response.json({ error: '没有收到音频' }, { status: 400 });
    }
    file = f;
  } catch {
    return Response.json({ error: '音频读取失败' }, { status: 400 });
  }

  const out = new FormData();
  out.append('file', file, 'voice.webm');
  out.append('model', cfg.model);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: out,
      signal: ctrl.signal,
    });
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      return Response.json(
        { error: `语音识别服务返回 ${res.status}${raw ? '：' + raw.slice(0, 160) : ''}` },
        { status: 502 }
      );
    }
    let text = '';
    try {
      text = String((JSON.parse(raw) as { text?: unknown })?.text || '');
    } catch {
      text = '';
    }
    if (!text.trim()) return Response.json({ error: '没有听清，再说一次试试' }, { status: 422 });
    return Response.json({ text: text.trim() });
  } catch (e) {
    const eo = e as { name?: string; message?: string };
    const msg = eo?.name === 'AbortError' ? '语音识别超时（60 秒）' : eo?.message || '语音识别失败';
    return Response.json({ error: msg }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}