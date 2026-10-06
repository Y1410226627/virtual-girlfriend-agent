'use client';

import { SCHEDULE_STATUS_LABEL, type ActivityScheduleItem } from './shared';

const DOT: Record<string, string> = { done: '✓', current: '●', pending: '○' };

/**
 * 线下「约会日程」时间线：见面 → … → 收尾。
 * 已完成划线、进行中高亮、待办灰显；可选「推进到下一步」。
 */
export function DateScheduleView({
  items,
  onAdvance,
  busy = false,
}: {
  items: ActivityScheduleItem[];
  onAdvance?: () => void;
  busy?: boolean;
}) {
  if (!items.length) {
    return <div className="dim">这次活动还没有日程安排。</div>;
  }
  const atEnd = items.every((it) => it.status === 'done');
  return (
    <div>
      <ol className="relative ml-1.5 border-l line">
        {items.map((it) => {
          const current = it.status === 'current';
          const done = it.status === 'done';
          return (
            <li key={it.id} className="relative pb-3 pl-5 last:pb-0">
              <span
                className={`absolute -left-[9px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${
                  current ? 'bg-rose-500 text-white' : 'surf border line ink-3'
                }`}
                aria-hidden
              >
                {DOT[it.status] || '○'}
              </span>
              <span className={`text-sm ${current ? 'font-medium acc' : done ? 'ink-3 line-through' : 'ink-2'}`}>
                {it.title}
              </span>
              <span className="ml-2 text-[11px] ink-3">{SCHEDULE_STATUS_LABEL[it.status] || it.status}</span>
            </li>
          );
        })}
      </ol>
      {onAdvance ? (
        <button className="btn-ghost mt-1" onClick={onAdvance} disabled={busy || atEnd}>
          {atEnd ? '日程已走完' : '推进到下一步'}
        </button>
      ) : null}
    </div>
  );
}
