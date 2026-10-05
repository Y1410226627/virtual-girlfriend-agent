'use client';

import { Card } from '@/components/ui';
import type { SaveFn, SetFieldFn } from './shared';

export function PacingCard({
  form,
  set,
  save,
  saving,
}: {
  form: Record<string, string>;
  set: SetFieldFn;
  save: SaveFn;
  saving: boolean;
}) {
  return (
    <Card title="关系与记忆的节奏">
      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <label className="label" htmlFor="pacing_stage_dwell_days">阶段跃迁等待天数（默认 3 天）</label>
          <input id="pacing_stage_dwell_days" className="input" type="number" min={0} max={30} value={form.stage_dwell_days ?? '3'} onChange={(e) => set('stage_dwell_days', e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="pacing_context_size">带入对话的历史轮数</label>
          <input id="pacing_context_size" className="input" type="number" min={2} max={60} value={form.context_size ?? '20'} onChange={(e) => set('context_size', e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="pacing_memory_top_k">每轮检索记忆条数</label>
          <input id="pacing_memory_top_k" className="input" type="number" min={3} max={30} value={form.memory_top_k ?? '8'} onChange={(e) => set('memory_top_k', e.target.value)} />
        </div>
      </div>
      <p className="dim mt-3">
        想快点体验不同阶段的语气，可以把"等待天数"改成 0：亲密度到顶后，她会很快找机会和你确认关系。
      </p>
      <button className="btn mt-3" onClick={() => save(['stage_dwell_days', 'context_size', 'memory_top_k'], '已保存')} disabled={saving}>
        保存
      </button>
    </Card>
  );
}