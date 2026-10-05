'use client';

import { Card } from '@/components/ui';
import type { CalEvent, NewEvent, PostFn } from './shared';

export function EventsCard({
  events,
  newEvent,
  setNewEvent,
  post,
}: {
  events: CalEvent[];
  newEvent: NewEvent;
  setNewEvent: React.Dispatch<React.SetStateAction<NewEvent>>;
  post: PostFn;
}) {
  return (
    <Card title="纪念日 / 约定 / 未来事件">
      <div className="space-y-2">
        {events.map((e) => (
          <div key={e.id} className="flex items-center justify-between rounded-2xl border line surf px-3.5 py-2.5">
            <div>
              <div className="text-xs font-medium ink-1">
                {e.title} {e.repeat_yearly ? <span className="ink-3">（每年）</span> : null}
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
      <label className="mt-2 flex items-center gap-2 text-xs ink-2">
        <input type="checkbox" checked={newEvent.repeat_yearly} onChange={(e) => setNewEvent((s) => ({ ...s, repeat_yearly: e.target.checked }))} />
        每年重复（生日、纪念日）
      </label>
      <button className="btn mt-3" onClick={() => post({ action: 'add_event', ...newEvent }, '已添加')}>
        添加
      </button>
    </Card>
  );
}