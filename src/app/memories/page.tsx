'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi, PageHeader, Card, Stat, Loading, ErrorBox, Toast, fmtTime, Chip } from '@/components/ui';

const TYPES = [
  { key: '', label: '全部' },
  { key: 'semantic', label: '事实' },
  { key: 'episodic', label: '事件' },
  { key: 'emotional', label: '情绪' },
  { key: 'relationship', label: '关系' },
  { key: 'attachment', label: '依恋' },
];

/** 安全解析 meta（脏数据不让页面白屏） */
function safeParseMeta(raw: any): any {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** 重要度钳制到 0~10 */
function clampImportance(v: any): number {
  const n = Number(v);
  return Math.max(0, Math.min(10, Number.isFinite(n) ? n : 7));
}

/** 重要度滑杆：拖动时只改本地值，松手/失焦才提交一次 */
function ImportanceSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [local, setLocal] = useState(value);
  const committed = useRef(value);
  useEffect(() => {
    setLocal(value);
    committed.current = value;
  }, [value]);
  const commit = () => {
    if (local !== committed.current) {
      committed.current = local;
      onChange(local);
    }
  };
  return (
    <input
      type="range"
      min={0}
      max={10}
      value={local}
      aria-label="重要度"
      className="h-1 w-20 accent-rose-500"
      onChange={(e) => setLocal(Number(e.target.value))}
      onMouseUp={commit}
      onTouchEnd={commit}
      onBlur={commit}
    />
  );
}

/**
 * 记忆星图：纯 SVG 手绘散点（x=重要度，y=被想起次数）+ 最常想起 + 重要度分布。
 * 数据全部来自服务端返回的 stats，stats 缺失时不渲染（由调用处控制）。
 */
function MemoryStarMap({ stats }: { stats: any }) {
  const scatter: any[] = Array.isArray(stats?.scatter) ? stats.scatter : [];
  const topAccessed: any[] = Array.isArray(stats?.topAccessed) ? stats.topAccessed : [];
  const buckets: any[] = Array.isArray(stats?.importanceBuckets) ? stats.importanceBuckets : [];
  const counts = stats?.counts || { active: 0, archived: 0, superseded: 0 };

  // 一条记忆都没有：给一句引导文案
  if (!scatter.length && !counts.active && !counts.archived && !counts.superseded) {
    return (
      <div className="px-5 pt-4 md:px-8">
        <Card title="记忆星图">
          <p className="dim">她还没记住什么。多聊聊，星图上就会亮起属于你们的光点。</p>
        </Card>
      </div>
    );
  }

  // 散点坐标系（viewBox 内绘制，width 100% 自适应）
  const W = 600;
  const H = 200;
  const padL = 34;
  const padR = 12;
  const padT = 14;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxAccess = Math.max(1, ...scatter.map((s) => Number(s.access_count) || 0));
  const xOf = (imp: number) => padL + (Math.max(0, Math.min(10, imp)) / 10) * plotW;
  const yOf = (acc: number) => padT + plotH - (Math.max(0, acc) / maxAccess) * plotH;
  const rOf = (imp: number) => 3 + (Math.max(0, Math.min(10, imp)) / 10) * 3; // 半径 3~6，按重要度
  const yTicks = Array.from(new Set([0, Math.round(maxAccess / 2), maxAccess]));

  const maxBucket = Math.max(1, ...buckets.map((b) => Number(b.count) || 0));

  return (
    <div className="px-5 pt-4 md:px-8">
      <Card title="记忆星图">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="记忆星图（横轴重要度，纵轴被想起次数）">
          {/* 坐标轴：淡灰细线 */}
          <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} style={{ stroke: 'var(--line)' }} strokeWidth={1} />
          <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} style={{ stroke: 'var(--line)' }} strokeWidth={1} />
          {/* x 轴刻度（重要度 0/5/10） */}
          {[0, 5, 10].map((t) => (
            <text key={`x${t}`} x={xOf(t)} y={padT + plotH + 15} textAnchor="middle" fontSize={10} style={{ fill: 'var(--ink-3)' }}>
              {t}
            </text>
          ))}
          {/* y 轴刻度（被想起次数） */}
          {yTicks.map((t) => (
            <text key={`y${t}`} x={padL - 6} y={yOf(t) + 3} textAnchor="end" fontSize={10} style={{ fill: 'var(--ink-3)' }}>
              {t}
            </text>
          ))}
          {/* 每个记忆一个圆点，<title> 做悬停提示 */}
          {scatter.map((s) => (
            <circle
              key={s.id}
              cx={xOf(Number(s.importance) || 0)}
              cy={yOf(Number(s.access_count) || 0)}
              r={rOf(Number(s.importance) || 0)}
              fill="#FF7BA0"
              fillOpacity={0.5}
            >
              <title>{`${s.content}（重要度 ${Number(s.importance) || 0} · 想起 ${Number(s.access_count) || 0} 次）`}</title>
            </circle>
          ))}
        </svg>

        {/* 状态统计行 */}
        <div className="mt-2 text-[11px] ink-3">
          她一直记得：{counts.active ?? 0} 条 · 归档：{counts.archived ?? 0} 条 · 已被取代：{counts.superseded ?? 0} 条
        </div>

        <div className="mt-4 grid gap-5 md:grid-cols-2">
          {/* 最常想起（前 10） */}
          <div>
            <div className="section-title">最常想起</div>
            {topAccessed.length === 0 ? (
              <p className="dim">还没有被想起过的记忆。</p>
            ) : (
              <ol className="space-y-1.5">
                {topAccessed.map((m, i) => (
                  <li key={m.id} className="flex items-center gap-2 rounded-xl accent-soft px-3 py-1.5">
                    <span className="w-4 shrink-0 text-[11px] font-semibold acc">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-xs ink-2">{m.content}</span>
                    <span className="chip shrink-0">想起 {m.access_count} 次</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {/* 重要度分布：四根小柱条 */}
          <div>
            <div className="section-title">重要度分布</div>
            <div className="flex items-end gap-3">
              {buckets.map((b) => (
                <div key={b.label} className="flex flex-1 flex-col items-center gap-1">
                  <div className="flex h-[90px] w-full items-end">
                    <div
                      className="w-full rounded-t-lg accent-soft"
                      style={{ height: `${Math.max(4, ((Number(b.count) || 0) / maxBucket) * 90)}px` }}
                    />
                  </div>
                  <span className="text-[11px] ink-3">{b.label}</span>
                  <span className="text-[11px] font-semibold acc">{b.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

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

  const act = async (body: any, msg?: string): Promise<boolean> => {
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
    } catch (e: any) {
      setToast(e?.message || '操作失败');
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
    } catch (e: any) {
      setToast(e?.message || '保存失败');
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
    } catch (e: any) {
      setToast(e?.message || '删除失败');
    }
  };

  const changeImportance = async (id: number, importance: number) => {
    try {
      const r = await fetch('/api/memories', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, importance }),
      });
      if (!r.ok) throw new Error();
      await reload();
    } catch {
      setToast('重要度调整失败，请重试');
    }
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

      {data?.stats ? <MemoryStarMap stats={data.stats} /> : null}

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
                  onChange={(e) => setNewMem((s) => ({ ...s, importance: e.target.value === '' ? s.importance : Number(e.target.value) }))}
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
                if (!newMem.content.trim()) {
                  setToast('内容不能为空');
                  return;
                }
                const ok = await act(
                  { action: 'create', ...newMem, importance: clampImportance(newMem.importance) },
                  '记住了'
                );
                if (ok) {
                  setNewMem({ type: 'semantic', content: '', importance: 7, emotion: '' });
                  setCreating(false);
                }
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
          <span className="mx-1 h-4 w-px accent-soft" />
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
                  <span className="text-[11px] ink-3">
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
                  <p className="mt-2 text-sm leading-relaxed ink-1 break-words">{m.content}</p>
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
                  <ImportanceSlider value={m.importance} onChange={(v) => changeImportance(m.id, v)} />
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
                <div key={s.id} className="rounded-2xl accent-soft px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Chip tone="plain">{s.date}</Chip>
                    {s.meta ? <span className="text-[11px] ink-3">{safeParseMeta(s.meta).messages ?? 0} 条消息</span> : null}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed ink-2">{s.summary}</p>
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