'use client';

import { Card, fmtTime } from '@/components/ui';
import type { PostFn, SharedEntry } from './shared';

export function SharedPlansCard({
  plans,
  busy,
  post,
  newPlan,
  setNewPlan,
}: {
  plans?: SharedEntry[];
  busy: boolean;
  post: PostFn;
  newPlan: string;
  setNewPlan: React.Dispatch<React.SetStateAction<string>>;
}) {
  return (
    <Card title="共同计划">
      {plans?.length ? (
        <div className="space-y-2">
          {plans.map((pl, i) => {
            // 新条目带稳定 id；老数据没有 id 时回退到下标（服务端同样兼容）
            const planId = (pl as SharedEntry & { id?: string }).id;
            return (
              <div key={planId || i} className="flex items-center justify-between gap-2 rounded-2xl border line surf px-3.5 py-2.5">
                <div className="min-w-0">
                  <div className={`text-xs ${pl.status === 'done' ? 'ink-3 line-through' : 'ink-1'}`}>{pl.content || pl.title}</div>
                  <div className="dim mt-0.5">{pl.status === 'done' ? '已完成' : '计划中'} · {fmtTime(pl.created_at)}</div>
                </div>
                <button className="btn-ghost shrink-0 !py-1 text-xs" disabled={busy} onClick={() => post({ action: 'toggle_plan', id: planId, index: i }, '已更新')}>
                  {pl.status === 'done' ? '标为未完成' : '完成'}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="dim">还没有约定。聊天里说到"我们一起去……"就会自动记下来。</p>
      )}
      <div className="mt-3 flex gap-2">
        <input className="input" placeholder="新增约定，例如：周末一起看那部剧" value={newPlan} onChange={(e) => setNewPlan(e.target.value)} />
        <button className="btn" disabled={busy || !newPlan.trim()} onClick={async () => { await post({ action: 'add_plan', content: newPlan }, '已记下约定'); setNewPlan(''); }}>
          添加
        </button>
      </div>
    </Card>
  );
}