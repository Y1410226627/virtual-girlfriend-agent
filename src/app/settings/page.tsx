'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useApi, PageHeader, Card, Loading, ErrorBox, Toast, Chip } from '@/components/ui';

export default function SettingsPage() {
  const { data, loading, error, reload } = useApi<any>('/api/settings');
  const [form, setForm] = useState<Record<string, any>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [ping, setPing] = useState<any>(null);
  const [pinging, setPinging] = useState(false);
  const [saving, setSaving] = useState(false);
  // 用户改过表单后，后台 reload 不要覆盖他还没保存的编辑
  const dirtyRef = useRef(false);
  const [pf, setPf] = useState<any>({ label: '', base_url: '', api_key: '', chat_model: '', analysis_model: '', note: '' });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, any>>({});
  // 自定义模式（数值直控）
  const [cv, setCv] = useState<any>(null);

  const loadCv = async () => {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const j = await r.json();
      setCv({
        intimacy: j?.relationship?.intimacy ?? 0,
        trust: j?.relationship?.trust ?? 0,
        emotional_balance: j?.relationship?.emotional_balance ?? 0,
        unresolved_tension: j?.relationship?.unresolved_tension ?? 0,
        repair_credit: j?.relationship?.repair_credit ?? 0,
        mood: j?.relationship?.mood ?? '',
        stage: Number(j?.relationship?.stage ?? 0),
        personality: { ...(j?.personality?.values || {}) },
        anxiety: j?.attachment?.anxiety ?? 30,
        avoidance: j?.attachment?.avoidance ?? 30,
        libido: j?.intimacy?.libido ?? 0,
        intimacy_need: j?.intimacy?.need ?? 0,
        sexual_satisfaction: j?.intimacy?.satisfaction ?? 0,
        sexual_stress: j?.intimacy?.stress ?? 0,
      });
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (data?.settings && !dirtyRef.current) {
      const f: Record<string, any> = { ...data.settings };
      // 名字/共同故事以 personas 为准（settings 里那份是历史镜像，可能恒为空 → 否则"保存"会把名字抹掉）
      if (data.persona?.agent_name) f.agent_name = data.persona.agent_name;
      if (data.persona?.self_story) f.agent_story = data.persona.self_story;
      setForm(f);
    }
  }, [data]);

  useEffect(() => {
    void loadCv();
  }, []);

  const set = (k: string, v: any) => {
    dirtyRef.current = true;
    setForm((s) => ({ ...s, [k]: v }));
  };

  const save = async (keys?: string[], msg = '已保存') => {
    setSaving(true);
    const payload: Record<string, any> = {};
    (keys || Object.keys(form)).forEach((k) => (payload[k] = form[k]));
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: payload }),
      });
      if (!r.ok) throw new Error(`保存失败 ${r.status}`);
      const j = await r.json().catch(() => ({}));
      setToast(j?.error ? j.error : msg);
      dirtyRef.current = false;
      reload();
    } catch (e: any) {
      setToast(`保存失败：${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  const runPing = async () => {
    setPinging(true);
    setPing(null);
    try {
      const r = await fetch('/api/ping');
      setPing(await r.json());
    } catch (e: any) {
      setToast(`自检失败：${e?.message}`);
    } finally {
      setPinging(false);
    }
  };

  const profilePost = async (body: any) => {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    reload();
    return j;
  };

  const testProfile = async (id: number) => {
    setTesting(id);
    setTestResults((s) => ({ ...s, [id]: { pending: true } }));
    const j = await profilePost({ action: 'test_profile', id, timeoutMs: 15000 });
    setTestResults((s) => ({ ...s, [id]: j.result }));
    setTesting(null);
  };

  const download = async () => {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'export' }),
    });
    const j = await r.json();
    const blob = new Blob([JSON.stringify(j.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `虚拟女友-数据导出-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setToast('已导出为 JSON 文件');
  };

  const reset = async (keepSettings: boolean) => {
    const tip = keepSettings
      ? '确定清空所有聊天记录、记忆、性格、依恋与关系数据吗？（设置会保留）'
      : '确定恢复到出厂状态吗？设置也会被清空。';
    if (!confirm(tip)) return;
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset', keepSettings, confirm: 'RESET' }),
    });
    const j = await r.json();
    setToast(j?.message || '已重置');
    reload();
  };

  if (loading && !data) return <Loading text="正在读设置…" />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;

  const eff = data?.effective || {};
  // 自定义模式开关：'1' 和 'true' 都算开启（历史数据可能存成 true）
  const customOn = form.custom_mode === '1' || form.custom_mode === 'true';

  return (
    <div className="pb-10">
      <PageHeader title="设置" desc="模型、身份、主动消息、隐私。所有数据都存在你自己电脑上。" />

      <div className="space-y-4 px-5 md:px-8">
        <Card
          title="模型档案（随时切换，立即生效）"
          right={
            <button className="btn-ghost" onClick={runPing} disabled={pinging}>
              {pinging ? '自检中…' : '连接自检'}
            </button>
          }
        >
          <div className="space-y-2">
            {(data?.profiles || []).map((p: any) => {
              const h = data?.health?.[`chat|${(p.base_url || '').replace(/\/+$/, '')}|${p.chat_model}`];
              const tr = testResults[p.id];
              return (
                <div
                  key={p.id}
                  className={`rounded-2xl border px-3.5 py-3 ${
                    p.is_default ? 'border-rose-300 bg-rose-50/70' : 'border-rose-100/80 bg-white/70'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink-900">{p.label}</span>
                    {p.is_default ? <Chip>当前使用</Chip> : null}
                    {h?.cooling ? <Chip tone="plain">冷却中 {h.cooldownLeftSec}s</Chip> : null}
                    <span className="text-[11px] text-ink-300">
                      {p.chat_model} · {p.base_url}
                    </span>
                  </div>
                  {p.note ? <div className="dim mt-1">{p.note}</div> : null}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {!p.is_default ? (
                      <button
                        className="btn !py-1.5 text-xs"
                        onClick={async () => setToast((await profilePost({ action: 'apply_profile', id: p.id })).message)}
                      >
                        设为当前
                      </button>
                    ) : null}
                    <button className="btn-ghost !py-1.5 text-xs" onClick={() => testProfile(p.id)} disabled={testing === p.id}>
                      {testing === p.id ? '测试中…' : '测试'}
                    </button>
                    <button
                      className="btn-ghost !py-1.5 text-xs"
                      onClick={() => {
                        setEditingId(p.id);
                        setPf({ ...p });
                      }}
                    >
                      编辑
                    </button>
                    {!p.is_default ? (
                      <>
                        <button className="btn-ghost !px-2 !py-1.5 text-xs" title="备用顺序上移" onClick={() => profilePost({ action: 'move_profile', id: p.id, dir: -1 })}>
                          ↑
                        </button>
                        <button className="btn-ghost !px-2 !py-1.5 text-xs" title="备用顺序下移" onClick={() => profilePost({ action: 'move_profile', id: p.id, dir: 1 })}>
                          ↓
                        </button>
                      </>
                    ) : null}
                    <button
                      className="btn-ghost !py-1.5 text-xs"
                      onClick={async () => {
                        if (!confirm(`删除档案「${p.label}」？`)) return;
                        const j = await profilePost({ action: 'delete_profile', id: p.id });
                        setToast(j.ok ? '已删除' : '删除失败');
                      }}
                    >
                      删除
                    </button>
                    {tr ? (
                      <span className="text-[11px]">
                        {tr.pending ? (
                          '…'
                        ) : tr.ok ? (
                          <span className="text-rose-600">✅ {tr.ms}ms「{tr.reply}」</span>
                        ) : (
                          <span className="text-sky-600">❌ {String(tr.error).slice(0, 60)}</span>
                        )}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 rounded-2xl border border-rose-100 bg-white/70 p-3.5">
            <div className="mb-2 text-xs font-medium text-ink-700">{editingId ? '编辑档案' : '新增档案'}</div>
            <div className="grid gap-2.5 md:grid-cols-2">
              <input className="input" placeholder="档案名称（如 智谱 GLM-4.7-Flash）" value={pf.label || ''} onChange={(e) => setPf({ ...pf, label: e.target.value })} />
              <input className="input" placeholder="接口地址 Base URL" value={pf.base_url || ''} onChange={(e) => setPf({ ...pf, base_url: e.target.value })} />
              <input className="input" placeholder="API Key" value={pf.api_key || ''} onChange={(e) => setPf({ ...pf, api_key: e.target.value })} />
              <input className="input" placeholder="聊天模型名" value={pf.chat_model || ''} onChange={(e) => setPf({ ...pf, chat_model: e.target.value })} />
              <input className="input" placeholder="分析模型名（留空同聊天模型）" value={pf.analysis_model || ''} onChange={(e) => setPf({ ...pf, analysis_model: e.target.value })} />
              <input className="input" placeholder="备注（可选）" value={pf.note || ''} onChange={(e) => setPf({ ...pf, note: e.target.value })} />
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button
                className="btn"
                onClick={async () => {
                  const j = await profilePost({ action: editingId ? 'update_profile' : 'save_profile', id: editingId, ...pf });
                  if (j.error) {
                    setToast(j.error);
                    return;
                  }
                  setToast(editingId ? '已保存' : '已新增档案');
                  setEditingId(null);
                  setPf({ label: '', base_url: '', api_key: '', chat_model: '', analysis_model: '', note: '' });
                }}
              >
                {editingId ? '保存修改' : '新增'}
              </button>
              <button
                className="btn-ghost"
                onClick={async () => {
                  const j = await profilePost({ action: 'save_current', label: `当前配置 ${new Date().toLocaleDateString('zh-CN')}` });
                  setToast(j.error ? j.error : '已把当前设置存成新档案');
                }}
              >
                把当前设置存为新档案
              </button>
              {editingId ? (
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setEditingId(null);
                    setPf({ label: '', base_url: '', api_key: '', chat_model: '', analysis_model: '', note: '' });
                  }}
                >
                  取消编辑
                </button>
              ) : null}
            </div>
            <p className="dim mt-2 leading-relaxed">
              当前模型报错 / 限流 / 超时（首字 12 秒无响应）时，会自动按备用顺序切到下一个模型，聊天不会中断；失败的模型进冷却后自动恢复。点 ↑↓ 调整备用顺序。
            </p>
          </div>
        </Card>

        <Card title="高级：手动填写接口参数">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="label">接口地址 Base URL</label>
              <input className="input" value={form.llm_base_url ?? ''} onChange={(e) => set('llm_base_url', e.target.value)} placeholder="https://api.example.com/v1" />
            </div>
            <div>
              <label className="label">API Key</label>
              <input className="input" type="password" value={form.llm_api_key ?? ''} onChange={(e) => set('llm_api_key', e.target.value)} placeholder="留空则使用 .env.local" />
            </div>
            <div>
              <label className="label">聊天模型</label>
              <input className="input" value={form.llm_model ?? ''} onChange={(e) => set('llm_model', e.target.value)} placeholder="qwen3.8-27b" />
            </div>
            <div>
              <label className="label">分析模型（记忆抽取用，通常同上）</label>
              <input className="input" value={form.llm_analysis_model ?? ''} onChange={(e) => set('llm_analysis_model', e.target.value)} />
            </div>
            <div>
              <label className="label">向量模型（记忆语义检索）</label>
              <input className="input" value={form.embedding_model ?? ''} onChange={(e) => set('embedding_model', e.target.value)} placeholder="qwen3-vl-embedding-8b" />
            </div>
            <div>
              <label className="label">向量接口地址（留空 = 跟聊天接口相同）</label>
              <input className="input" value={form.embedding_base_url ?? ''} onChange={(e) => set('embedding_base_url', e.target.value)} placeholder="https://api.example.com/v1" />
            </div>
            <div>
              <label className="label">向量接口 Key（留空 = 跟聊天 Key 相同）</label>
              <input className="input" type="password" value={form.embedding_api_key ?? ''} onChange={(e) => set('embedding_api_key', e.target.value)} />
            </div>
            <div>
              <label className="label">后台分析深度思考（更准但更慢）</label>
              <select className="input" value={form.analysis_thinking ?? 'false'} onChange={(e) => set('analysis_thinking', e.target.value)}>
                <option value="false">关闭（推荐，快）</option>
                <option value="true">开启（慢，可能更细致）</option>
              </select>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button className="btn" onClick={() => save(['llm_base_url', 'llm_api_key', 'llm_model', 'llm_analysis_model', 'embedding_model', 'embedding_base_url', 'embedding_api_key', 'analysis_thinking'], '模型设置已保存，立即生效')} disabled={saving}>
              保存并立即生效
            </button>
            <Chip tone="plain">当前生效：{eff.model} @ {eff.baseUrl}</Chip>
            <Chip tone="plain">向量：{eff.embeddingMode}</Chip>
            {eff.lastUsed ? (
              <Chip tone="plain">
                实际服务：{eff.lastUsed.model}{eff.lastUsed.fallback ? '（自动降级）' : ''}
              </Chip>
            ) : null}
            {eff.baseUrlFromEnv || eff.keyFromEnv ? <Chip tone="plain">部分配置来自 .env.local</Chip> : null}
            <button
              className="btn-ghost"
              onClick={async () => {
                const j = await profilePost({ action: 'rebuild_embeddings' });
                setToast(j.ok ? `已重算 ${j.count} 条记忆向量` : '重算失败');
              }}
            >
              重算全部记忆向量
            </button>
          </div>

          {ping ? (
            <div className="mt-4 space-y-1.5 rounded-2xl bg-rose-50/60 px-4 py-3 text-xs">
              <div>数据库：{ping.database?.ok ? '✅ 正常' : `❌ ${ping.database?.error}`}</div>
              <div>聊天模型：{ping.llm?.ok ? `✅ ${ping.llm.ms}ms · ${ping.llm.reply}` : `❌ ${ping.llm?.error}`}</div>
              <div>向量模型：{ping.embedding?.ok ? `✅ ${ping.embedding.mode} · ${ping.embedding.dim} 维` : `❌ ${ping.embedding?.error}`}</div>
              <div>关系状态：{ping.state?.ok ? `✅ 阶段 ${ping.state.stage} · ${ping.state.messages} 条消息 · 场景 ${ping.state.scene === 'offline' ? '线下' : '线上'}（${ping.state.sceneMode}）` : `❌ ${ping.state?.error}`}</div>
              <div>向量连接（可单独配置）：{form.embedding_base_url || eff.baseUrl}</div>
            </div>
          ) : null}
        </Card>

        <Card title="场景（线上聊天 / 线下相处）">
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                ['auto', '自动识别'],
                ['online', '一直线上'],
                ['offline', '一直线下'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                className={(form.scene_mode || 'auto') === k ? 'btn' : 'btn-ghost'}
                onClick={async () => {
                  // 直接提交目标值：save() 里读的是 setState 之前的旧 form，先 set 再 save 会把旧值存回去
                  set('scene_mode', k);
                  await fetch('/api/settings', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ settings: { scene_mode: k } }),
                  })
                    .then((r) => {
                      if (!r.ok) throw new Error(`保存失败 ${r.status}`);
                      setToast(`场景已设为：${label}`);
                      reload();
                    })
                    .catch((e) => setToast(`保存失败：${e?.message || e}`));
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="dim mt-3 leading-relaxed">
            自动识别：规则先判（牵手、抱着、坐旁边…→ 线下；发消息、回我、屏幕…→ 线上），后台分析再用上下文校正。
            手动指定时优先级最高，不会被识别覆盖。聊天页右上角也有同样的开关。
          </p>
        </Card>

        <Card title="她的生活与亲密">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="label">生活系统（你不在时她也在生活）</label>
              <select className="input" value={form.life_enabled ?? 'true'} onChange={(e) => set('life_enabled', e.target.value)}>
                <option value="true">开启（推荐）</option>
                <option value="false">关闭（她只在聊天时存在）</option>
              </select>
            </div>
            <div>
              <label className="label">生理周期</label>
              <select className="input" value={form.cycle_enabled ?? 'true'} onChange={(e) => set('cycle_enabled', e.target.value)}>
                <option value="true">开启</option>
                <option value="false">关闭</option>
              </select>
            </div>
            <div>
              <label className="label">亲密内容与同意</label>
              <p className="dim">分级与偏好揭露在亲密页统一管理。</p>
              <Link href="/intimacy" className="btn-ghost mt-2">打开亲密设置</Link>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button className="btn" onClick={() => save(['life_enabled', 'cycle_enabled'], '已保存，立即生效')} disabled={saving}>
              保存
            </button>
            <Link href="/world" className="btn-ghost">
              她的世界 →
            </Link>
            <Link href="/intimacy" className="btn-ghost">
              亲密设置 →
            </Link>
          </div>
          <p className="dim mt-2 leading-relaxed">
            生活系统会让她的健康、心情、位置、活动随时间自然推进（她在你不在时也过日子），回来时能自然分享。
            亲密表达受关系阶段和所选分级影响；三级可以更成熟、更直白地表达，但仍保持非露骨。
          </p>
        </Card>

        <Card title="自定义模式（数值直控）">
          <div className="flex flex-wrap items-center gap-2">
            <button
              className={customOn ? 'btn' : 'btn-ghost'}
              onClick={async () => {
                // 注意：必须用"目标值"直接提交，不能走 save(['custom_mode'])——
                // 那会读到 setState 之前的旧值，导致"关不掉"
                const on = !customOn;
                const next = on ? '1' : '0';
                setForm((s) => ({ ...s, custom_mode: next }));
                setSaving(true);
                const r = await fetch('/api/settings', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ settings: { custom_mode: next } }),
                });
                const j = await r.json();
                setSaving(false);
                setToast(j?.error ? j.error : on ? '自定义模式已开启：数值不再自动变化' : '自定义模式已关闭：数值恢复自动演化');
                reload();
              }}
            >
              {customOn ? '已开启（点击关闭）' : '开启自定义模式'}
            </button>
            {customOn ? (
              <Chip tone="plain">数值已冻结，完全由你设定</Chip>
            ) : (
              <Chip tone="plain">默认：数值随对话与时间自然演化</Chip>
            )}
          </div>
          <p className="dim mt-3 leading-relaxed">
            开启后：亲密度、信任、情感银行、张力、修复信用、关系阶段、6 项性格、依恋两轴、性欲相关数值都<strong>不再自动变化</strong>，
            完全由你在下面直接设定；设定的效果会在之后的对话里明显体现（语气、主动性、黏人程度、占有欲、亲密程度等）。
          </p>
          {customOn && cv ? (
            <div className="mt-3 space-y-3">
              <div className="grid gap-3 md:grid-cols-3">
                <div>
                  <label className="label">亲密度 0-100</label>
                  <input className="input" type="number" min={0} max={100} value={cv.intimacy} onChange={(e) => setCv({ ...cv, intimacy: e.target.value })} />
                </div>
                <div>
                  <label className="label">信任 0-100</label>
                  <input className="input" type="number" min={0} max={100} value={cv.trust} onChange={(e) => setCv({ ...cv, trust: e.target.value })} />
                </div>
                <div>
                  <label className="label">情感余额 -100~100</label>
                  <input className="input" type="number" min={-100} max={100} value={cv.emotional_balance} onChange={(e) => setCv({ ...cv, emotional_balance: e.target.value })} />
                </div>
                <div>
                  <label className="label">未解决张力 0-100</label>
                  <input className="input" type="number" min={0} max={100} value={cv.unresolved_tension} onChange={(e) => setCv({ ...cv, unresolved_tension: e.target.value })} />
                </div>
                <div>
                  <label className="label">修复信用 0-100</label>
                  <input className="input" type="number" min={0} max={100} value={cv.repair_credit} onChange={(e) => setCv({ ...cv, repair_credit: e.target.value })} />
                </div>
                <div>
                  <label className="label">关系阶段</label>
                  <select className="input" value={cv.stage} onChange={(e) => setCv({ ...cv, stage: Number(e.target.value) })}>
                    {['初识', '试探', '加深', '融合', '承诺'].map((n, i) => (
                      <option key={i} value={i}>
                        {`${i} ${n}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">心情（文字，如 心动 / 低落）</label>
                  <input className="input" maxLength={12} value={cv.mood} onChange={(e) => setCv({ ...cv, mood: e.target.value })} />
                </div>
              </div>
              <div>
                <div className="label">性格（0-100）</div>
                <div className="grid gap-3 md:grid-cols-3">
                  {(
                    [
                      ['warmth', '温柔'],
                      ['playfulness', '俏皮'],
                      ['romance', '浪漫'],
                      ['directness', '直接'],
                      ['independence', '独立'],
                      ['emotional_intensity', '情绪强度'],
                    ] as const
                  ).map(([k, label]) => (
                    <div key={k}>
                      <label className="label">{label}</label>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={100}
                        value={(cv.personality || {})[k] ?? 50}
                        onChange={(e) => setCv({ ...cv, personality: { ...(cv.personality || {}), [k]: e.target.value } })}
                      />
                    </div>
                  ))}
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <div>
                  <label className="label">依恋·焦虑 0-100</label>
                  <input className="input" type="number" min={0} max={100} value={cv.anxiety} onChange={(e) => setCv({ ...cv, anxiety: e.target.value })} />
                </div>
                <div>
                  <label className="label">依恋·回避 0-100</label>
                  <input className="input" type="number" min={0} max={100} value={cv.avoidance} onChange={(e) => setCv({ ...cv, avoidance: e.target.value })} />
                </div>
                <div>
                  <label className="label">性欲 0-100</label>
                  <input className="input" type="number" min={0} max={100} value={cv.libido} onChange={(e) => setCv({ ...cv, libido: e.target.value })} />
                </div>
                <div>
                  <label className="label">亲密需求 0-100</label>
                  <input className="input" type="number" min={0} max={100} value={cv.intimacy_need} onChange={(e) => setCv({ ...cv, intimacy_need: e.target.value })} />
                </div>
                <div>
                  <label className="label">性满意度 0-100</label>
                  <input className="input" type="number" min={0} max={100} value={cv.sexual_satisfaction} onChange={(e) => setCv({ ...cv, sexual_satisfaction: e.target.value })} />
                </div>
                <div>
                  <label className="label">性压力 0-100</label>
                  <input className="input" type="number" min={0} max={100} value={cv.sexual_stress} onChange={(e) => setCv({ ...cv, sexual_stress: e.target.value })} />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="btn"
                  onClick={async () => {
                    const r = await fetch('/api/settings', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'custom_values', values: { ...cv, stage: Number(cv.stage) } }),
                    });
                    const j = await r.json();
                    setToast(j?.ok ? '数值已应用，从下一句回复开始明显生效' : j?.error || '保存失败');
                    loadCv();
                  }}
                >
                  应用数值
                </button>
                <button className="btn-ghost" onClick={loadCv}>
                  重新读取当前值
                </button>
              </div>
            </div>
          ) : null}
        </Card>

        <Card title="你们的身份">
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="label">她叫什么（留空则让她问你）</label>
              <input className="input" value={form.agent_name ?? ''} onChange={(e) => set('agent_name', e.target.value)} />
            </div>
            <div>
              <label className="label">你怎么称呼</label>
              <input className="input" value={form.user_name ?? ''} onChange={(e) => set('user_name', e.target.value)} />
            </div>
            <div>
              <label className="label">性格开放度（1 = 正常，0 = 性格锁死）</label>
              <input className="input" type="number" step="0.1" min={0} max={2} value={form.personality_openness ?? '1'} onChange={(e) => set('personality_openness', e.target.value)} />
            </div>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <label className="label">关于你（她的用户画像）</label>
              <textarea className="textarea" rows={3} value={form.user_profile ?? ''} onChange={(e) => set('user_profile', e.target.value)} placeholder="专业、工作、性格、喜好、最近在忙什么…" />
            </div>
            <div>
              <label className="label">你们的共同故事（她的自我认知）</label>
              <textarea className="textarea" rows={3} value={form.agent_story ?? ''} onChange={(e) => set('agent_story', e.target.value)} placeholder="她是谁、在哪、做什么、喜欢什么…" />
            </div>
          </div>
          <button className="btn mt-3" onClick={() => save(['agent_name', 'user_name', 'personality_openness', 'user_profile', 'agent_story'], '已保存身份信息')} disabled={saving}>
            保存
          </button>
        </Card>

        <Card
          title="主动消息"
          right={
            <button
              className="btn-ghost"
              onClick={async () => {
                const r = await fetch('/api/proactive', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ force: true }),
                });
                const j = await r.json();
                setToast(j.sent ? `她发来了：${j.message}` : `这次没有发：${j.reason}`);
                reload();
              }}
            >
              立刻试一次
            </button>
          }
        >
          <div className="grid gap-3 md:grid-cols-4">
            <div>
              <label className="label">频率</label>
              <select className="input" value={form.proactive_frequency ?? 'medium'} onChange={(e) => set('proactive_frequency', e.target.value)}>
                <option value="off">关闭</option>
                <option value="low">低（每天最多 1 条）</option>
                <option value="medium">中（每天最多 2 条）</option>
                <option value="high">高（每天最多 3 条）</option>
              </select>
            </div>
            <div>
              <label className="label">免打扰开始</label>
              <input className="input" type="time" value={form.quiet_start ?? '23:00'} onChange={(e) => set('quiet_start', e.target.value)} />
            </div>
            <div>
              <label className="label">免打扰结束</label>
              <input className="input" type="time" value={form.quiet_end ?? '08:00'} onChange={(e) => set('quiet_end', e.target.value)} />
            </div>
            <div>
              <label className="label">免打扰开关</label>
              <select className="input" value={String(form.dnd ?? 'off')} onChange={(e) => set('dnd', e.target.value)}>
                <option value="off">正常</option>
                <option value="true">开启（不主动发消息）</option>
              </select>
            </div>
          </div>
          <p className="dim mt-3 leading-relaxed">
            她不会骚扰你：超过 6 小时没聊、关系进入试探期以后才会考虑主动开口；如果你连续两次没回，她会安静下来等你。纪念日和她记住的约定会优先触发。
          </p>
          <button className="btn mt-3" onClick={() => save(['proactive_frequency', 'quiet_start', 'quiet_end', 'dnd'], '主动消息设置已保存')} disabled={saving}>
            保存
          </button>
        </Card>

        <Card title="关系与记忆的节奏">
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="label">阶段跃迁等待天数（默认 3 天）</label>
              <input className="input" type="number" min={0} max={30} value={form.stage_dwell_days ?? '3'} onChange={(e) => set('stage_dwell_days', e.target.value)} />
            </div>
            <div>
              <label className="label">带入对话的历史轮数</label>
              <input className="input" type="number" min={4} max={60} value={form.context_size ?? '20'} onChange={(e) => set('context_size', e.target.value)} />
            </div>
            <div>
              <label className="label">每轮检索记忆条数</label>
              <input className="input" type="number" min={0} max={20} value={form.memory_top_k ?? '8'} onChange={(e) => set('memory_top_k', e.target.value)} />
            </div>
          </div>
          <p className="dim mt-3">
            想快点体验不同阶段的语气，可以把"等待天数"改成 0：亲密度到顶后，她会很快找机会和你确认关系。
          </p>
          <button className="btn mt-3" onClick={() => save(['stage_dwell_days', 'context_size', 'memory_top_k'], '已保存')} disabled={saving}>
            保存
          </button>
        </Card>

        <Card title="隐私与数据">
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost" onClick={download}>
              导出全部数据（JSON）
            </button>
            <button
              className="btn-ghost"
              onClick={async () => {
                if (!confirm('确定清空聊天记录吗？记忆、性格、关系状态会保留。')) return;
                await fetch('/api/messages', { method: 'DELETE' });
                setToast('聊天记录已清空');
                reload();
              }}
            >
              只清空聊天记录
            </button>
            <button className="btn-ghost" onClick={() => reset(true)}>
              清空全部数据（保留设置）
            </button>
            <button className="btn-ghost" onClick={() => reset(false)}>
              恢复出厂状态
            </button>
          </div>
          <p className="dim mt-3 leading-relaxed">
            聊天记录、记忆、性格参数、依恋数据都存储在本机 <code className="rounded bg-rose-50 px-1">data/girlfriend.db</code> 里，
            你可以随时查看、编辑、删除或整份导出。删除即彻底删除，不上传任何服务器。
          </p>
        </Card>

        <Card title="关于她怎么运转（简单说）">
          <ul className="space-y-2 text-xs leading-relaxed text-ink-700">
            <li>• <b>关系阶段</b>：初识 → 试探 → 加深 → 融合 → 承诺。阶段越高，她能表达的亲密越多；越级会被拦住。</li>
            <li>• <b>性格</b>：6 个维度从 50 开始。每轮对话只收集"信号"，同方向信号在不同情境下累积够 5 次才 ±1；连续 15 次同向确认后进入半固化（每 30 轮才允许再动 1 点）。</li>
            <li>• <b>依恋</b>：焦虑/回避两轴决定她怎么应对亲密和冲突，每 10 轮评估一次，累积 3 次同向信号才真正偏移。</li>
            <li>• <b>情感银行</b>：关心是存款，敷衍是取款。余额影响她有多主动、多甜。</li>
            <li>• <b>冲突-修复</b>：张力升高她会闹、会冷、会要求谈谈；修复成功会提升修复信用和情感余额，成为"共同回忆"。</li>
            <li>• <b>记忆</b>：每轮后台抽取，向量检索 + 重要度 + 新鲜度 + 阶段相关度打分；重要事实不衰减，低价值 30 天自动归档。</li>
          </ul>
        </Card>
      </div>

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}