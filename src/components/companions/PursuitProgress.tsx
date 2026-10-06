'use client';

import { Card, Bar, Chip } from '@/components/ui';
import type { PursuitProgressData } from './shared';

const LADDER = [
  { key: 'stranger', label: '陌生人' },
  { key: 'acquaintance', label: '认识' },
  { key: 'ambiguous', label: '暧昧' },
  { key: 'pursuing', label: '追求中' },
  { key: 'girlfriend', label: '女友' },
] as const;

/** 攻略进度条：陌生人 ▸ 认识 ▸ 暧昧 ▸ 追求中 ▸ 女友 */
export function PursuitProgress({ progress }: { progress: PursuitProgressData }) {
  const isBranch = progress.status === 'cold' || progress.status === 'rejected' || progress.status === 'closed';
  const currentIndex = LADDER.findIndex((s) => s.key === progress.status);

  return (
    <Card
      title="攻略进度"
      right={
        <Chip tone={progress.status === 'girlfriend' ? 'rose' : isBranch ? 'plain' : 'peach'}>
          {progress.label}
          {progress.in_cooldown ? ' · 冷却中' : ''}
        </Chip>
      }
    >
      {/* 阶梯 */}
      <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="攻略阶段">
        {LADDER.map((s, i) => {
          const active = currentIndex >= 0 && i <= currentIndex;
          const current = i === currentIndex;
          return (
            <li key={s.key} className="flex items-center gap-1.5">
              <span
                className={`rounded-full px-2.5 py-1 font-medium ${
                  current ? 'bg-rose-500 text-white shadow-bubble' : active ? 'accent-soft acc' : 'surf-2 ink-3 border line'
                }`}
              >
                {s.label}
              </span>
              {i < LADDER.length - 1 ? <span className="ink-3" aria-hidden>▸</span> : null}
            </li>
          );
        })}
      </ol>

      {isBranch ? (
        <div className="mt-3 rounded-2xl accent-soft px-4 py-3 text-xs leading-relaxed ink-2">
          {progress.status === 'cold'
            ? '最近一段时间没有正向互动，她变得有些冷淡——重新主动、温和地聊几次就能回暖。'
            : progress.status === 'rejected'
              ? `她拒绝了表白（累计 ${progress.reject_count} 次）。冷却期内可以日常聊天，但暂时不适合再表白。`
              : '这段关系已被永久关闭，已移出主列表。'}
        </div>
      ) : null}

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl surf border line px-4 py-3">
          <div className="dim">吸引力（攻略专用）</div>
          <div className="mt-1 text-sm font-medium acc-2">{progress.attraction} / 100</div>
          <div className="mt-2">
            <Bar value={progress.attraction} tone="peach" height={8} />
          </div>
        </div>
        <div className="rounded-2xl surf border line px-4 py-3">
          <div className="dim">好感 / 信任</div>
          <div className="mt-1 text-sm font-medium acc">
            {progress.intimacy} / {progress.trust}
          </div>
          <div className="mt-2">
            <Bar value={progress.intimacy} height={8} />
          </div>
        </div>
        <div className="rounded-2xl surf border line px-4 py-3">
          <div className="dim">距下一阶段</div>
          <div className="mt-1 text-sm font-medium ink-1">{progress.next === 'girlfriend' ? '在一起' : progress.next ? '推进中' : '已是女友'}</div>
          <div className="dim mt-1">
            {progress.reject_count > 0 ? `累计被拒 ${progress.reject_count} 次` : '暂无被拒记录'}
          </div>
        </div>
      </div>

      {progress.requirements.length ? (
        <div className="mt-3 space-y-1.5">
          {progress.requirements.map((r) => (
            <div key={r.key} className="flex items-center justify-between text-xs">
              <span className={r.met ? 'acc' : 'ink-2'}>
                {r.met ? '✓ ' : '· '}
                {r.label}
              </span>
              <span className="ink-2">
                {r.current} / {r.target}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
