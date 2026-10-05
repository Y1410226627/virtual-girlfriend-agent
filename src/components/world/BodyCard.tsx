'use client';

import { Card, Bar } from '@/components/ui';
import type { HealthState, PsychologyState } from './shared';

export function BodyCard({
  h,
  p,
  editStates,
  setSv,
  setEditStates,
}: {
  h: HealthState;
  p: PsychologyState;
  editStates: boolean;
  setSv: React.Dispatch<React.SetStateAction<Record<string, string | number>>>;
  setEditStates: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
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
        {([
          ['精力', h.energy, 'rose'],
          ['睡眠', h.sleepQuality, 'rose'],
          ['饥饿', h.hunger, 'peach'],
          ['运动', h.exercise, 'peach'],
        ] as const).map(([label, v, tone]) => (
          <div key={label}>
            <div className="mb-1 flex items-center justify-between text-xs ink-2">
              <span>{label}</span>
              <span>{Math.round(v)}</span>
            </div>
            <Bar value={v} tone={tone} height={6} />
          </div>
        ))}
        {h.cycleEnabled ? <div className="dim">生理期第 {h.cycleDay} 天</div> : null}
      </div>
    </Card>
  );
}