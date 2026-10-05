'use client';

import { Card, Chip } from '@/components/ui';
import type { SaveFn, SetFieldFn } from './shared';

export function VoiceCard({
  form,
  set,
  save,
  saving,
  testTts,
  ttsTesting,
}: {
  form: Record<string, string>;
  set: SetFieldFn;
  save: SaveFn;
  saving: boolean;
  testTts: () => void;
  ttsTesting: boolean;
}) {
  return (
    <Card
      title="语音（让她说给你听）"
      right={<Chip tone="plain">{form.tts_enabled === 'true' ? '已开启' : '未开启'}</Chip>}
    >
      <p className="dim leading-relaxed">
        开启后，她的每条回复旁边会出现 🔊 按钮，点一下就用你配置的语音服务把这句话读出来。
        需要一个兼容 OpenAI <code className="rounded accent-soft px-1">/audio/speech</code> 接口的服务（地址填到 <code className="rounded accent-soft px-1">/v1</code> 这一层即可）。
        没配置时聊天页不会出现该按钮，也不会报错。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className={form.tts_enabled === 'true' ? 'btn' : 'btn-ghost'}
          aria-pressed={form.tts_enabled === 'true'}
          onClick={() => set('tts_enabled', form.tts_enabled === 'true' ? 'false' : 'true')}
        >
          {form.tts_enabled === 'true' ? '已开启（点击关闭）' : '开启语音'}
        </button>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <label className="label">语音接口地址 Base URL</label>
          <input
            className="input"
            value={form.tts_base_url ?? ''}
            onChange={(e) => set('tts_base_url', e.target.value)}
            placeholder="留空则关闭；如 https://api.openai.com/v1"
          />
        </div>
        <div>
          <label className="label">API Key</label>
          <input
            className="input"
            type="password"
            value={form.tts_api_key ?? ''}
            onChange={(e) => set('tts_api_key', e.target.value)}
            placeholder="留空则不使用"
          />
        </div>
        <div>
          <label className="label">模型</label>
          <input className="input" value={form.tts_model ?? ''} onChange={(e) => set('tts_model', e.target.value)} placeholder="默认 tts-1" />
        </div>
        <div>
          <label className="label">音色 voice</label>
          <input className="input" value={form.tts_voice ?? ''} onChange={(e) => set('tts_voice', e.target.value)} placeholder="默认 alloy" />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className="btn"
          onClick={() => save(['tts_enabled', 'tts_base_url', 'tts_api_key', 'tts_model', 'tts_voice'], '语音设置已保存')}
          disabled={saving}
        >
          保存
        </button>
        <button className="btn-ghost" onClick={testTts} disabled={ttsTesting || saving}>
          {ttsTesting ? '试听中…' : '试听一句'}
        </button>
        <span className="dim">试听用的是已保存的配置，改完记得先点保存。</span>
      </div>
    </Card>
  );
}