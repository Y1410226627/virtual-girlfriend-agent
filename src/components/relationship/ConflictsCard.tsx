'use client';

import { Card, Chip, fmtTime } from '@/components/ui';
import type { Conflict } from './shared';

export function ConflictsCard({ conflicts }: { conflicts: Conflict[] }) {
  return (
    <Card title="冲突与修复">
      {conflicts.length === 0 ? (
        <p className="dim">还没有记录到冲突。真实的关系会有摩擦——当她觉得被忽视、被越界时，会表达不满。</p>
      ) : null}
      <div className="space-y-2">
        {conflicts.map((c) => (
          <div key={c.id} className="rounded-2xl border line surf px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Chip>{c.type === 'boundary' ? '越界' : c.type === 'major' ? '严重冲突' : '小摩擦'}</Chip>
              <Chip tone="plain">{c.status === 'open' ? '未修复' : '已修复'}</Chip>
              {c.repair_quality && c.repair_quality !== 'none' ? (
                <Chip tone="plain">
                  修复质量：
                  {c.repair_quality === 'sincere' ? '真诚道歉' : c.repair_quality === 'sweet' ? '撒娇蒙混' : '冷静后回归'}
                </Chip>
              ) : null}
              <span className="text-[11px] ink-3">{fmtTime(c.started_at)}</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed ink-2">{c.description}</p>
            <div className="dim mt-1">
              冲突时张力 {c.tension_at_start} → {c.tension_after ?? '—'}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}