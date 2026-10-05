'use client';

import { Card, fmtTime } from '@/components/ui';
import type { RelLog } from './shared';

export function LogsCard({ logs }: { logs: RelLog[] }) {
  return (
    <Card title="关系日志">
      <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
        {logs.map((l) => (
          <div key={l.id} className="rounded-2xl border line surf px-3.5 py-2.5">
            <div className="flex items-center justify-between">
              <span className="min-w-0 flex-1 break-words text-xs font-medium ink-1">{l.summary}</span>
              <span className="shrink-0 text-[11px] ink-3">{fmtTime(l.created_at)}</span>
            </div>
            {l.reason ? <div className="dim mt-1 leading-relaxed">{l.reason}</div> : null}
          </div>
        ))}
        {logs.length === 0 ? <p className="dim">还没有记录。</p> : null}
      </div>
    </Card>
  );
}