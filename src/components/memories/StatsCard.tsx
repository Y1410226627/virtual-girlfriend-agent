'use client';

import { Stat } from '@/components/ui';
import type { MemoryStats } from './shared';

export function StatsCard({ stats }: { stats?: MemoryStats }) {
  return (
    <div className="grid grid-cols-2 gap-3 px-5 md:grid-cols-4 md:px-8">
      <Stat label="有效记忆" value={stats?.total ?? 0} unit="条" />
      <Stat label="已归档" value={stats?.archived ?? 0} unit="条" tone="ink" />
      {(stats?.byType || []).slice(0, 2).map((t) => (
        <Stat key={t.type} label={t.label} value={t.count} unit="条" tone="peach" />
      ))}
    </div>
  );
}