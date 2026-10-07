'use client';

import Link from 'next/link';
import { Chip, Bar } from '@/components/ui';
import { statusLabelOf, STATUS_TONE, type RosterEntry } from './shared';

/** 伴侣卡片：头像 / 名 / 阶段 / 未读角标 / 吸引力进度 */
export function CompanionCard({ entry, href }: { entry: RosterEntry; href?: string }) {
  const tone = STATUS_TONE[entry.status] ?? 'plain';
  const to = href ?? `/companions/${entry.id}`;
  return (
    <Link
      href={to}
      className="card-tight flex items-center gap-3 transition hover:shadow-soft"
      aria-label={`${entry.displayName}，${statusLabelOf(entry.status, entry.statusLabel)}`}
    >
      <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl accent-soft text-lg">
        {entry.avatar_url ? (
          // 头像可能是外链或本地路径
          <img src={entry.avatar_url} alt="" className="h-12 w-12 rounded-2xl object-cover" />
        ) : (
          <span aria-hidden>{(entry.displayName || '她').slice(0, 1)}</span>
        )}
        {entry.unread > 0 ? (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-medium leading-none text-white shadow-bubble">
            {entry.unread > 9 ? '9+' : entry.unread}
          </span>
        ) : null}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium ink-1">{entry.displayName}</span>
          {entry.is_primary === 1 ? <Chip tone="rose">主女友</Chip> : null}
          <Chip tone={tone}>{statusLabelOf(entry.status, entry.statusLabel)}</Chip>
        </div>
        <div className="dim mt-0.5 truncate">
          {entry.age} 岁{entry.identity ? ` · ${entry.identity}` : ''}
        </div>
        {entry.origin_label ? (
          <div className="mt-0.5 truncate text-[11px] acc" title={entry.origin_label}>
            {entry.origin_kind === 'cast' ? '👥 ' : entry.origin_kind === 'auto' ? '✨ ' : '🎲 '}
            {entry.origin_label}
          </div>
        ) : null}
        {entry.status !== 'girlfriend' && entry.status !== 'closed' ? (
          <div className="mt-1.5">
            <Bar value={entry.attraction} tone="peach" height={6} />
          </div>
        ) : null}
      </div>
    </Link>
  );
}
