'use client';

import { useEffect, useRef, useState } from 'react';
import { useApi, PageHeader, Card, Loading, ErrorBox, Toast, fmtTime, Chip, Bar } from '@/components/ui';
import { RadarChart, LineChart } from '@/components/charts';
import { STAGES } from '@/lib/stages';

const COLORS = ['#F65C8A', '#FF8F6B', '#C084FC', '#38BDF8', '#34D399', '#FBBF24'];

/** 安全解析 JSON（脏数据兜底为空对象） */
function safeParse(raw: any): Record<string, any> {
  try {
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** 维度滑杆：拖动只改本地值，松手/失焦才提交一次 */
function SliderRow({ value, label, onCommit }: { value: number; label: string; onCommit: (v: number) => void }) {
  const [local, setLocal] = useState(value);
  const committed = useRef(value);
  useEffect(() => {
    setLocal(value);
    committed.current = value;
  }, [value]);
  const commit = () => {
    if (local !== committed.current) {
      committed.current = local;
      onCommit(local);
    }
  };
  return (
    <input
      type="range"
      min={0}
      max={100}
      value={local}
      aria-label={label}
      className="w-full accent-rose-500"
      onChange={(e) => setLocal(Number(e.target.value))}
      onMouseUp={commit}
      onPointerUp={commit}
      onBlur={commit}
    />
  );
}

export default function PersonalityPage() {
  const { data, loading, error, reload } = useApi<any>('/api/personality');
  const [toast, setToast] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const post = async (body: any, msg?: string) => {
    setSaving(true);
    try {
      const r = await fetch('/api/personality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `操作失败 ${r.status}`);
      if (msg) setToast(msg);
      await reload();
    } catch (e: any) {
      setToast(e?.message || '操作失败');
    } finally {
      setSaving(false);
    }
  };

  const adjust = async (key: string, value: number) => {
    try {
      const r = await fetch('/api/personality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'adjust', dimension: key, value }),
      });
      if (!r.ok) throw new Error();
      await reload();
    } catch {
      setToast('调整失败，请重试');
    }
  };

  if (loading && !data) return <Loading text="正在读她的性格…" />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;

  const state = data?.state || [];
  const radar = state.map((s: any) => ({ label: s.label.replace('/', '/\n'), value: s.value }));
  const series = data?.series || {};
  const focusKeys = focus ? [focus] : state.map((s: any) => s.key);
  const chartSeries = focusKeys
    .map((k: string, i: number) => {
      const item = state.find((s: any) => s.key === k);
      return {
        name: item?.label || k,
        color: COLORS[state.findIndex((s: any) => s.key === k) % COLORS.length],
        points: (series[k] || []).map((p: any) => ({ t: p.t, v: p.v })),
      };
    })
    .filter((s: any) => s.points.length > 0);

  return (
    <div className="pb-10">
      <PageHeader
        title="性格"
        desc="她的性格不是一开始就定死的。只有同一方向的信号在不同情境下反复出现，才会带来 ±1 的微调；连续 15 次同向确认后进入半固化。"
        right={
          <button className="btn-ghost" onClick={() => post({ action: 'snapshot' }, '已保存本周性格快照')} disabled={saving}>
            存快照
          </button>
        }
      />

      <div className="grid gap-4 px-5 md:grid-cols-2 md:px-8">
        <Card title="性格雷达">
          <RadarChart data={radar} size={280} />
          <p className="dim mt-2 text-center">数值会随相处缓慢变化，波动幅度很小</p>
        </Card>

        <Card title="累积层状态（正在收集的信号）">
          <p className="dim mb-3 leading-relaxed">
            每条对话只会产生"信号"。同一方向信号需 ≥5 次、且来自 ≥3 个不同情境、平均强度 &gt;0.5，才会触发一次 ±1 的调整。
          </p>
          <div className="space-y-2.5 max-h-[320px] overflow-y-auto pr-1">
            {(data?.signals || [])
              .filter((s: any) => s.weightedCount > 0)
              .sort((a: any, b: any) => b.weightedCount - a.weightedCount)
              .map((s: any) => (
                <div key={s.dimension + s.direction} className="rounded-2xl border line surf px-3.5 py-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium ink-1">
                      {s.label} <span className={s.direction === '+' ? 'acc' : 'text-sky-500'}>{s.direction === '+' ? '增强 ↗' : '减弱 ↘'}</span>
                    </span>
                    <span className="ink-3">
                      {s.weightedCount}/{s.thresholdCount} 信号 · {s.contexts}/{s.thresholdContexts} 情境
                    </span>
                  </div>
                  <div className="mt-1.5">
                    <Bar
                      value={Math.min(s.weightedCount / s.thresholdCount, 1) * 100}
                      height={6}
                      tone={s.direction === '+' ? 'rose' : 'peach'}
                    />
                  </div>
                  <div className="mt-1 text-[11px] ink-3">
                    平均强度 {s.avgStrength}
                    {s.ready
                      ? ' · 已达阈值，下一轮会调整'
                      : s.weightedCount >= s.thresholdCount &&
                          s.contexts >= s.thresholdContexts &&
                          s.avgStrength >= 0.5 &&
                          s.cooldownTurns > 0
                        ? ` · 已达阈值，冷却中（剩 ${s.cooldownTurns} 轮）`
                        : ''}
                  </div>
                </div>
              ))}
            {(data?.signals || []).filter((s: any) => s.weightedCount > 0).length === 0 ? (
              <p className="dim">还没有累积中的信号，多聊聊看。</p>
            ) : null}
          </div>
        </Card>
      </div>

      <div className="px-5 pt-4 md:px-8">
        <Card
          title="六个维度（可手动微调）"
          right={<span className="dim">{saving ? '保存中…' : ''}</span>}
        >
          <div className="grid gap-3 md:grid-cols-2">
            {state.map((s: any, i: number) => (
              <div key={s.key} className="rounded-2xl border line surf px-4 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium ink-1">{s.label}</span>
                      {s.solidified ? <Chip>已半固化</Chip> : null}
                    </div>
                    <div className="dim mt-0.5">{s.desc}</div>
                  </div>
                  <div className="text-lg font-semibold" style={{ color: COLORS[i % COLORS.length] }}>
                    {s.value}
                  </div>
                </div>
                <div className="mt-2.5">
                  <SliderRow value={s.value} label={s.label} onCommit={(v) => adjust(s.key, v)} />
                </div>
                {s.solidified ? (
                  <button className="btn-ghost mt-2 !py-1 text-xs" onClick={() => post({ action: 'unsolidify', dimension: s.key }, '已解除固化')}>
                    解除固化
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="px-5 pt-4 md:px-8">
        <Card
          title="演化曲线"
          right={
            <select className="input !w-auto !py-1.5 text-xs" value={focus || ''} onChange={(e) => setFocus(e.target.value || null)}>
              <option value="">全部维度</option>
              {state.map((s: any) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          }
        >
          <LineChart series={chartSeries} height={220} />
        </Card>
      </div>

      <div className="grid gap-4 px-5 pt-4 md:grid-cols-2 md:px-8">
        <Card title="演化日志">
          <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
            {(data?.logs || []).length === 0 ? <p className="dim">还没有发生过性格调整。</p> : null}
            {(data?.logs || []).map((l: any) => (
              <div key={l.id} className="rounded-2xl border line surf px-3.5 py-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium ink-1">
                    {state.find((s: any) => s.key === l.dimension)?.label || l.dimension}
                    <span className={l.delta >= 0 ? ' acc' : ' text-sky-500'}>
                      {' '}{l.old_value} → {l.new_value}
                    </span>
                  </span>
                  <span className="ink-3">{fmtTime(l.created_at)}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Chip tone="plain">
                    {l.layer === 'confirm' ? '确认层' : l.layer === 'solidify' ? '固化层' : l.layer === 'manual' ? '手动' : '回滚'}
                  </Chip>
                  {l.stage_at_time !== null ? <Chip tone="plain">当时阶段：{STAGES[l.stage_at_time]?.name ?? String(l.stage_at_time)}</Chip> : null}
                </div>
                {l.signal_context ? <div className="dim mt-1.5 leading-relaxed">信号情境：{l.signal_context}</div> : null}
                {l.reasoning ? <div className="dim mt-1 leading-relaxed">{l.reasoning}</div> : null}
              </div>
            ))}
          </div>
        </Card>

        <Card title="每周快照（可回滚）">
          {(data?.snapshots || []).length === 0 ? <p className="dim">还没有快照。</p> : null}
          <div className="space-y-2">
            {(data?.snapshots || []).map((s: any) => (
              <div key={s.id} className="flex items-center justify-between rounded-2xl border line surf px-3.5 py-2.5">
                <div>
                  <div className="text-xs font-medium ink-1">{s.week}</div>
                  <div className="dim mt-0.5">
                    {Object.entries(safeParse(s.values_json))
                      .map(([k, v]) => `${state.find((x: any) => x.key === k)?.label || k} ${v}`)
                      .join(' · ')}
                  </div>
                </div>
                <button className="btn-ghost !py-1 text-xs" onClick={() => post({ action: 'rollback', snapshotId: s.id }, `已回滚到 ${s.week}`)}>
                  回滚
                </button>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}