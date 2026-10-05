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
            // 留空的输入框不提交（保持她的原值）：空串会被 Number('') 解析成 0，静默清零
            const pick = (x: unknown): number | undefined => {
              if (x === undefined || x === null || x === '') return undefined;
              const n = Number(x);
              return isFinite(n) ? n : undefined;
            };
            const collect = (fields: Record<string, unknown>): Record<string, number> => {
              const out: Record<string, number> = {};
              for (const [k, v] of Object.entries(fields)) {
                const n = pick(v);
                if (n !== undefined) out[k] = n;
              }
              return out;
            };
            await post(
              {
                action: 'set_states',
                health: collect({
                  energy: sv.energy,
                  sleep_quality: sv.sleep_quality,
                  hunger: sv.hunger,
                  exercise: sv.exercise,
                  cycle_day: sv.cycle_day,
                }),
                psychology: collect({
                  stress: sv.stress,
                  loneliness: sv.loneliness,
                  missing_user: sv.missing_user,
                  security: sv.security,
                  self_worth: sv.self_worth,
                  mental_energy: sv.mental_energy,
                }),
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