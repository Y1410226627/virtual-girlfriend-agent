'use client';

import { Card } from '@/components/ui';
import type { SaveFn, SetFieldFn } from './shared';

export function IdentityCard({
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
    <Card title="你们的身份">
      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <label className="label" htmlFor="agent_name">她叫什么（留空则让她问你）</label>
          <input id="agent_name" className="input" value={form.agent_name ?? ''} onChange={(e) => set('agent_name', e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="user_name">你怎么称呼</label>
          <input id="user_name" className="input" value={form.user_name ?? ''} onChange={(e) => set('user_name', e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="personality_openness">性格开放度（1 = 正常，0 = 性格锁死）</label>
          <input id="personality_openness" className="input" type="number" step="0.1" min={0} max={2} value={form.personality_openness ?? '1'} onChange={(e) => set('personality_openness', e.target.value)} />
        </div>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <label className="label" htmlFor="user_profile">关于你（她的用户画像）</label>
          <textarea id="user_profile" className="textarea" rows={3} value={form.user_profile ?? ''} onChange={(e) => set('user_profile', e.target.value)} placeholder="专业、工作、性格、喜好、最近在忙什么…" />
        </div>
        <div>
          <label className="label" htmlFor="agent_story">你们的共同故事（她的自我认知）</label>
          <textarea id="agent_story" className="textarea" rows={3} value={form.agent_story ?? ''} onChange={(e) => set('agent_story', e.target.value)} placeholder="她是谁、在哪、做什么、喜欢什么…" />
        </div>
      </div>
      <button className="btn mt-3" onClick={() => save(['agent_name', 'user_name', 'personality_openness', 'user_profile', 'agent_story'], '已保存身份信息')} disabled={saving}>
        保存
      </button>
    </Card>
  );
}