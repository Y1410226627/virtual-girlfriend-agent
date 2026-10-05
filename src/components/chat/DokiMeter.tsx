'use client';

import { useState } from 'react';
import { Bar } from '@/components/ui';
import { computeDoki } from '@/lib/doki';
import type { RelationshipState } from './shared';

/**
 * 心动指数（dokidoki）：聊天页头部一个安静的小部件。
 * Lv + 细进度条 + 一句话状态；hover 看说明，点击展开分项。
 * 数据来自页面已有的 state（/api/state 的 relationship），不额外请求。
 */
export default function DokiMeter({ rel }: { rel?: RelationshipState | null }) {
  const [open, setOpen] = useState(false);
  const doki = computeDoki({
    intimacy: rel?.intimacy,
    trust: rel?.trust,
    emotional_balance: rel?.emotional_balance,
    repair_credit: rel?.repair_credit,
    unresolved_tension: rel?.unresolved_tension,
    stage: rel?.stage,
  });

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`心动指数 Lv.${doki.level} ${doki.title}，进度 ${Math.round(doki.progress)}%，点击查看分项`}
        title="心动指数：由亲密度、信任、情感余额、修复信用与未解张力推导；越往后越需要时间沉淀"
        className="flex items-center gap-1.5 rounded-full border line surf-2 px-2.5 py-1 text-[11px] transition hover:accent-soft active:scale-[0.98]"
      >
        <span aria-hidden className="acc leading-none">
          ♥
        </span>
        <span className="tabular-nums ink-3">Lv.{doki.level}</span>
        <span className="font-medium ink-1">{doki.title}</span>
        <span aria-hidden className="relative block h-1 w-12 overflow-hidden rounded-full accent-soft">
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-rose-300 to-rose-500 transition-all duration-500"
            style={{ width: `${doki.progress}%` }}
          />
        </span>
        <span className="hidden ink-3 sm:inline">{doki.note}</span>
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-40 mt-2 w-60 rounded-2xl border line surf p-3 shadow-soft">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[11px] font-semibold ink-1">心动指数 · 分项</span>
            <span className="text-[10px] ink-3 tabular-nums">{Math.round(doki.score)} / 100</span>
          </div>
          <div className="space-y-2">
            {[doki.breakdown.intimacy, doki.breakdown.trust, doki.breakdown.balance, doki.breakdown.repair, doki.breakdown.tension].map(
              (item) => (
                <div key={item.key} className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-[10px] ink-2">{item.label}</span>
                  <span className="min-w-0 flex-1">
                    <Bar value={item.value * 100} height={4} tone={item.weight < 0 ? 'peach' : 'rose'} />
                  </span>
                  <span className={`w-9 shrink-0 text-right text-[10px] tabular-nums ${item.weight < 0 ? 'acc-2' : 'ink-3'}`}>
                    {item.points > 0 ? `+${item.points}` : item.points}
                  </span>
                </div>
              )
            )}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed ink-3">{doki.note}</p>
        </div>
      ) : null}
    </div>
  );
}