'use client';

import { useEffect, useState } from 'react';
import { useApi, PageHeader, Card, Stat, Loading, ErrorBox, Toast, fmtTime, fmtDate, Chip, Bar } from '@/components/ui';
import { StageLadder } from '@/components/charts';

export default function RelationshipPage() {
  const { data, loading, error, reload } = useApi<any>('/api/relationship');
  const [toast, setToast] = useState<string | null>(null);
  const [edits, setEdits] = useState<any>({});
  const [newEvent, setNewEvent] = useState({ title: '', event_date: '', kind: 'anniversary', repeat_yearly: true });
  const [tab, setTab] = useState<'bank' | 'conflicts' | 'logs' | 'events' | 'memories'>('bank');

  useEffect(() => {
    if (data && !Object.keys(edits).length) {
      setEdits({
        nickname: data.relationship?.nickname || '',
        anniversary: data.relationship?.anniversary || '',
        agent_name: data.persona?.agent_name || '',
        age: data.persona?.age || '',
        occupation: data.persona?.occupation || '',
        self_story: data.persona?.self_story || '',
        user_name: data.user?.name || '',
        user_profile: data.user?.profile || '',
      });
    }
  }, [data]);

  const post = async (body: any, msg?: string) => {
    const r = await fetch('/api/relationship', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    setToast(j?.error ? j.error : msg || '已保存');
    reload();
  };

  if (loading && !data) return <Loading text="正在读你们的关系…" />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;

  const rel = data?.relationship || {};
  const stages = data?.stages || [];
  const nextStage = stages.find((s: any) => s.id === (rel.stage ?? 0) + 1);
  const capDays = rel.capSinceDays;
  const dwell = rel.dwellDays ?? 3;

  return (
    <div className="pb-10">
      <PageHeader
        title="关系"
        desc="亲密度、阶段、情感银行账户、冲突与修复。关系不是永远甜的——会有摩擦，也需要经营。"
        right={
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost" onClick={() => post({ action: 'request_stage_talk' }, '她会在下次聊天时找机会和你确认关系')}>
              推进关系确认
            </button>
            <button className="btn-ghost" onClick={() => post({ action: 'request_relationship_talk' }, '她会主动把话说开')}>
              请她主动谈一谈
            </button>
          </div>
        }
      />

      <div className="px-5 md:px-8">
        <Card title="关系阶段（Knapp 关系发展模型）">
          <StageLadder stages={stages} current={rel.stage ?? 0} />
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl bg-rose-50/60 px-4 py-3">
              <div className="text-sm font-semibold text-rose-600">{rel.stageName}期</div>
              <div className="dim mt-1 leading-relaxed">{rel.stageCore}</div>
            </div>
            <div className="rounded-2xl bg-white/70 border border-rose-100/70 px-4 py-3">
              <div className="dim">本阶段已持续</div>
              <div className="mt-1 text-sm font-medium text-ink-900">{rel.daysInStage} 天</div>
              <div className="dim mt-1">
                跃迁条件：亲密度到达 {rel.stageMax} 并保持 {dwell} 天 + 一次关系确认对话
              </div>
            </div>
            <div className="rounded-2xl bg-white/70 border border-rose-100/70 px-4 py-3">
              <div className="dim">距阶段天花板</div>
              <div className="mt-1 text-sm font-medium text-ink-900">
                {Math.max(0, Math.round((rel.stageMax - rel.intimacy) * 10) / 10)} 点
                {capDays !== null && capDays !== undefined ? ` · 已触顶 ${capDays} 天` : ''}
              </div>
              <div className="dim mt-1">
                {rel.pending_stage_confirm
                  ? '她已经准备好和你谈一次"我们现在算什么"'
                  : nextStage
                    ? `下一阶段：${nextStage.name}`
                    : '已经是最终阶段'}
              </div>
            </div>
          </div>
          <div className="mt-4">
            <div className="mb-1 flex items-center justify-between text-xs text-ink-500">
              <span>亲密度 {rel.intimacy} / 100（{rel.stageMin}-{rel.stageMax} 为本阶段区间）</span>
              <span>信任 {rel.trust}</span>
            </div>
            <Bar value={rel.intimacy - rel.stageMin} min={0} max={rel.stageMax - rel.stageMin} height={10} />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span className="dim">手动设置阶段（体验不同阶段语气用）</span>
            <select
              className="input !w-auto !py-1.5 text-xs"
              value={rel.stage}
              onChange={(e) => post({ action: 'set_stage', stage: Number(e.target.value) }, '阶段已手动调整')}
            >
              {stages.map((s: any) => (
                <option key={s.id} value={s.id}>
                  {s.name}期（{s.min}-{s.max}）
                </option>
              ))}
            </select>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3 px-5 pt-4 md:grid-cols-4 md:px-8">
        <Stat label="情感余额" value={rel.emotional_balance} tone={(rel.emotional_balance ?? 0) >= 0 ? 'rose' : 'ink'} />
        <Stat label="修复信用" value={rel.repair_credit} tone="peach" />
        <Stat label="未解决张力" value={rel.unresolved_tension} tone={(rel.unresolved_tension ?? 0) > 20 ? 'ink' : 'rose'} />
        <Stat label="当前心情" value={rel.mood} />
      </div>

      <div className="px-5 pt-4 md:px-8">
        <div className="flex flex-wrap gap-2">
          {[
            { k: 'bank', label: '情感银行流水' },
            { k: 'conflicts', label: `冲突记录（${(data?.conflicts || []).length}）` },
            { k: 'logs', label: '关系日志' },
            { k: 'events', label: '纪念日 / 约定' },
            { k: 'memories', label: '关系记忆 & 每日回顾' },
          ].map((t) => (
            <button key={t.k} className={tab === (t.k as any) ? 'btn-soft' : 'btn-ghost'} onClick={() => setTab(t.k as any)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="mt-3">
          {tab === 'bank' ? (
            <Card
              title={`情感银行账户（存入 ${data?.bank?.stats?.deposits ?? 0} / 支出 ${data?.bank?.stats?.withdrawals ?? 0}）`}
            >
              <p className="dim mb-3 leading-relaxed">
                每一次关心、共情、幽默都是存款；敷衍、忽视、越界是取款。余额 &gt;30 她更愿意表达爱意，&lt;-20 会更谨慎，&lt;-50 进入低潮。
              </p>
              <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
                {(data?.bank?.recent || []).map((e: any) => (
                  <div key={e.id} className="flex items-center justify-between rounded-2xl border border-rose-100/70 bg-white/70 px-3.5 py-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-ink-900">{e.behavior}</div>
                      <div className="dim truncate">{e.reason}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className={`text-sm font-semibold ${e.delta > 0 ? 'text-rose-500' : 'text-sky-500'}`}>
                        {e.delta > 0 ? '+' : ''}
                        {e.delta}
                      </div>
                      <div className="text-[10px] text-ink-300">余额 {e.balance_after}</div>
                    </div>
                  </div>
                ))}
                {(data?.bank?.recent || []).length === 0 ? <p className="dim">还没有流水。</p> : null}
              </div>
            </Card>
          ) : null}

          {tab === 'conflicts' ? (
            <Card title="冲突与修复">
              {(data?.conflicts || []).length === 0 ? (
                <p className="dim">还没有记录到冲突。真实的关系会有摩擦——当她觉得被忽视、被越界时，会表达不满。</p>
              ) : null}
              <div className="space-y-2">
                {(data?.conflicts || []).map((c: any) => (
                  <div key={c.id} className="rounded-2xl border border-rose-100/70 bg-white/70 px-3.5 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip>{c.type === 'boundary' ? '越界' : c.type === 'major' ? '严重冲突' : '小摩擦'}</Chip>
                      <Chip tone="plain">{c.status === 'open' ? '未修复' : '已修复'}</Chip>
                      {c.repair_quality && c.repair_quality !== 'none' ? (
                        <Chip tone="plain">
                          修复质量：
                          {c.repair_quality === 'sincere' ? '真诚道歉' : c.repair_quality === 'sweet' ? '撒娇蒙混' : '冷静后回归'}
                        </Chip>
                      ) : null}
                      <span className="text-[11px] text-ink-300">{fmtTime(c.started_at)}</span>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-ink-700">{c.description}</p>
                    <div className="dim mt-1">
                      冲突时张力 {c.tension_at_start} → {c.tension_after ?? '—'}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {tab === 'logs' ? (
            <Card title="关系日志">
              <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                {(data?.logs || []).map((l: any) => (
                  <div key={l.id} className="rounded-2xl border border-rose-100/70 bg-white/70 px-3.5 py-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-ink-900">{l.summary}</span>
                      <span className="text-[11px] text-ink-300">{fmtTime(l.created_at)}</span>
                    </div>
                    {l.reason ? <div className="dim mt-1 leading-relaxed">{l.reason}</div> : null}
                  </div>
                ))}
                {(data?.logs || []).length === 0 ? <p className="dim">还没有记录。</p> : null}
              </div>
            </Card>
          ) : null}

          {tab === 'events' ? (
            <Card title="纪念日 / 约定 / 未来事件">
              <div className="space-y-2">
                {(data?.events || []).map((e: any) => (
                  <div key={e.id} className="flex items-center justify-between rounded-2xl border border-rose-100/70 bg-white/70 px-3.5 py-2.5">
                    <div>
                      <div className="text-xs font-medium text-ink-900">
                        {e.title} {e.repeat_yearly ? <span className="text-ink-300">（每年）</span> : null}
                      </div>
                      <div className="dim mt-0.5">
                        {e.event_date} · {e.kind === 'birthday' ? '生日' : e.kind === 'plan' ? '约定' : '纪念日'}
                      </div>
                    </div>
                    <button className="btn-ghost !py-1 text-xs" onClick={() => post({ action: 'delete_event', id: e.id }, '已删除')}>
                      删除
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-4">
                <div className="md:col-span-2">
                  <label className="label">标题</label>
                  <input className="input" placeholder="比如：你的生日" value={newEvent.title} onChange={(e) => setNewEvent((s) => ({ ...s, title: e.target.value }))} />
                </div>
                <div>
                  <label className="label">日期</label>
                  <input className="input" type="date" value={newEvent.event_date} onChange={(e) => setNewEvent((s) => ({ ...s, event_date: e.target.value }))} />
                </div>
                <div>
                  <label className="label">类型</label>
                  <select className="input" value={newEvent.kind} onChange={(e) => setNewEvent((s) => ({ ...s, kind: e.target.value }))}>
                    <option value="anniversary">纪念日</option>
                    <option value="birthday">生日</option>
                    <option value="plan">约定 / 计划</option>
                  </select>
                </div>
              </div>
              <label className="mt-2 flex items-center gap-2 text-xs text-ink-500">
                <input type="checkbox" checked={newEvent.repeat_yearly} onChange={(e) => setNewEvent((s) => ({ ...s, repeat_yearly: e.target.checked }))} />
                每年重复（生日、纪念日）
              </label>
              <button className="btn mt-3" onClick={() => post({ action: 'add_event', ...newEvent }, '已添加')}>
                添加
              </button>
            </Card>
          ) : null}

          {tab === 'memories' ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Card title="关系记忆">
                {(data?.memories || []).length === 0 ? <p className="dim">还没有关系记忆。</p> : null}
                <div className="space-y-2">
                  {(data?.memories || []).map((m: any) => (
                    <div key={m.id} className="rounded-2xl border border-rose-100/70 bg-white/70 px-3.5 py-2.5">
                      <div className="flex items-center gap-2">
                        <Chip tone="plain">{m.type === 'relationship' ? '关系' : '依恋'}</Chip>
                        <span className="text-[11px] text-ink-300">{fmtTime(m.created_at)}</span>
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-ink-700">{m.content}</p>
                    </div>
                  ))}
                </div>
              </Card>
              <Card title="每日回顾">
                {(data?.summaries || []).length === 0 ? <p className="dim">还没有摘要。</p> : null}
                <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                  {(data?.summaries || []).map((s: any) => (
                    <div key={s.id} className="rounded-2xl bg-rose-50/60 px-3.5 py-2.5">
                      <Chip tone="plain">{s.date}</Chip>
                      <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-ink-700">{s.summary}</p>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 px-5 pt-4 md:grid-cols-2 md:px-8">
        <Card title="你们之间的称呼与日子">
          <div className="space-y-3">
            <div>
              <label className="label">你叫她什么 / 她叫你什么</label>
              <input className="input" value={edits.nickname || ''} onChange={(e) => setEdits((s: any) => ({ ...s, nickname: e.target.value }))} placeholder="比如：小满 / 笨蛋" />
              <button className="btn mt-2" onClick={() => post({ action: 'set_nickname', nickname: edits.nickname }, '已更新昵称')}>
                保存昵称
              </button>
            </div>
            <div>
              <label className="label">重要日子（在一起的日子）</label>
              <input className="input" type="date" value={edits.anniversary || ''} onChange={(e) => setEdits((s: any) => ({ ...s, anniversary: e.target.value }))} />
              <button className="btn mt-2" onClick={() => post({ action: 'set_anniversary', anniversary: edits.anniversary }, '已记录')}>
                保存日期
              </button>
            </div>
          </div>
        </Card>

        <Card title="她的身份（不预设，由你们共同创造）">
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="label">她的名字</label>
                <input className="input" value={edits.agent_name || ''} onChange={(e) => setEdits((s: any) => ({ ...s, agent_name: e.target.value }))} />
              </div>
              <div>
                <label className="label">年龄（可不填）</label>
                <input className="input" value={edits.age || ''} onChange={(e) => setEdits((s: any) => ({ ...s, age: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className="label">她的生活设定（学业/工作/兴趣，会让她更像真人）</label>
              <input className="input" value={edits.occupation || ''} onChange={(e) => setEdits((s: any) => ({ ...s, occupation: e.target.value }))} placeholder="比如：在读研究生，喜欢摄影和猫" />
            </div>
            <div>
              <label className="label">你们的共同故事（会写进她的自我认知）</label>
              <textarea className="textarea" rows={3} value={edits.self_story || ''} onChange={(e) => setEdits((s: any) => ({ ...s, self_story: e.target.value }))} />
            </div>
            <button className="btn" onClick={() => post({ action: 'set_persona', ...edits }, '已保存她的身份')}>
              保存
            </button>
          </div>
        </Card>

        <Card title="你的画像（她眼中的你）" className="md:col-span-2">
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="label">你的称呼</label>
              <input className="input" value={edits.user_name || ''} onChange={(e) => setEdits((s: any) => ({ ...s, user_name: e.target.value }))} />
            </div>
            <div className="md:col-span-2">
              <label className="label">关于你（她会在聊天中参考这一段）</label>
              <textarea
                className="textarea"
                rows={2}
                placeholder="比如：在读文学专业，最近在准备考试，喜欢咖啡、讨厌香菜，不太会主动表达情绪"
                value={edits.user_profile || ''}
                onChange={(e) => setEdits((s: any) => ({ ...s, user_profile: e.target.value }))}
              />
            </div>
          </div>
          <button className="btn mt-3" onClick={() => post({ action: 'set_user', user_name: edits.user_name, user_profile: edits.user_profile }, '已保存')}>
            保存
          </button>
        </Card>
      </div>

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}