'use client';

import { useMemo, useState } from 'react';
import { useApi, PageHeader, Loading, ErrorBox, Toast } from '@/components/ui';
import { errMsg } from '@/lib/utils';
import { TYPES, type MemoriesData, type NewMem } from '@/components/memories/shared';
import { StarMapCard } from '@/components/memories/StarMapCard';
import { StatsCard } from '@/components/memories/StatsCard';
import { MemoryForm } from '@/components/memories/MemoryForm';
import { MemoryList } from '@/components/memories/MemoryList';
import { SummariesCard } from '@/components/memories/SummariesCard';

export default function MemoriesPage() {
  const [type, setType] = useState('');
  const [status, setStatus] = useState('active');
  const { data, loading, error, reload } = useApi<MemoriesData>(`/api/memories?type=${type}&status=${status}`);
  const [toast, setToast] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [newMem, setNewMem] = useState<NewMem>({ type: 'semantic', content: '', importance: 7, emotion: '' });

  const memories = useMemo(() => data?.memories || [], [data]);

  const act = async (body: Record<string, unknown>, msg?: string): Promise<boolean> => {
    try {
      const r = await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `操作失败 ${r.status}`);
      if (msg) setToast(msg);
      await reload();
      return true;
    } catch (e) {
      setToast(errMsg(e) || '操作失败');
      return false;
    }
  };

  const saveEdit = async (id: number) => {
    try {
      const r = await fetch('/api/memories', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, content: draft }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `保存失败 ${r.status}`);
      setEditing(null);
      setToast('已保存（会重新计算向量）');
      await reload();
    } catch (e) {
      setToast(errMsg(e) || '保存失败');
    }
  };

  const remove = async (id: number) => {
    if (!confirm('删除这条记忆？')) return;
    try {
      const r = await fetch(`/api/memories?id=${id}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `删除失败 ${r.status}`);
      setToast('已删除');
      await reload();
    } catch (e) {
      setToast(errMsg(e) || '删除失败');
    }
  };

  const changeImportance = async (id: number, importance: number): Promise<boolean> => {
    try {
      const r = await fetch('/api/memories', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, importance }),
      });
      if (!r.ok) throw new Error();
      await reload();
      return true;
    } catch {
      setToast('重要度调整失败，请重试');
      return false;
    }
  };

  if (loading && !data) return <Loading text="正在打开她的记忆…" />;
  // 仅初次加载就失败才整页替换；已有数据时用顶部横幅提示，保留已加载内容可继续查看/操作
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />;

  return (
    <div className="pb-10">
      {error ? <ErrorBox message={error} onRetry={reload} /> : null}
      <PageHeader
        title="记忆"
        desc="她记住的关于你的一切。可以查看、编辑、删除；低价值记忆会自动归档。"
        right={
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => act({ action: 'forget' }, '已归档低价值记忆')}>
              整理记忆
            </button>
            <button className="btn-ghost" onClick={() => setCreating((v) => !v)}>
              手动添加
            </button>
          </div>
        }
      />

      {data?.stats ? <StarMapCard stats={data.stats} /> : null}

      <StatsCard stats={data?.stats} />

      {creating ? (
        <MemoryForm newMem={newMem} setNewMem={setNewMem} act={act} setToast={setToast} setCreating={setCreating} />
      ) : null}

      <div className="px-5 pt-5 md:px-8">
        <div className="flex flex-wrap items-center gap-2">
          {TYPES.map((t) => (
            <button
              key={t.key}
              onClick={() => setType(t.key)}
              className={type === t.key ? 'btn-soft' : 'btn-ghost'}
            >
              {t.label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px accent-soft" />
          <button onClick={() => setStatus(status === 'active' ? 'archived' : 'active')} className="btn-ghost">
            {status === 'active' ? '查看已归档' : '返回有效记忆'}
          </button>
        </div>
      </div>

      <MemoryList
        memories={memories}
        editing={editing}
        draft={draft}
        setDraft={setDraft}
        setEditing={setEditing}
        saveEdit={saveEdit}
        remove={remove}
        changeImportance={changeImportance}
      />

      <SummariesCard summaries={data?.summaries} />

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}