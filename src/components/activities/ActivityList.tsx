'use client';

import Link from 'next/link';
import { fmtTime } from '@/components/ui';
import { colorOf } from '@/components/groups/shared';
import {
  activityStatusLabel,
  ACTIVITY_KIND_ICON,
  ACTIVITY_KIND_LABEL,
  templateLabel,
  type ActivitySummaryView,
} from './shared';

/**
 * 活动列表：线上（复用群聊）与线下（约会日程）统一展示。
 * 每张卡片：类型图标 + 标题 + 类型/状态标签 + 参与者头像 + 日程步数 + 小结。
 */
export function ActivityList({ activities }: { activities: ActivitySummaryView[] }) {
  if (!activities.length) {
    return <div className="dim">还没有活动。挑几位女友一起线上玩，或约一次线下见面吧。</div>;
  }
  return (
    <div className="grid gap-2.5 md:grid-cols-2">
      {activities.map((a) => {
        const ongoing = a.status === 'ongoing';
        return (
          <Link
            key={a.id}
            href={`/activities/${a.id}`}
            className="card-tight flex items-start gap-3 transition hover:shadow-soft"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl accent-soft text-lg" aria-hidden>
              {ACTIVITY_KIND_ICON[a.kind] || '🎈'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium ink-1">{a.title}</span>
                <span className="chip-plain">{ACTIVITY_KIND_LABEL[a.kind] || a.kind}</span>
                {ongoing ? (
                  <span className="chip">{activityStatusLabel(a.status)}</span>
                ) : (
                  <span className="chip-plain">{activityStatusLabel(a.status)}</span>
                )}
              </span>
              <span className="dim mt-1 block truncate">
                {a.participantNames.join('、')}
                {a.kind === 'offline' && a.scheduleCount ? ` · 日程 ${a.scheduleCount} 步` : ''}
                {a.template_key ? ` · ${templateLabel(a.template_key)}` : ''}
              </span>
              {a.summary ? <span className="mt-1 block truncate text-[11px] ink-3">{a.summary}</span> : null}
              <span className="mt-1.5 flex items-center gap-1">
                {a.participantIds.slice(0, 6).map((pid, i) => (
                  <span
                    key={pid}
                    className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] text-white"
                    style={{ backgroundColor: colorOf(pid) }}
                    aria-hidden
                  >
                    {(a.participantNames[i] || '她').slice(0, 1)}
                  </span>
                ))}
                <span className="dim ml-auto">{fmtTime(a.updated_at || a.created_at)}</span>
              </span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}
