'use client';

import { useEffect, useState } from 'react';
import { useApi, PageHeader, Card, Stat, Loading, ErrorBox, Toast, fmtTime, Chip, Bar } from '@/components/ui';

const TABS = [
  { k: 'now', label: '她现在' },
  { k: 'today', label: '她的一天' },
  { k: 'profile', label: '她的档案' },
  { k: 'shared', label: '共享世界' },
] as const;

const emoMap: Record<string, string> = {
  开心: '😊', 平静: '🙂', 低落: '😔', 烦躁: '😤', 想他: '🥺', 难受: '🤒', 疲惫: '😪', '': '🙂',
};

const ATTACHMENT_LABELS: Record<string, string> = {
  secure: '安全型', anxious: '焦虑型', avoidant: '回避型', fearful: '混乱型',
};

/** 时间线来源字段 → 展示前缀 */
const TIMELINE_PREFIX: Record<string, string> = {
  illness: '身体：', activity: '活动：', event: '事件：', manual: '手动：',
};

function timelineText(l: any): string {
  if (l?.field === 'daily_event') return String(l.new_value ?? '');
  if (l?.field === 'profile_reveal') return `揭开：${l.old_value || l.new_value || ''}`;
  const prefix = TIMELINE_PREFIX[l?.field];
  return prefix ? `${prefix}${l.new_value ?? ''}` : String(l?.new_value ?? '');
}

function weeklySnapshotSummary(raw: string): string {
  try {
    const state = JSON.parse(raw);
    const stage = ['初识', '试探', '加深', '融合', '承诺'][Number(state.relationship?.stage) || 0] || '初识';
    const energy = Math.round(Number(state.health?.energy) || 0);
    const place = state.location?.current_location || '位置未知';
    const style = state.attachment?.style;
    const attachment = style ? (ATTACHMENT_LABELS[style] || style) : '未记录';
    return `${stage}期 · 精力 ${energy} · ${place} · ${attachment}依恋`;
  } catch {
    return '状态快照';
  }
}

export default function WorldPage() {
  const { data, loading, error, reload } = useApi<any>('/api/life');
  const [tab, setTab] = useState<(typeof TABS)[number]['k']>('now');
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editProfile, setEditProfile] = useState(false);
  const [pf, setPf] = useState<Record<string, string>>({});
  const [newPlan, setNewPlan] = useState('');
  const [newRitual, setNewRitual] = useState('');
  const [newItem, setNewItem] = useState('');
  // 手动调整她此刻的身体/心理数值
  const [editStates, setEditStates] = useState(false);
  const [sv, setSv] = useState<Record<string, any>>({});
  const [showAllEvents, setShowAllEvents] = useState(false);

  const post = async (body: any, msg?: string) => {
    setBusy(true);
    try {
      const r = await fetch('/api/life', {
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

  // 已有数据时只在顶部轻提示，不整页替换
  useEffect(() => {
    if (error && data) setToast(error);
  }, [error, data]);

  if (loading && !data) return <Loading text="正在看她的生活…" />;
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />;

  const h = data.health;
  const p = data.psychology;
  const loc = data.location;
  const act = data.activity;

  return (
    <div className="pb-10">
      <PageHeader
        title="她的世界"
        desc="她不是只在聊天时才存在的人。你有你的事，她也有她的日子。"
        right={
          <button
            className="btn-ghost"
            disabled={busy}
            onClick={() => post({ action: 'simulate_hours', hours: 6 }, '时间往前推了 6 小时，看看她的变化')}
            title="把她的生活推进 6 小时（方便你立刻看到变化）"
          >
            推进 6 小时
          </button>
        }
      />

      <div className="px-5 md:px-8">
        <div className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button key={t.k} className={tab === t.k ? 'btn-soft' : 'btn-ghost'} onClick={() => setTab(t.k)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'now' ? (
        <div className="space-y-4 px-5 pt-4 md:px-8">
          <Card title="她现在在做什么">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-peach-100 to-rose-100 text-2xl">
                {emoMap[p.baseEmotion] || '🙂'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-base font-medium text-ink-900">{act.name}</div>
                <div className="dim mt-0.5">
                  📍 {loc.name}
                  {act.expectedEnd ? ` · 大约到 ${fmtTime(act.expectedEnd)} 结束` : ''}
                </div>
              </div>
              <Chip>{p.baseEmotion}</Chip>
              {h.illness !== 'none' ? <Chip tone="plain">🤒 {h.illness}中 · 第 {h.illnessDay} 天</Chip> : null}
            </div>
            {data.recently?.length ? (
              <div className="mt-3 rounded-2xl bg-rose-50/60 px-3.5 py-3">
                <div className="text-xs font-medium text-ink-700">最近这段时间她……</div>
                <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-ink-700">
                  {data.recently.map((r: string, i: number) => (
                    <li key={i}>· {r}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card
              title="身体"
              right={
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setSv(
                      editStates
                        ? {}
                        : {
                            energy: Math.round(h.energy),
                            sleep_quality: Math.round(h.sleepQuality),
                            hunger: Math.round(h.hunger),
                            exercise: Math.round(h.exercise),
                            stress: Math.round(p.stress),
                            loneliness: Math.round(p.loneliness),
                            missing_user: Math.round(p.missingUser),
                            security: Math.round(p.security),
                            self_worth: Math.round(p.selfWorth),
                            mental_energy: Math.round(p.mentalEnergy),
                            cycle_day: h.cycleDay,
                          }
                    );
                    setEditStates((v) => !v);
                  }}
                  title="直接设定她此刻的身体 / 心理数值"
                >
                  {editStates ? '收起调整' : '手动调整'}
                </button>
              }
            >
              <div className="space-y-3">
                {[
                  ['精力', h.energy, 'rose'],
                  ['睡眠', h.sleepQuality, 'rose'],
                  ['饥饿', h.hunger, 'peach'],
                  ['运动', h.exercise, 'peach'],
                ].map(([label, v, tone]: any) => (
                  <div key={label}>
                    <div className="mb-1 flex items-center justify-between text-xs text-ink-500">
                      <span>{label}</span>
                      <span>{Math.round(v)}</span>
                    </div>
                    <Bar value={v} tone={tone} height={6} />
                  </div>
                ))}
                {h.cycleEnabled ? <div className="dim">生理期第 {h.cycleDay} 天</div> : null}
              </div>
            </Card>
            <Card title="心理">
              <div className="grid grid-cols-2 gap-3">
                <Stat label="压力" value={p.stress} tone="ink" />
                <Stat label="孤独" value={p.loneliness} tone="ink" />
                <Stat label="想你" value={p.missingUser} />
                <Stat label="安全感" value={p.security} />
                <Stat label="自我价值" value={p.selfWorth} tone="peach" />
                <Stat label="心理能量" value={p.mentalEnergy} tone="peach" />
              </div>
            </Card>
          </div>

          {editStates ? (
            <Card title="手动调整她此刻的状态（立刻生效）">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {(
                  [
                    ['energy', '精力'],
                    ['sleep_quality', '睡眠'],
                    ['hunger', '饥饿'],
                    ['exercise', '运动'],
                    ['stress', '压力'],
                    ['loneliness', '孤独'],
                    ['missing_user', '想你'],
                    ['security', '安全感'],
                    ['self_worth', '自我价值'],
                    ['mental_energy', '心理能量'],
                  ] as const
                ).map(([k, label]) => (
                  <div key={k}>
                    <label className="label">{label} 0-100</label>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={100}
                      value={sv[k] ?? 0}
                      onChange={(e) => setSv((s) => ({ ...s, [k]: e.target.value }))}
                    />
                  </div>
                ))}
                {h.cycleEnabled ? (
                  <div>
                    <label className="label">生理期第几天</label>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={60}
                      value={sv.cycle_day ?? 1}
                      onChange={(e) => setSv((s) => ({ ...s, cycle_day: e.target.value }))}
                    />
                  </div>
                ) : null}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  className="btn"
                  disabled={busy}
                  onClick={async () => {
                    const num = (x: any, d = 0) => (isFinite(Number(x)) ? Number(x) : d);
                    await post(
                      {
                        action: 'set_states',
                        health: {
                          energy: num(sv.energy),
                          sleep_quality: num(sv.sleep_quality),
                          hunger: num(sv.hunger),
                          exercise: num(sv.exercise),
                          cycle_day: num(sv.cycle_day, h.cycleDay),
                        },
                        psychology: {
                          stress: num(sv.stress),
                          loneliness: num(sv.loneliness),
                          missing_user: num(sv.missing_user),
                          security: num(sv.security),
                          self_worth: num(sv.self_worth),
                          mental_energy: num(sv.mental_energy),
                        },
                      },
                      '数值已按你的设定更新'
                    );
                    setEditStates(false);
                  }}
                >
                  应用数值
                </button>
                <button className="btn-ghost" onClick={() => setEditStates(false)}>
                  取消
                </button>
                <span className="dim">设定的是"她此刻的状态"，之后仍会随时间和她做的事自然变化；聊天里她会按这个状态表现。</span>
              </div>
            </Card>
          ) : null}

          <Card title="测试用（想看她不同状态时的反应）">
            <div className="flex flex-wrap gap-2">
              <button className="btn-ghost" disabled={busy} onClick={() => post({ action: 'set_illness', kind: '感冒', days: 3 }, '她感冒了（3 天）')}>
                让她感冒
              </button>
              <button className="btn-ghost" disabled={busy} onClick={() => post({ action: 'set_illness', kind: 'none' }, '她恢复了')}>
                让她痊愈
              </button>
              <button className="btn-ghost" disabled={busy} onClick={() => post({ action: 'set_cycle', enabled: true, day: 2 }, '设为生理期第 2 天')}>
                设为生理期
              </button>
              <button className="btn-ghost" disabled={busy} onClick={() => post({ action: 'set_cycle', enabled: false }, '关闭生理周期')}>
                关闭生理周期
              </button>
            </div>
            <p className="dim mt-2">这些只是让你立刻看到不同状态下的她，平时她的状态由时间和你们相处自然推进。</p>
          </Card>
        </div>
      ) : null}

      {tab === 'today' ? (
        <div className="space-y-4 px-5 pt-4 md:px-8">
          <Card title="她的一天（时间线）">
            {data.timeline?.length ? (
              <div className="space-y-2">
                {data.timeline.map((l: any, i: number) => (
                  <div key={i} className="flex items-start gap-3 rounded-2xl border border-rose-100/70 bg-white/70 px-3.5 py-2.5">
                    <span className="mt-0.5 shrink-0 whitespace-nowrap text-[11px] text-ink-300">{fmtTime(l.created_at)}</span>
                    <div className="min-w-0">
                      <div className="text-xs text-ink-900">{timelineText(l)}</div>
                      {l.reason ? <div className="dim mt-0.5">{l.reason}</div> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="dim">今天还没有记录。她的作息会自动推进，过一会儿再来看看。</p>
            )}
          </Card>

          <Card title="生活日记（她自己经历的小事）">
            {data.events?.length ? (
              <div className="space-y-2">
                {(showAllEvents ? data.events : data.events.slice(0, 20)).map((e: any) => (
                  <div key={e.id} className="rounded-2xl bg-rose-50/60 px-3.5 py-2.5">
                    <div className="flex items-center gap-2">
                      <Chip tone="plain">{e.event_type}</Chip>
                      <span className="text-[11px] text-ink-300">{fmtTime(e.created_at)}</span>
                    </div>
                    <div className="mt-1 text-xs leading-relaxed text-ink-700">{e.content}</div>
                  </div>
                ))}
                {data.events.length > 20 ? (
                  <button className="btn-ghost w-full !py-1.5 text-xs" onClick={() => setShowAllEvents((v) => !v)}>
                    {showAllEvents ? '收起' : `展开全部（共 ${data.events.length} 条）`}
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="dim">还没有什么特别的事发生。</p>
            )}
          </Card>

          <Card title="每周生活快照">
            {data.weeklySnapshots?.length ? (
              <div className="space-y-2">
                {data.weeklySnapshots.map((snapshot: any) => (
                  <div key={snapshot.week} className="flex items-center justify-between gap-3 border-b border-rose-100/70 py-2 last:border-0">
                    <span className="text-xs font-medium text-ink-700">{snapshot.week}</span>
                    <span className="text-right text-xs text-ink-500">{weeklySnapshotSummary(snapshot.state_json)}</span>
                  </div>
                ))}
              </div>
            ) : <p className="dim">还没有周度记录。</p>}
          </Card>
        </div>
      ) : null}

      {tab === 'profile' ? (
        <div className="space-y-4 px-5 pt-4 md:px-8">
          <Card
            title={`她的档案（已告诉你的 ${data.profile.revealedCount} 项）`}
            right={
              <button className="btn-ghost" onClick={() => { setEditProfile((v) => !v); setPf({}); }}>
                {editProfile ? '收起' : '填写 / 修改'}
              </button>
            }
          >
            <div className="space-y-2">
              {data.profile.fields.map((f: any) => (
                <div key={f.field} className="flex items-start justify-between gap-3 rounded-2xl border border-rose-100/70 bg-white/70 px-3.5 py-2.5">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-ink-700">{f.label}</div>
                    <div className="mt-0.5 text-xs leading-relaxed">
                      {f.value ? (
                        f.revealed ? (
                          <span className="text-ink-900">{f.value}</span>
                        ) : (
                          <span className="text-ink-300">她还有些事没告诉你</span>
                        )
                      ) : (
                        <span className="text-ink-300">（还没设定）</span>
                      )}
                    </div>
                  </div>
                  {f.value ? (
                    <button
                      className="btn-ghost shrink-0 !py-1 text-xs"
                      disabled={busy}
                      onClick={() => post({ action: f.revealed ? 'hide_field' : 'reveal_field', field: f.field }, f.revealed ? '已设为"未告诉"' : '已设为"已经知道"')}
                    >
                      {f.revealed ? '设为未说' : '设为已说'}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            <p className="dim mt-3 leading-relaxed">
              没告诉你的信息，她不会说出口——但会在关系变深时自然透露（融合期可以说脆弱，承诺期才会说小秘密）。
              你在这里把内容填上，她就会按这个设定生活。
            </p>

            {editProfile ? (
              <div className="mt-4 rounded-2xl border border-rose-100 bg-white/70 p-3.5">
                <div className="grid gap-2.5 md:grid-cols-2">
                  {data.profile.fields.map((f: any) => (
                    <div key={f.field}>
                      <label className="label">{f.label}</label>
                      <input
                        className="input"
                        defaultValue={f.value}
                        placeholder={`她的${f.label}`}
                        onChange={(e) => setPf((s) => ({ ...s, [f.field]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
                <button
                  className="btn mt-3"
                  disabled={busy}
                  onClick={() => post({ action: 'set_profile', ...pf }, '已更新她的设定')}
                >
                  保存她的设定
                </button>
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}

      {tab === 'shared' ? (
        <div className="grid gap-4 px-5 pt-4 md:grid-cols-2 md:px-8">
          <Card title="共同计划">
            {data.shared.plans?.length ? (
              <div className="space-y-2">
                {data.shared.plans.map((pl: any, i: number) => (
                  <div key={i} className="flex items-center justify-between gap-2 rounded-2xl border border-rose-100/70 bg-white/70 px-3.5 py-2.5">
                    <div className="min-w-0">
                      <div className={`text-xs ${pl.status === 'done' ? 'text-ink-300 line-through' : 'text-ink-900'}`}>{pl.content || pl.title}</div>
                      <div className="dim mt-0.5">{pl.status === 'done' ? '已完成' : '计划中'} · {fmtTime(pl.created_at)}</div>
                    </div>
                    <button className="btn-ghost shrink-0 !py-1 text-xs" disabled={busy} onClick={() => post({ action: 'toggle_plan', index: i }, '已更新')}>
                      {pl.status === 'done' ? '标为未完成' : '完成'}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="dim">还没有约定。聊天里说到"我们一起去……"就会自动记下来。</p>
            )}
            <div className="mt-3 flex gap-2">
              <input className="input" placeholder="新增约定，例如：周末一起看那部剧" value={newPlan} onChange={(e) => setNewPlan(e.target.value)} />
              <button className="btn" disabled={busy || !newPlan.trim()} onClick={async () => { await post({ action: 'add_plan', content: newPlan }, '已记下约定'); setNewPlan(''); }}>
                添加
              </button>
            </div>
          </Card>

          <Card title="共同仪式">
            {data.shared.rituals?.length ? (
              <div className="space-y-2">
                {data.shared.rituals.map((r: any, i: number) => (
                  <div key={i} className="rounded-2xl border border-rose-100/70 bg-white/70 px-3.5 py-2.5">
                    <div className="text-xs text-ink-900">{r.content || r.title}</div>
                    <div className="dim mt-0.5">{fmtTime(r.created_at)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="dim">还没有固定仪式。比如"每天睡前互道晚安"，加上它，到点她会自然来找你。</p>
            )}
            <div className="mt-3 flex gap-2">
              <input className="input" placeholder="新增仪式，例如：每天睡前互道晚安" value={newRitual} onChange={(e) => setNewRitual(e.target.value)} />
              <button className="btn" disabled={busy || !newRitual.trim()} onClick={async () => { await post({ action: 'add_ritual', content: newRitual }, '已记下仪式'); setNewRitual(''); }}>
                添加
              </button>
            </div>
          </Card>

          <Card title="共同地点" className="md:col-span-2">
            {data.shared.places?.length ? (
              <div className="flex flex-wrap gap-2">
                {data.shared.places.map((pl: any, i: number) => (
                  <Chip key={i} tone="plain">📍 {pl.content || pl.title}</Chip>
                ))}
              </div>
            ) : (
              <p className="dim">还没有共同去过的地方。</p>
            )}
          </Card>

          <Card title="共同物品与回忆" className="md:col-span-2">
            {data.shared.items?.length ? (
              <div className="space-y-2">
                {data.shared.items.map((item: any, i: number) => (
                  <div key={i} className="flex items-center justify-between gap-3 border-b border-rose-100/70 py-2 last:border-0">
                    <span className="text-xs text-ink-800">{item.content || item.title}</span>
                    <span className="shrink-0 text-[11px] text-ink-300">{fmtTime(item.created_at)}</span>
                  </div>
                ))}
              </div>
            ) : <p className="dim">一起珍藏的歌、电影或小物件会留在这里。</p>}
            <div className="mt-3 flex gap-2">
              <input className="input" placeholder="例如：我们的歌" value={newItem} onChange={(e) => setNewItem(e.target.value)} />
              <button className="btn" disabled={busy || !newItem.trim()} onClick={async () => { await post({ action: 'add_item', content: newItem }, '已加入共享世界'); setNewItem(''); }}>添加</button>
            </div>
          </Card>
        </div>
      ) : null}

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}