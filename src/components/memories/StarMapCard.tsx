'use client';

import { Card } from '@/components/ui';
import type { AccessedMemory, ImportanceBucket, MemoryStats, ScatterPoint } from './shared';

/**
 * 记忆星图：纯 SVG 手绘散点（x=重要度，y=被想起次数）+ 最常想起 + 重要度分布。
 * 数据全部来自服务端返回的 stats，stats 缺失时不渲染（由调用处控制）。
 */
export function StarMapCard({ stats }: { stats: MemoryStats }) {
  const scatter: ScatterPoint[] = Array.isArray(stats?.scatter) ? stats.scatter : [];
  const topAccessed: AccessedMemory[] = Array.isArray(stats?.topAccessed) ? stats.topAccessed : [];
  const buckets: ImportanceBucket[] = Array.isArray(stats?.importanceBuckets) ? stats.importanceBuckets : [];
  const counts = stats?.counts || { active: 0, archived: 0, superseded: 0 };

  // 一条记忆都没有：给一句引导文案
  if (!scatter.length && !counts.active && !counts.archived && !counts.superseded) {
    return (
      <div className="px-5 pt-4 md:px-8">
        <Card title="记忆星图">
          <p className="dim">她还没记住什么。多聊聊，星图上就会亮起属于你们的光点。</p>
        </Card>
      </div>
    );
  }

  // 散点坐标系（viewBox 内绘制，width 100% 自适应）
  const W = 600;
  const H = 200;
  const padL = 34;
  const padR = 12;
  const padT = 14;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  // 用 reduce 求最大值，避免大数组展开成 Math.max(...arr) 造成调用栈溢出
  const maxAccess = scatter.reduce((m, s) => Math.max(m, Number(s.access_count) || 0), 1);
  const xOf = (imp: number) => padL + (Math.max(0, Math.min(10, imp)) / 10) * plotW;
  const yOf = (acc: number) => padT + plotH - (Math.max(0, acc) / maxAccess) * plotH;
  const rOf = (imp: number) => 3 + (Math.max(0, Math.min(10, imp)) / 10) * 3; // 半径 3~6，按重要度
  const yTicks = Array.from(new Set([0, Math.round(maxAccess / 2), maxAccess]));

  const maxBucket = buckets.reduce((m, b) => Math.max(m, Number(b.count) || 0), 1);

  return (
    <div className="px-5 pt-4 md:px-8">
      <Card title="记忆星图">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="记忆星图（横轴重要度，纵轴被想起次数）">
          {/* 坐标轴：淡灰细线 */}
          <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} style={{ stroke: 'var(--line)' }} strokeWidth={1} />
          <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} style={{ stroke: 'var(--line)' }} strokeWidth={1} />
          {/* x 轴刻度（重要度 0/5/10） */}
          {[0, 5, 10].map((t) => (
            <text key={`x${t}`} x={xOf(t)} y={padT + plotH + 15} textAnchor="middle" fontSize={10} style={{ fill: 'var(--ink-3)' }}>
              {t}
            </text>
          ))}
          {/* y 轴刻度（被想起次数） */}
          {yTicks.map((t) => (
            <text key={`y${t}`} x={padL - 6} y={yOf(t) + 3} textAnchor="end" fontSize={10} style={{ fill: 'var(--ink-3)' }}>
              {t}
            </text>
          ))}
          {/* 每个记忆一个圆点，<title> 做悬停提示 */}
          {scatter.map((s) => (
            <circle
              key={s.id}
              cx={xOf(Number(s.importance) || 0)}
              cy={yOf(Number(s.access_count) || 0)}
              r={rOf(Number(s.importance) || 0)}
              fill="#FF7BA0"
              fillOpacity={0.5}
            >
              <title>{`${s.content}（重要度 ${Number(s.importance) || 0} · 想起 ${Number(s.access_count) || 0} 次）`}</title>
            </circle>
          ))}
        </svg>

        {/* 状态统计行 */}
        <div className="mt-2 text-[11px] ink-3">
          她一直记得：{counts.active ?? 0} 条 · 归档：{counts.archived ?? 0} 条 · 已被取代：{counts.superseded ?? 0} 条
        </div>

        <div className="mt-4 grid gap-5 md:grid-cols-2">
          {/* 最常想起（前 10） */}
          <div>
            <div className="section-title">最常想起</div>
            {topAccessed.length === 0 ? (
              <p className="dim">还没有被想起过的记忆。</p>
            ) : (
              <ol className="space-y-1.5">
                {topAccessed.map((m, i) => (
                  <li key={m.id} className="flex items-center gap-2 rounded-xl accent-soft px-3 py-1.5">
                    <span className="w-4 shrink-0 text-[11px] font-semibold acc">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-xs ink-2">{m.content}</span>
                    <span className="chip shrink-0">想起 {m.access_count} 次</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {/* 重要度分布：四根小柱条 */}
          <div>
            <div className="section-title">重要度分布</div>
            <div className="flex items-end gap-3">
              {buckets.map((b) => (
                <div key={b.label} className="flex flex-1 flex-col items-center gap-1">
                  <div className="flex h-[90px] w-full items-end">
                    <div
                      className="w-full rounded-t-lg accent-soft"
                      style={{ height: `${Math.max(4, ((Number(b.count) || 0) / maxBucket) * 90)}px` }}
                    />
                  </div>
                  <span className="text-[11px] ink-3">{b.label}</span>
                  <span className="text-[11px] font-semibold acc">{b.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}