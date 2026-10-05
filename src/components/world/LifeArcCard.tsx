'use client';

import { Card, Chip } from '@/components/ui';
import type { LifeData } from './shared';

export function LifeArcCard({ lifeArc }: { lifeArc: LifeData['lifeArc'] }) {
  return (
    <Card title="她最近的生活">
      {lifeArc ? (
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-base font-medium ink-1">{lifeArc.title}</div>
            {lifeArc.description ? <div className="dim mt-0.5">{lifeArc.description}</div> : null}
          </div>
          <Chip>第 {lifeArc.day} 天</Chip>
          {lifeArc.plannedDays ? (
            <span className="text-[11px] ink-3">计划 {lifeArc.plannedDays} 天</span>
          ) : null}
        </div>
      ) : (
        <p className="dim">最近没什么特别的，日子平平淡淡地过。</p>
      )}
    </Card>
  );
}