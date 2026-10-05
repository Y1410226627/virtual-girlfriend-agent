'use client';

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
  return (
    <Card title="共同仪式">
      {rituals?.length ? (
        <div className="space-y-2">
          {rituals.map((r, i) => (
            <div key={i} className="rounded-2xl border line surf px-3.5 py-2.5">
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
        <button className="btn" disabled={busy || !newRitual.trim()} onClick={async () => { await post({ action: 'add_ritual', content: newRitual }, '已记下仪式'); setNewRitual(''); }}>
          添加
        </button>
      </div>
    </Card>
  );
}