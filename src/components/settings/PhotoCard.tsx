'use client';

import Link from 'next/link';
import { Card, Chip } from '@/components/ui';
import { withCompanionQuery } from '@/components/chat/companion-query';
import type { SaveFn, SetFieldFn } from './shared';

export function PhotoCard({
  form,
  set,
  save,
  saving,
  companionId,
}: {
  form: Record<string, string>;
  set: SetFieldFn;
  save: SaveFn;
  saving: boolean;
  /** 当前伴侣：让"去聊天页"入口保留当前伴侣上下文 */
  companionId: number;
}) {
  return (
    <Card
      title="她的照片（点头像看看她）"
      right={<Chip tone="plain">{form.img_enabled === 'true' ? '已开启' : '未开启'}</Chip>}
    >
      <p className="dim leading-relaxed">
        开启并配置后，在聊天页点她的头像，会用图片生成服务生成一张她此刻的日常自拍，并按她的活动、地点配一句自然的说明。
        需要一个兼容 OpenAI <code className="rounded accent-soft px-1">/images/generations</code> 接口的服务。
        没配置时用内置立绘兜底，不会报错。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className={form.img_enabled === 'true' ? 'btn' : 'btn-ghost'}
          aria-pressed={form.img_enabled === 'true'}
          onClick={() => set('img_enabled', form.img_enabled === 'true' ? 'false' : 'true')}
        >
          {form.img_enabled === 'true' ? '已开启（点击关闭）' : '开启照片'}
        </button>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <label className="label" htmlFor="photo_img_base_url">图片接口地址 Base URL</label>
          <input
            id="photo_img_base_url"
            className="input"
            value={form.img_base_url ?? ''}
            onChange={(e) => set('img_base_url', e.target.value)}
            placeholder="留空则关闭；如 https://api.openai.com/v1"
          />
        </div>
        <div>
          <label className="label" htmlFor="photo_img_api_key">API Key</label>
          <input
            id="photo_img_api_key"
            className="input"
            type="password"
            value={form.img_api_key ?? ''}
            onChange={(e) => set('img_api_key', e.target.value)}
            placeholder="留空则不使用"
          />
        </div>
        <div>
          <label className="label" htmlFor="photo_img_model">模型</label>
          <input id="photo_img_model" className="input" value={form.img_model ?? ''} onChange={(e) => set('img_model', e.target.value)} placeholder="默认 gpt-image-1" />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className="btn"
          onClick={() => save(['img_enabled', 'img_base_url', 'img_api_key', 'img_model'], '照片设置已保存')}
          disabled={saving}
        >
          保存
        </button>
        <Link href={withCompanionQuery('/', companionId)} className="btn-ghost">
          去聊天页点头像看看 →
        </Link>
      </div>
    </Card>
  );
}