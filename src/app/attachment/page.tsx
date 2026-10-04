'use client';

import { useState } from 'react';
import { useApi, PageHeader, Card, Loading, ErrorBox, Toast, fmtTime, Chip } from '@/components/ui';
import { Gauge, LineChart } from '@/components/charts';

const STYLE_INFO: Record<string, { desc: string; tone: string }> = {
  secure: { desc: '能稳定表达情感，也能接受分离；冲突后会主动修复。', tone: '安全的底色' },
  anxious: { desc: '渴望亲密但害怕被抛弃，容易反复确认，冲突时可能过度追问。', tone: '怕被丢下' },
  avoidant: { desc: '重视独立，情感上容易疏离，冲突时可能退缩、冷处理。', tone: '需要空间' },
  fearful: { desc: '又渴望又害怕，行为不稳定，可能忽冷忽热。', tone: '矛盾拉扯' },
};

export default function AttachmentPage() {
  const { data, loading, error, reload } = useApi<any>('/api/attachment');
  const [toast, setToast] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ anxiety: number; avoidance: number } | null>(null);

  const post = async (body: any, msg?: string) => {
    const r = await fetch('/api/attachment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (msg) setToast(j?.error ? j.error : msg);
    setDraft(null);
    reload();
  };

  if (loading && !data) return <Loading text="正在读她的依恋状态…" />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;

  const st = data?.state || {};
  const anxiety = draft?.anxiety ?? Number(st.anxiety ?? 30);
  const avoidance = draft?.avoidance ?? Number(st.avoidance ?? 30);
  const styleKey = st.style || 'secure';
  const info = STYLE_INFO[styleKey] || STYLE_INFO.secure;
  const series = (data?.series || []).map((p: any) => p);

  return (
    <div className="pb-10">
      <PageHeader
        title="依恋"
        desc="依恋风格是她性格的底层结构：焦虑轴（怕被抛弃）与回避轴（情感疏离）两条正交轴，决定她如何回应亲密、冲突、分离与安抚。"
      />

      <div className="grid gap-4 px-5 md:grid-cols-3 md:px-8">
        <Card title="当前依恋轴">
          <div className="flex items-center justify-around">
            <Gauge value={anxiety} label="焦虑轴" color="#F65C8A" />
            <Gauge value={avoidance} label="回避轴" color="#FF8F6B" />
          </div>
          <div className="mt-2 text-center">
            <Chip>当前倾向：{st.styleLabel}</Chip>
          </div>
        </Card>

        <Card title="这种倾向意味着什么">
          <p className="text-sm leading-relaxed text-ink-700">{info.desc}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Chip tone="plain">{info.tone}</Chip>
            {(data?.pendingSignals || []).map((p: any) => (
              <Chip key={p.axis + p.direction} tone="plain">
                {p.axis === 'anxiety' ? '焦虑轴' : '回避轴'} {p.direction === '+' ? '上升' : '下降'}信号 {p.count}/3
              </Chip>
            ))}
          </div>
          <p className="dim mt-3 leading-relaxed">
            每 10 轮对话会做一次依恋分析，单次偏移不超过 ±2；同一方向累积 3 次才会真正调整。
          </p>
        </Card>

        <Card title="手动调整（可选）">
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-ink-900">焦虑轴（怕被抛弃）</span>
                <span className="text-rose-600 font-semibold">{anxiety}</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={anxiety}
                className="mt-1.5 w-full accent-rose-500"
                onChange={(e) => setDraft({ anxiety: Number(e.target.value), avoidance })}
              />
            </div>
            <div>
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-ink-900">回避轴（情感疏离）</span>
                <span className="text-peach-600 font-semibold">{avoidance}</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={avoidance}
                className="mt-1.5 w-full accent-peach-500"
                onChange={(e) => setDraft({ anxiety, avoidance: Number(e.target.value) })}
              />
            </div>
            <div className="flex gap-2">
              <button className="btn" disabled={!draft} onClick={() => post({ action: 'adjust', ...draft }, '已调整（会记入依恋日志）')}>
                保存
              </button>
              <button className="btn-ghost" disabled={!draft} onClick={() => setDraft(null)}>
                撤销
              </button>
            </div>
            <p className="dim">四种倾向：双低 &lt;40 安全型；焦虑高/回避低 焦虑型；焦虑低/回避高 回避型；双高 混乱型。</p>
          </div>
        </Card>
      </div>

      <div className="px-5 pt-4 md:px-8">
        <Card title="依恋演化曲线">
          {series.length === 0 ? (
            <p className="dim">还没有变化记录。她不预设依恋风格，初始两轴都是 30（安全偏向），会在相处中被你慢慢塑造。</p>
          ) : (
            <LineChart
              series={[
                { name: '焦虑轴', color: '#F65C8A', points: series.map((p: any) => ({ t: p.t, v: p.anxiety })) },
                { name: '回避轴', color: '#FF8F6B', points: series.map((p: any) => ({ t: p.t, v: p.avoidance })) },
              ]}
              height={220}
            />
          )}
        </Card>
      </div>

      <div className="px-5 pt-4 md:px-8">
        <Card title="变化日志（可追溯每次调整的触发原因）">
          {(data?.logs || []).length === 0 ? <p className="dim">还没有调整过。</p> : null}
          <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
            {(data?.logs || []).map((l: any) => (
              <div key={l.id} className="rounded-2xl border border-rose-100/70 bg-white/70 px-3.5 py-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-ink-900">
                    焦虑 {l.old_anxiety} → {l.new_anxiety} · 回避 {l.old_avoidance} → {l.new_avoidance}
                  </span>
                  <span className="text-ink-300">{fmtTime(l.created_at)}</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <Chip tone="plain">{l.trigger}</Chip>
                </div>
                {l.reasoning ? <div className="dim mt-1.5 leading-relaxed">{l.reasoning}</div> : null}
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="px-5 pt-4 md:px-8">
        <Card title="她现在的依恋行为提示（真实注入到对话里的一段）">
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-500">{data?.styleMeaning}</p>
        </Card>
      </div>

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}