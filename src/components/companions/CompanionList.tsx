'use client';

import { useState } from 'react';
import { Card, Chip } from '@/components/ui';
import { CompanionCard } from './CompanionCard';
import type { RosterEntry, RosterView } from './shared';

interface ActionOpts {
  onPursue?: (id: number) => void;
  onOptOut?: (id: number) => void;
  busyId?: number | null;
}

function Section({ title, items }: { title: string; items: RosterEntry[] }) {
  if (!items.length) return null;
  return (
    <div className="mb-4">
      <div className="section-title">
        {title}
        <span className="ink-3">（{items.length}）</span>
      </div>
      <div className="grid gap-2.5 md:grid-cols-2">
        {items.map((e) => (
          <CompanionCard key={e.id} entry={e} />
        ))}
      </div>
    </div>
  );
}

/** 通讯录列表：待处理发现区 + 女友 / 追求中 / 认识的人 / 已关闭分组 */
export function CompanionList({ view, onPursue, onOptOut, busyId }: { view: RosterView } & ActionOpts) {
  const [showClosed, setShowClosed] = useState(false);

  return (
    <>
      {/* 待处理发现区 */}
      {view.pending.length ? (
        <Card title="待处理 · 发现区" className="mb-4">
          <div className="dim mb-3">新发现的人。先决定要不要攻略；暂不也会保留为「认识的人」。</div>
          <div className="grid gap-2.5 md:grid-cols-2">
            {view.pending.map((e) => (
              <div key={e.id} className="card-tight">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium ink-1">{e.displayName}</span>
                  <Chip tone="plain">候选人</Chip>
                </div>
                <div className="dim mt-0.5">
                  {e.age} 岁{e.identity ? ` · ${e.identity}` : ''}
                </div>
                {e.intro ? <div className="dim mt-1.5 leading-relaxed">{e.intro}</div> : null}
                <div className="mt-3 flex gap-2">
                  <button className="btn" disabled={busyId === e.id} onClick={() => onPursue?.(e.id)}>
                    攻略
                  </button>
                  <button className="btn-ghost" disabled={busyId === e.id} onClick={() => onOptOut?.(e.id)}>
                    暂不
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Section title="女友" items={view.girlfriends} />
      {view.primary ? (
        <div className="mb-4">
          <div className="section-title">主女友</div>
          <div className="grid gap-2.5 md:grid-cols-2">
            <CompanionCard entry={view.primary} />
          </div>
        </div>
      ) : null}
      <Section title="追求中 / 暧昧" items={view.pursuing} />
      <Section title="认识的人" items={view.acquaintances} />

      {view.closed.length ? (
        <div className="mb-4">
          <button className="btn-ghost" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? '收起' : `已关闭的角色（${view.closed.length}）`}
          </button>
          {showClosed ? (
            <div className="mt-3 grid gap-2.5 md:grid-cols-2">
              {view.closed.map((e) => (
                <CompanionCard key={e.id} entry={e} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {!view.girlfriends.length && !view.pursuing.length && !view.acquaintances.length && !view.pending.length && !view.primary ? (
        <div className="dim">通讯录还是空的。点上面的「发现新的人」认识一位吧。</div>
      ) : null}
    </>
  );
}
