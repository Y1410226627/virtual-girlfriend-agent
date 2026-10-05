'use client';

import { Card, fmtTime } from '@/components/ui';
import { timelineText } from './shared';
import type { TimelineRow } from './shared';

export function TimelineCard({ timeline }: { timeline?: TimelineRow[] }) {
  return (
    <Card title="她的一天（时间线）">
      {timeline?.length ? (
        <div className="space-y-2">
          {timeline.map((l, i) => (
            <div key={`${l.created_at ?? ''}-${i}`} className="flex items-start gap-3 rounded-2xl border line surf px-3.5 py-2.5">
              <span className="mt-0.5 shrink-0 whitespace-nowrap text-[11px] ink-3">{fmtTime(l.created_at)}</span>
              <div className="min-w-0">
                <div className="text-xs ink-1">{timelineText(l)}</div>
                {l.reason ? <div className="dim mt-0.5">{l.reason}</div> : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="dim">今天还没有记录。她的作息会自动推进，过一会儿再来看看。</p>
      )}
    </Card>
  );
}