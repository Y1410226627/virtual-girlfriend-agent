'use client';

import { useState } from 'react';
import { Card, fmtTime } from '@/components/ui';
import type { PostFn, SharedEntry } from './shared';

export function SharedRitualsCard({
  rituals,
  busy,
  post,
  newRitual,
  setNewRitual,
}: {
  rituals?: SharedEntry[];
  busy: boolean;
  post: PostFn;
  newRitual: string;
  setNewRitual: React.Dispatch<React.SetStateAction<string>>;
}) {
  // 本地 busy 防抖：父级 busy 是异步置真，同一帧内连点会重复提交
  const [pending, setPending] = useState(false);
  return (
    <Card title="共同仪式">
      {rituals?.length ? (
        <div className="space-y-2">
          {rituals.map((r) => (
            <div
              key={`${r.created_at ?? ''}|${r.content || r.title}`}
              className="rounded-2xl border line surf px-3.5 py-2.5"
            >
              <div className="text-xs ink-1">{r.content || r.title}</div>
              <div className="dim mt-0.5">{fmtTime(r.created_at)}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="dim">还没有固定仪式。比如"每天睡前互道晚安"，加上它，到点她会自然来找你。</p>
      )}
      <div className="mt-3 flex gap-2">
        <input className="input" placeholder="新增仪式，例如：每天睡前互道晚安" value={newRitual} onChange={(e) => setNewRitual(e.target.value)} />
        <button
          className="btn"
          disabled={busy || pending || !newRitual.trim()}
          onClick={async () => {
            if (pending) return;
            setPending(true);
            try {
              // 提交 trim 后的内容（与服务端去重口径一致）；仅在成功时清空输入
              const r = await post({ action: 'add_ritual', content: newRitual.trim() }, '已记下仪式');
              if (r) setNewRitual('');
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