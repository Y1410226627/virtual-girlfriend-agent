'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, PageHeader, Card, Loading, ErrorBox, Toast } from '@/components/ui';
import { GroupMemberPicker } from '@/components/groups/GroupMemberPicker';
import { errMsg } from '@/lib/utils';
import type { GroupMemberLite } from '@/components/groups/shared';
import type { RosterEntry, RosterView } from '@/components/companions/shared';

const MAX = 6;
const MIN = 2;

export default function NewGroupPage() {
  const router = useRouter();
  const { data, loading, error, reload } = useApi<RosterView>('/api/companions');
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // 可入群的角色：主女友 + 已晋升女友
  const candidates: GroupMemberLite[] = useMemo(() => {
    const list: RosterEntry[] = [];
    if (data?.primary) list.push(data.primary);
    for (const g of data?.girlfriends ?? []) list.push(g);
    const seen = new Set<number>();
    const out: GroupMemberLite[] = [];
    for (const e of list) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ id: e.id, name: e.displayName || e.name, avatar_url: e.avatar_url, identity: e.identity, age: e.age });
    }
    return out;
  }, [data]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX) return prev;
      return [...prev, id];
    });
  };

  const create = async () => {
    const nm = name.trim();
    if (!nm) {
      setToast('给群起个名字吧');
      return;
    }
    if (selected.length < MIN) {
      setToast(`至少选择 ${MIN} 名已晋升女友`);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nm, topic: topic.trim() || null, memberIds: selected }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.id) throw new Error(j?.error || `建群失败 ${r.status}`);
      router.push(`/groups/${j.id}`);
    } catch (e) {
      setToast(errMsg(e) || '建群失败');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Loading text="正在读通讯录…" />;
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />;

  return (
    <div className="pb-10">
      {error ? <ErrorBox message={error} onRetry={reload} /> : null}
      <PageHeader title="新建群聊" desc={`选 ${MIN}–${MAX} 名已晋升为女友的角色，她们会在群里彼此认识、互相接话。`} />
      <div className="px-5 md:px-8">
        <Card className="mb-4">
          <div className="grid gap-3">
            <label className="block">
              <span className="dim">群名</span>
              <input
                className="mt-1 w-full rounded-2xl surf border line px-3.5 py-2.5 text-sm ink-1 outline-none"
                placeholder="例如：周末客厅"
                maxLength={30}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="dim">话题（可选）</span>
              <input
                className="mt-1 w-full rounded-2xl surf border line px-3.5 py-2.5 text-sm ink-1 outline-none"
                placeholder="例如：周末去哪儿"
                maxLength={60}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              />
            </label>
          </div>
        </Card>

        <Card title={`成员（已选 ${selected.length}/${MAX}）`}>
          <GroupMemberPicker members={candidates} selected={selected} max={MAX} onToggle={toggle} />
        </Card>

        <div className="mt-4 flex items-center gap-2">
          <button className="btn" onClick={create} disabled={busy || selected.length < MIN || !name.trim()}>
            {busy ? '创建中…' : '创建群聊'}
          </button>
          <button className="btn-ghost" onClick={() => router.push('/groups')} disabled={busy}>
            取消
          </button>
        </div>
      </div>
      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}
