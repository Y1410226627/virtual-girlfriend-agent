'use client';

import { useState } from 'react';
import { useApi, PageHeader, Card, Stat, Loading, ErrorBox, Toast, fmtTime, Chip } from '@/components/ui';
import { Gauge } from '@/components/charts';

const LEVELS = [
  { v: 0, label: '关闭', desc: '亲密表达只到日常程度：牵手、拥抱、亲额头、靠着、说想你。不展开性话题。' },
  { v: 1, label: '暧昧调情', desc: '可以调情、性暗示、暧昧玩笑、脸红心跳的靠近。气氛走深时会自然留白淡出。' },
  { v: 2, label: '亲密', desc: '可以更直接地表达欲望、亲吻与拥抱，以情感交流、相互回应和留白为主。' },
  { v: 3, label: '成人向', desc: '可以成熟、直白地讨论成年恋人的欲望、吸引力、亲密偏好和私密关系；内容保持非露骨。' },
];

export default function IntimacyPage() {
  const { data, loading, error, reload } = useApi<any>('/api/intimacy');
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newPref, setNewPref] = useState({ type: 'custom', content: '' });

  const post = async (body: any, msg?: string) => {
    setBusy(true);
    try {
      const r = await fetch('/api/intimacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `操作失败 ${r.status}`);
      if (msg) setToast(msg);
      await reload();
      return j;
    } catch (e: any) {
      setToast(e?.message || '操作失败');
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Loading text="正在读亲密状态…" />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;

  const s = data.state;
  const lv = data.level;

  return (
    <div className="pb-10">
      <PageHeader
        title="亲密"
        desc="亲密是关系里的一个维度，不是全部。它服从于关系阶段和你们当下的状态。"
      />

      <div className="grid gap-4 px-5 md:grid-cols-2 md:px-8">
        <Card title="当前状态">
          <div className="flex items-center justify-around">
            <Gauge value={s.libido} label="性欲" />
            <Gauge value={s.intimacyNeed} label="亲密需求" color="#FF8F6B" />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Stat label="性满意度" value={s.sexualSatisfaction} />
            <Stat label="性压力" value={s.sexualStress} tone="ink" />
          </div>
          {s.inAftercare ? (
            <div className="mt-3 rounded-2xl bg-rose-50/70 px-3.5 py-2.5 text-xs leading-relaxed text-ink-700">
              <b>她正处于事后状态</b>：{s.aftercareState}
              <div className="dim mt-1">到 {fmtTime(s.aftercareUntil)} 前后渐渐过去。这时候抱一下、说句话，比什么都重要。</div>
            </div>
          ) : null}
        </Card>

        <Card title="内容分级">
          <div className="space-y-2">
            {LEVELS.map((l) => (
              <button
                key={l.v}
                disabled={busy}
                aria-pressed={lv.level === l.v}
                onClick={() => post({ action: 'set_level', level: l.v }, `已设为「${l.label}」`)}
                className={`w-full rounded-2xl border px-3.5 py-2.5 text-left transition ${
                  lv.level === l.v ? 'border-rose-300 bg-rose-50/70' : 'border-rose-100/80 bg-white/70 hover:bg-rose-50/40'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-ink-900">
                    {l.v} · {l.label}
                  </span>
                  {lv.level === l.v ? <Chip>当前</Chip> : null}
                </div>
                <div className="dim mt-1 leading-relaxed">{l.desc}</div>
              </button>
            ))}
          </div>
          <p className="dim mt-2 leading-relaxed">
            实际生效仍受关系阶段影响。三级提升表达成熟度和私密话题范围，但不生成露骨内容。你现在设置的是 {lv.level} 级、阶段上限 {lv.stageMax} 级。
          </p>
        </Card>
      </div>

      <div className="px-5 pt-4 md:px-8">
        <Card title="她的偏好（会随关系变深逐渐透露）">
          <div className="space-y-2">
            {data.preferences.map((p: any) => (
              <div key={p.id} className="flex items-start justify-between gap-2 rounded-2xl border border-rose-100/70 bg-white/70 px-3.5 py-2.5">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-ink-700">{p.type}</div>
                  <div className="mt-0.5 text-xs leading-relaxed">
                    {p.revealed ? <span className="text-ink-900">{p.content}</span> : <span className="text-ink-300">她还没说过这件事</span>}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    className="btn-ghost !py-1 text-xs"
                    disabled={busy || p.revealed}
                    onClick={() => post({ action: 'reveal_preference', type: p.type }, '已设为"说过"')}
                  >
                    {p.revealed ? '已说过' : '设为已说'}
                  </button>
                  <button
                    className="btn-ghost !py-1 text-xs"
                    disabled={busy}
                    onClick={() => {
                      if (confirm('删除这条偏好？')) post({ action: 'delete_preference', id: p.id }, '已删除');
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-3">
            <input className="input" placeholder="类型（如 atmosphere）" value={newPref.type} onChange={(e) => setNewPref((x) => ({ ...x, type: e.target.value }))} />
            <input
              className="input md:col-span-2"
              placeholder="偏好内容，例如：喜欢慢慢来，别太急"
              value={newPref.content}
              onChange={(e) => setNewPref((x) => ({ ...x, content: e.target.value }))}
            />
          </div>
          <button
            className="btn mt-2"
            disabled={busy || !newPref.content.trim()}
            onClick={async () => {
              await post({ action: 'add_preference', ...newPref }, '已添加偏好');
              setNewPref({ type: 'custom', content: '' });
            }}
          >
            添加偏好
          </button>
        </Card>
      </div>

      <div className="px-5 pt-4 md:px-8">
        <Card title="事后关怀记录">
          {data.aftercare?.length ? (
            <div className="space-y-2">
              {data.aftercare.map((a: any) => (
                <div key={a.id} className="flex items-center justify-between rounded-2xl border border-rose-100/70 bg-white/70 px-3.5 py-2.5">
                  <div>
                    <div className="text-xs text-ink-900">{a.agent_state}</div>
                    <div className="dim mt-0.5">
                      {fmtTime(a.created_at)} · 关怀质量：
                      {a.aftercare_quality === 'good' ? '被好好照顾' : a.aftercare_quality === 'ignored' ? '被忽略' : '一般'}
                      {a.user_response ? ` · ${a.user_response}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="dim">还没有记录。事后关怀会影响她的性满意度、情感余额和安全感——被忽视是要付出代价的。</p>
          )}
        </Card>
      </div>

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}