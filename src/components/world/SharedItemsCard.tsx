'use client';

import { useState } from 'react';
import { Card, fmtTime } from '@/components/ui';
import type { PostFn, SharedEntry } from './shared';

export function SharedItemsCard({
  items,
  busy,
  post,
  newItem,
  setNewItem,
}: {
  items?: SharedEntry[];
  busy: boolean;
  post: PostFn;
  newItem: string;
  setNewItem: React.Dispatch<React.SetStateAction<string>>;
}) {
  // 本地 busy 防抖：父级 busy 是异步置真，同一帧内连点会重复提交
  const [pending, setPending] = useState(false);
  return (
    <Card title="共同物品与回忆" className="md:col-span-2">
      {items?.length ? (
        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={`${item.created_at ?? ''}|${item.content || item.title}`}
              className="flex items-center justify-between gap-3 border-b line py-2 last:border-0"
            >
              <span className="text-xs ink-1">{item.content || item.title}</span>
              <span className="shrink-0 text-[11px] ink-3">{fmtTime(item.created_at)}</span>
            </div>
          ))}
        </div>
      ) : <p className="dim">一起珍藏的歌、电影或小物件会留在这里。</p>}
      <div className="mt-3 flex gap-2">
        <input className="input" placeholder="例如：我们的歌" value={newItem} onChange={(e) => setNewItem(e.target.value)} />
        <button
          className="btn"
          disabled={busy || pending || !newItem.trim()}
          onClick={async () => {
            if (pending) return;
            setPending(true);
            try {
              // 提交 trim 后的内容（与服务端一致）；仅在成功时清空输入
              const r = await post({ action: 'add_item', content: newItem.trim() }, '已加入共享世界');
              if (r) setNewItem('');
            } finally {
              setPending(false);
            }
          }}
        >
          添加
        </button>
      </div>
    </Card>
  );
}