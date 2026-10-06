'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, PageHeader, Card, Loading, ErrorBox, Toast } from '@/components/ui';
import { GroupMemberPicker } from '@/components/groups/GroupMemberPicker';
import { ActivityList } from '@/components/activities/ActivityList';
import { ACTIVITY_TEMPLATE_LABELS, type ActivitySummaryView } from '@/components/activities/shared';
import { errMsg } from '@/lib/utils';
import type { GroupMemberLite } from '@/components/groups/shared';
import type { RosterEntry, RosterView } from '@/components/companions/shared';

const MAX = 6;
const MIN = 2;

interface ActivitiesResponse {
  ok: boolean;
  activities: ActivitySummaryView[];
}

/**
 * 「活动」页：发起线上/线下活动 + 活动列表。
 * - 线上：选一个模板（看电影/打游戏/深夜卧谈/一起听歌），她们在群里按调度互动。
 * - 线下：生成约会日程（见面→…→道别），互动时轮流聚焦一人，结束后把好感/关系落库。
 */
export default function ActivitiesPage() {
  const router = useRouter();
  const { data, loading, error, reload } = useApi<ActivitiesResponse>('/api/activities');
  const roster = useApi<RosterView>('/api/companions');

  const [kind, setKind] = useState<'online' | 'offline'>('online');
  const [templateKey, setTemplateKey] = useState<string>('nighttalk');
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // 可选参与者：主女友 + 已晋升女友
  const candidates: GroupMemberLite[] = useMemo(() => {
    const list: RosterEntry[] = [];
    if (roster.data?.primary) list.push(roster.data.primary);
    for (const g of roster.data?.girlfriends ?? []) list.push(g);
    const seen = new Set<number>();
    const out: GroupMemberLite[] = [];
    for (const e of list) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ id: e.id, name: e.displayName || e.name, avatar_url: e.avatar_url, identity: e.identity, age: e.age });
    }
    return out;
  }, [roster.data]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX) return prev;
      return [...prev, id];
    });
  };

  const create = async () => {
    if (selected.length < MIN) {
      setToast(`至少选择 ${MIN} 名已晋升女友`);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/activities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          templateKey: kind === 'online' ? templateKey : undefined,
          title: title.trim() || undefined,
          memberIds: selected,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.id) throw new Error(j?.error || `发起失败 ${r.status}`);
      router.push(`/activities/${j.id}`);
    } catch (e) {
      setToast(errMsg(e) || '发起失败');
    } finally {
      setBusy(false);
    }
  };

  const activities = data?.activities ?? [];

  if (loading && !data) return <Loading text="正在读活动…" />;
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />;

  return (
    <div className="pb-10">
      {error ? <ErrorBox message={error} onRetry={reload} /> : null}
      <PageHeader
        title="活动"
        desc="约她们一起玩：线上复用一个群聊，线下则排一段约会日程、轮流陪每一个人。"
      />

      <div className="px-5 md:px-8">
        <Card title="发起活动">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="dim">形式</span>
            <div className="flex items-center gap-0.5 rounded-full border line surf p-0.5 text-[12px]">
              {(
                [
                  ['online', '线上一起玩'],
                  ['offline', '线下约会'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`rounded-full px-3 py-1 transition ${kind === k ? 'bg-rose-500 text-white' : 'ink-2 hover:accent-soft'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {kind === 'online' ? (
            <label className="mb-3 block">
              <span className="dim">玩点什么</span>
              <select
                className="mt-1 w-full rounded-2xl surf border line px-3.5 py-2.5 text-sm ink-1 outline-none"
                value={templateKey}
                onChange={(e) => setTemplateKey(e.target.value)}
              >
                {Object.entries(ACTIVITY_TEMPLATE_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="mb-3 block">
            <span className="dim">活动名（可选）</span>
            <input
              className="mt-1 w-full rounded-2xl surf border line px-3.5 py-2.5 text-sm ink-1 outline-none"
              placeholder={kind === 'offline' ? '例如：周末美术馆' : '例如：周五夜谈'}
              maxLength={40}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
        </Card>

        <Card className="mt-4" title={`参与者（已选 ${selected.length}/${MAX}）`}>
          <GroupMemberPicker members={candidates} selected={selected} max={MAX} onToggle={toggle} />
        </Card>

        <div className="mt-4">
          <button className="btn" onClick={create} disabled={busy || selected.length < MIN}>
            {busy ? '发起中…' : '发起活动'}
          </button>
        </div>
      </div>

      <div className="mt-6 px-5 md:px-8">
        <h2 className="section-title mb-3">活动记录</h2>
        <ActivityList activities={activities} />
      </div>

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}
