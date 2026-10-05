'use client';

import { Card } from '@/components/ui';
import type { HealthState, PostFn } from './shared';

export function ManualStatesCard({
  h,
  sv,
  setSv,
  busy,
  post,
  setEditStates,
}: {
  h: HealthState;
  sv: Record<string, string | number>;
  setSv: React.Dispatch<React.SetStateAction<Record<string, string | number>>>;
  busy: boolean;
  post: PostFn;
  setEditStates: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
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
            const num = (x: unknown, d = 0) => (isFinite(Number(x)) ? Number(x) : d);
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
  );
}