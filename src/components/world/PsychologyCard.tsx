'use client';

import { Card, Stat } from '@/components/ui';
import type { PsychologyState } from './shared';

export function PsychologyCard({ p }: { p: PsychologyState }) {
  return (
    <Card title="心理">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="压力" value={p.stress} tone="ink" />
        <Stat label="孤独" value={p.loneliness} tone="ink" />
        <Stat label="想你" value={p.missingUser} />
        <Stat label="安全感" value={p.security} />
        <Stat label="自我价值" value={p.selfWorth} tone="peach" />
        <Stat label="心理能量" value={p.mentalEnergy} tone="peach" />
      </div>
    </Card>
  );
}