'use client';

import { Card } from '@/components/ui';
import { weeklySnapshotSummary } from './shared';
import type { WeeklySnapshot } from './shared';

export function WeeklySnapshotCard({ weeklySnapshots }: { weeklySnapshots?: WeeklySnapshot[] }) {
  return (
    <Card title="每周生活快照">
      {weeklySnapshots?.length ? (
        <div className="space-y-2">
          {weeklySnapshots.map((snapshot) => (
            <div key={snapshot.week} className="flex items-center justify-between gap-3 border-b line py-2 last:border-0">
              <span className="text-xs font-medium ink-2">{snapshot.week}</span>
              <span className="text-right text-xs ink-2">{weeklySnapshotSummary(snapshot.state_json)}</span>
            </div>
          ))}
        </div>
      ) : <p className="dim">还没有周度记录。</p>}
    </Card>
  );
}