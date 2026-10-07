'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApi, PageHeader, Loading, ErrorBox, Chip, fmtTime } from '@/components/ui';
import { colorOf } from '@/components/groups/shared';

interface GroupRow {
  id: number;
  name: string;
  topic: string | null;
  status: string;
  last_message_at: string | null;
  created_at: string;
  memberIds: number[];
  memberNames: string[];
  lastMessageId: number;
  /** 群的来历：'manual'（手动建群）| 'presence'（线下共处）| 'activity'（活动）；旧数据可能没有 → 不显示标签 */
  origin?: string | null;
  /** 共处群的主伴侣（数据有就显示在标签里） */
  host_companion_id?: number | null;
  host_companion_name?: string | null;
}

/** origin → 列表小标签文案（manual / 未知来历不显示） */
function originLabel(g: GroupRow): string | null {
  if (g.origin === 'presence') return g.host_companion_name ? `线下共处 · ${g.host_companion_name}` : '线下共处';
  if (g.origin === 'activity') return '活动';
  return null;
}

interface GroupListResponse {
  ok: boolean;
  groups: GroupRow[];
}

export default function GroupsPage() {
  const { data, loading, error, reload } = useApi<GroupListResponse>('/api/groups');
  // 未读群集合：本地已读 id 与群最后一条消息 id 比较；在 effect 里读取，避免 SSR/水合不一致
  const [unreadIds, setUnreadIds] = useState<number[]>([]);

  const groups = data?.groups ?? [];

  useEffect(() => {
    if (!data?.groups) return;
    const unread: number[] = [];
    for (const g of data.groups) {
      const lastRead = Number(window.localStorage.getItem(`groupRead:${g.id}`) || 0);
      if (g.lastMessageId > lastRead) unread.push(g.id);
    }
    setUnreadIds(unread);
  }, [data]);

  if (loading && !data) return <Loading text="正在读群聊…" />;
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />;

  return (
    <div className="pb-10">
      {error ? <ErrorBox message={error} onRetry={reload} /> : null}
      <PageHeader
        title="群聊"
        desc="把你的女友们拉进一个群，让她们彼此认识、互相接话。群里只有公开的角色卡，没有任何私密记忆。"
        right={
          <Link className="btn" href="/groups/new">
            新建群聊
          </Link>
        }
      />
      <div className="px-5 md:px-8">
        {groups.length ? (
          <div className="grid gap-2.5 md:grid-cols-2">
            {groups.map((g) => (
              <Link key={g.id} href={`/groups/${g.id}`} className="card-tight flex items-center gap-3 transition hover:shadow-soft">
                <span className="flex -space-x-2" aria-hidden>
                  {g.memberIds.slice(0, 3).map((mid, i) => (
                    <span
                      key={mid}
                      className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-white text-xs text-white"
                      style={{ backgroundColor: colorOf(mid), zIndex: 3 - i }}
                    >
                      {(g.memberNames[i] || '她').slice(0, 1)}
                    </span>
                  ))}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium ink-1">{g.name}</span>
                    {(() => {
                      const label = originLabel(g);
                      return label ? <Chip tone="plain">{label}</Chip> : null;
                    })()}
                    {unreadIds.includes(g.id) ? (
                      <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-medium leading-none text-white">
                        新
                      </span>
                    ) : null}
                  </span>
                  <span className="dim mt-0.5 block truncate">
                    {g.memberNames.join('、')}
                    {g.last_message_at ? ` · ${fmtTime(g.last_message_at)}` : ''}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <div className="dim">还没有群聊。点右上角「新建群聊」，选 2–6 名已晋升的女友试试。</div>
        )}
      </div>
    </div>
  );
}
