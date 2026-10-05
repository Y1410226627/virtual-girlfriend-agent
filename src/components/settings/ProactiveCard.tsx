'use client';

import { Card } from '@/components/ui';
import type { SaveFn, SetFieldFn, SetToast } from './shared';

export function ProactiveCard({
  form,
  set,
  save,
  saving,
  setToast,
  reload,
}: {
  form: Record<string, string>;
  set: SetFieldFn;
  save: SaveFn;
  saving: boolean;
  setToast: SetToast;
  reload: () => void;
}) {
  return (
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
  );
}