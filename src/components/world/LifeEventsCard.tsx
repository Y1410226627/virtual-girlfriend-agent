'use client';

import { Card, Chip, fmtTime } from '@/components/ui';
import { eventTypeLabel } from './shared';
import type { LifeEvent } from './shared';

export function LifeEventsCard({
  events,
  eventsTotal,
  showAllEvents,
  setShowAllEvents,
}: {
  events?: LifeEvent[];
  eventsTotal?: number;
  showAllEvents: boolean;
  setShowAllEvents: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const total = eventsTotal ?? events?.length ?? 0;
  return (
    <Card title="生活日记（她自己经历的小事）">
      {events?.length ? (
        <div className="space-y-2">
          {(showAllEvents ? events : events.slice(0, 20)).map((e) => (
            <div key={e.id} className="rounded-2xl accent-soft px-3.5 py-2.5">
              <div className="flex items-center gap-2">
                <Chip tone="plain">{eventTypeLabel(e.event_type)}</Chip>
                <span className="text-[11px] ink-3">{fmtTime(e.created_at)}</span>
              </div>
              <div className="mt-1 text-xs leading-relaxed ink-2">{e.content}</div>
            </div>
          ))}
          {total > 20 ? (
            <button className="btn-ghost w-full !py-1.5 text-xs" onClick={() => setShowAllEvents((v) => !v)}>
              {showAllEvents ? '收起' : `展开全部（共 ${total} 条）`}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="dim">还没有什么特别的事发生。</p>
      )}
    </Card>
  );
}