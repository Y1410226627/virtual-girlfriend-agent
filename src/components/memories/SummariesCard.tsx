'use client';

import { Card, Chip } from '@/components/ui';
import { safeParseMeta } from './shared';
import type { DailySummary } from './shared';

export function SummariesCard({ summaries }: { summaries?: DailySummary[] }) {
  return (
    <div className="px-5 pt-6 md:px-8">
      <Card title="每日回顾（把一整天压缩成一段记忆）">
        {(summaries || []).length === 0 ? (
          <p className="dim">还没有摘要。等你们聊过一整天，第二天就会自动生成。</p>
        ) : (
          <div className="space-y-3">
            {summaries?.map((s) => (
              <div key={s.id} className="rounded-2xl accent-soft px-4 py-3">
                <div className="flex items-center gap-2">
                  <Chip tone="plain">{s.date}</Chip>
                  {s.meta ? <span className="text-[11px] ink-3">{safeParseMeta(s.meta).messages ?? 0} 条消息</span> : null}
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed ink-2">{s.summary}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}