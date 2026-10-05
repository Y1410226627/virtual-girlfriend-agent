'use client';

import { Card, Chip, fmtTime } from '@/components/ui';
import { emoMap } from './shared';
import type { HealthState, PsychologyState } from './shared';

export function NowDoingCard({
  p,
  loc,
  act,
  h,
  recently,
}: {
  p: PsychologyState;
  loc: { name: string };
  act: { name: string; expectedEnd?: string };
  h: HealthState;
  recently?: string[];
}) {
  return (
    <Card title="她现在在做什么">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl accent-soft text-2xl">
          {emoMap[p.baseEmotion] || '🙂'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-base font-medium ink-1">{act.name}</div>
          <div className="dim mt-0.5">
            📍 {loc.name}
            {act.expectedEnd ? ` · 大约到 ${fmtTime(act.expectedEnd)} 结束` : ''}
          </div>
        </div>
        <Chip>{p.baseEmotion}</Chip>
        {h.illness !== 'none' ? <Chip tone="plain">🤒 {h.illness}中 · 第 {h.illnessDay} 天</Chip> : null}
      </div>
      {recently?.length ? (
        <div className="mt-3 rounded-2xl accent-soft px-3.5 py-3">
          <div className="text-xs font-medium ink-2">最近这段时间她……</div>
          <ul className="mt-1.5 space-y-1 text-xs leading-relaxed ink-2">
            {recently.map((r, i) => (
              <li key={i}>· {r}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}