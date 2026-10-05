'use client';

import { Card, Chip } from '@/components/ui';
import type { CustomValues, SetToast } from './shared';

export function CustomModeCard({
  customOn,
  setForm,
  setSaving,
  setToast,
  reload,
  cv,
  setCv,
  loadCv,
}: {
  customOn: boolean;
  setForm: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setSaving: React.Dispatch<React.SetStateAction<boolean>>;
  setToast: SetToast;
  reload: () => void;
  cv: CustomValues | null;
  setCv: React.Dispatch<React.SetStateAction<CustomValues | null>>;
  loadCv: () => void;
}) {
  return (
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
  );
}