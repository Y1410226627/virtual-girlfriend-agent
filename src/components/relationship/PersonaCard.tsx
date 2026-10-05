'use client';

import { Card } from '@/components/ui';
import type { Edits, PostFn } from './shared';

export function PersonaCard({
  edits,
  setEdit,
  post,
}: {
  edits: Edits;
  setEdit: (k: keyof Edits, v: string | number) => void;
  post: PostFn;
}) {
  return (
    <Card title="她的身份（不预设，由你们共同创造）">
      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="label">她的名字</label>
            <input className="input" value={edits.agent_name || ''} onChange={(e) => setEdit('agent_name', e.target.value)} />
          </div>
          <div>
            <label className="label">年龄（可不填）</label>
            <input className="input" value={edits.age || ''} onChange={(e) => setEdit('age', e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">她的生活设定（学业/工作/兴趣，会让她更像真人）</label>
          <input className="input" value={edits.occupation || ''} onChange={(e) => setEdit('occupation', e.target.value)} placeholder="比如：在读研究生，喜欢摄影和猫" />
        </div>
        <div>
          <label className="label">你们的共同故事（会写进她的自我认知）</label>
          <textarea className="textarea" rows={3} value={edits.self_story || ''} onChange={(e) => setEdit('self_story', e.target.value)} />
        </div>
        <button className="btn" onClick={() => post({ action: 'set_persona', ...edits }, '已保存她的身份')}>
          保存
        </button>
      </div>
    </Card>
  );
}