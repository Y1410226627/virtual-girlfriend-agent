'use client';

import { useMemo, useState } from 'react';
import { useApi, PageHeader, Card, Stat, Loading, ErrorBox, Toast, fmtTime, Chip } from '@/components/ui';

const TYPES = [
  { key: '', label: '全部' },
  { key: 'semantic', label: '事实' },
  { key: 'episodic', label: '事件' },
  { key: 'emotional', label: '情绪' },
  { key: 'relationship', label: '关系' },
  { key: 'attachment', label: '依恋' },
];

export default function MemoriesPage() {
  const [type, setType] = useState('');
  const [status, setStatus] = useState('active');
  const { data, loading, error, reload } = useApi<any>(`/api/memories?type=${type}&status=${status}`);
  const [toast, setToast] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [newMem, setNewMem] = useState({ type: 'semantic', content: '', importance: 7, emotion: '' });

  const memories = useMemo(() => data?.memories || [], [data]);

  const act = async (body: any, msg?: string) => {
    const r = await fetch('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (msg) setToast(j?.error ? j.error : msg);
    reload();
  };

  const saveEdit = async (id: number) => {
    await fetch('/api/memories', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, content: draft }),
    });
    setEditing(null);
    setToast('已保存（会重新计算向量）');
    reload();
  };

  const remove = async (id: number) => {
    await fetch(`/api/memories?id=${id}`, { method: 'DELETE' });
    setToast('已删除');
    reload();
  };

  const changeImportance = async (id: number, importance: number) => {
    await fetch('/api/memories', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, importance }),
    });
    reload();
  };

  if (loading && !data) return <Loading text="正在打开她的记忆…" />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;

  return (
    <div className="pb-10">
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

      <div className="grid grid-cols-2 gap-3 px-5 md:grid-cols-4 md:px-8">
        <Stat label="有效记忆" value={data?.stats?.total ?? 0} unit="条" />
        <Stat label="已归档" value={data?.stats?.archived ?? 0} unit="条" tone="ink" />
        {(data?.stats?.byType || []).slice(0, 2).map((t: any) => (
          <Stat key={t.type} label={t.label} value={t.count} unit="条" tone="peach" />
        ))}
      </div>

      {creating ? (
        <div className="px-5 pt-4 md:px-8">
          <Card title="添加一条记忆">
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="label">类型</label>
                <select className="input" value={newMem.type} onChange={(e) => setNewMem((s) => ({ ...s, type: e.target.value }))}>
                  <option value="semantic">事实（稳定偏好/信息）</option>
                  <option value="episodic">事件（具体发生过的事）</option>
                  <option value="emotional">情绪（他的状态）</option>
                  <option value="relationship">关系（你们的进展）</option>
                </select>
              </div>
              <div>
                <label className="label">重要度（0-10，越重要越不容易遗忘）</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={10}
                  value={newMem.importance}
                  onChange={(e) => setNewMem((s) => ({ ...s, importance: Number(e.target.value) }))}
                />
              </div>
            </div>
            <div className="mt-3">
              <label className="label">内容</label>
              <textarea
                className="textarea"
                rows={2}
                placeholder="例如：他喜欢冰美式，讨厌香菜"
                value={newMem.content}
                onChange={(e) => setNewMem((s) => ({ ...s, content: e.target.value }))}
              />
            </div>
            <button
              className="btn mt-3"
              onClick={async () => {
                await act({ action: 'create', ...newMem }, '记住了');
                setNewMem({ type: 'semantic', content: '', importance: 7, emotion: '' });
                setCreating(false);
              }}
            >
              保存
            </button>
          </Card>
        </div>
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
          <span className="mx-1 h-4 w-px bg-rose-100" />
          <button onClick={() => setStatus(status === 'active' ? 'archived' : 'active')} className="btn-ghost">
            {status === 'active' ? '查看已归档' : '返回有效记忆'}
          </button>
        </div>
      </div>

      <div className="space-y-3 px-5 pt-4 md:px-8">
        {memories.length === 0 ? (
          <div className="card dim text-center">这里还是空的，多聊聊她就会记住你的事了。</div>
        ) : null}
        {memories.map((m: any) => (
          <div key={m.id} className="card-tight">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip>{TYPES.find((t) => t.key === m.type)?.label || m.type}</Chip>
                  <span className="text-[11px] text-ink-300">
                    重要度 {m.importance} · {fmtTime(m.created_at)}
                    {m.access_count ? ` · 被想起 ${m.access_count} 次` : ''}
                  </span>
                  {m.emotion ? <Chip tone="plain">{m.emotion}</Chip> : null}
                </div>
                {editing === m.id ? (
                  <div className="mt-2">
                    <textarea className="textarea" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} />
                    <div className="mt-2 flex gap-2">
                      <button className="btn" onClick={() => saveEdit(m.id)}>
                        保存
                      </button>
                      <button className="btn-ghost" onClick={() => setEditing(null)}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 text-sm leading-relaxed text-ink-900 break-words">{m.content}</p>
                )}
              </div>
              {editing === m.id ? null : (
                <div className="flex shrink-0 flex-col gap-1.5">
                  <button
                    className="btn-ghost !px-2.5 !py-1 text-xs"
                    onClick={() => {
                      setEditing(m.id);
                      setDraft(m.content);
                    }}
                  >
                    编辑
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    value={m.importance}
                    className="h-1 w-20 accent-rose-500"
                    onChange={(e) => changeImportance(m.id, Number(e.target.value))}
                  />
                  <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => remove(m.id)}>
                    删除
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="px-5 pt-6 md:px-8">
        <Card title="每日回顾（把一整天压缩成一段记忆）">
          {(data?.summaries || []).length === 0 ? (
            <p className="dim">还没有摘要。等你们聊过一整天，第二天就会自动生成。</p>
          ) : (
            <div className="space-y-3">
              {data.summaries.map((s: any) => (
                <div key={s.id} className="rounded-2xl bg-rose-50/60 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Chip tone="plain">{s.date}</Chip>
                    {s.meta ? <span className="text-[11px] text-ink-300">{JSON.parse(s.meta).messages} 条消息</span> : null}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-700">{s.summary}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}