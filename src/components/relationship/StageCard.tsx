'use client';

import { Card, Bar } from '@/components/ui';
import { StageLadder } from '@/components/charts';
import type { Stage, RelationshipInfo, PostFn } from './shared';

export function StageCard({
  stages,
  rel,
  dwell,
  capDays,
  nextStage,
  post,
}: {
  stages: Stage[];
  rel: RelationshipInfo;
  dwell: number;
  capDays?: number | null;
  nextStage?: Stage;
  post: PostFn;
}) {
  return (
    <Card title="关系阶段（Knapp 关系发展模型）">
      <StageLadder stages={stages} current={rel.stage ?? 0} />
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl accent-soft px-4 py-3">
          <div className="text-sm font-semibold acc">{rel.stageName}期</div>
          <div className="dim mt-1 leading-relaxed">{rel.stageCore}</div>
        </div>
        <div className="rounded-2xl surf border line px-4 py-3">
          <div className="dim">本阶段已持续</div>
          <div className="mt-1 text-sm font-medium ink-1">{rel.daysInStage} 天</div>
          <div className="dim mt-1">
            跃迁条件：亲密度到达 {rel.stageMax} 并保持 {dwell} 天 + 一次关系确认对话
          </div>
        </div>
        <div className="rounded-2xl surf border line px-4 py-3">
          <div className="dim">距阶段天花板</div>
          <div className="mt-1 text-sm font-medium ink-1">
            {Math.max(0, Math.round((rel.stageMax - rel.intimacy) * 10) / 10)} 点
            {capDays !== null && capDays !== undefined ? ` · 已触顶 ${capDays} 天` : ''}
          </div>
          <div className="dim mt-1">
            {rel.pending_stage_confirm
              ? '她已经准备好和你谈一次"我们现在算什么"'
              : nextStage
                ? `下一阶段：${nextStage.name}`
                : '已经是最终阶段'}
          </div>
        </div>
      </div>
      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between text-xs ink-2">
          <span>亲密度 {rel.intimacy} / 100（{rel.stageMin}-{rel.stageMax} 为本阶段区间）</span>
          <span>信任 {rel.trust}</span>
        </div>
        {Number.isFinite(rel.stageMin) && Number.isFinite(rel.stageMax) && rel.stageMax > rel.stageMin ? (
          <Bar value={rel.intimacy - rel.stageMin} min={0} max={rel.stageMax - rel.stageMin} height={10} />
        ) : null}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <span className="dim">手动设置阶段（体验不同阶段语气用）</span>
        <select
          className="input !w-auto !py-1.5 text-xs"
          aria-label="关系阶段"
          value={rel.stage}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (next === rel.stage) return;
            const target = stages.find((s) => s.id === next);
            // 手动改阶段会重置阶段计时与推进进度，必须二次确认，避免误触
            if (!window.confirm(`确定把关系阶段调整为「${target ? target.name : next}期」吗？这会重置阶段计时和推进进度。`)) {
              e.currentTarget.value = String(rel.stage);
              return;
            }
            post({ action: 'set_stage', stage: next }, '阶段已手动调整');
          }}
        >
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}期（{s.min}-{s.max}）
            </option>
          ))}
        </select>
      </div>
    </Card>
  );
}