'use client';

import { Card, Chip, fmtTime } from '@/components/ui';
import type { RelMemory, ReviewSummary } from './shared';

export function MemoriesCard({ memories, summaries }: { memories: RelMemory[]; summaries: ReviewSummary[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="关系记忆">
        {memories.length === 0 ? <p className="dim">还没有关系记忆。</p> : null}
        <div className="space-y-2">
          {memories.map((m) => (
            <div key={m.id} className="rounded-2xl border line surf px-3.5 py-2.5">
              <div className="flex items-center gap-2">
                <Chip tone="plain">{m.type === 'relationship' ? '关系' : '依恋'}</Chip>
                <span className="text-[11px] ink-3">{fmtTime(m.created_at)}</span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed ink-2">{m.content}</p>
            </div>
          ))}
        </div>
      </Card>
      <Card title="每日回顾">
        {summaries.length === 0 ? <p className="dim">还没有摘要。</p> : null}
        <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
          {summaries.map((s) => (
            <div key={s.id} className="rounded-2xl accent-soft px-3.5 py-2.5">
              <Chip tone="plain">{s.date}</Chip>
              <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed ink-2">{s.summary}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}