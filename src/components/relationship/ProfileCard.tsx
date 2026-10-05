'use client';

import { Card } from '@/components/ui';
import type { Edits, PostFn } from './shared';

export function ProfileCard({
  edits,
  setEdit,
  post,
}: {
  edits: Edits;
  setEdit: (k: keyof Edits, v: string | number) => void;
  post: PostFn;
}) {
  return (
    <Card title="你的画像（她眼中的你）" className="md:col-span-2">
      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <label className="label">你的称呼</label>
          <input className="input" value={edits.user_name || ''} onChange={(e) => setEdit('user_name', e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <label className="label">关于你（她会在聊天中参考这一段）</label>
          <textarea
            className="textarea"
            rows={2}
            placeholder="比如：在读文学专业，最近在准备考试，喜欢咖啡、讨厌香菜，不太会主动表达情绪"
            value={edits.user_profile || ''}
            onChange={(e) => setEdit('user_profile', e.target.value)}
          />
        </div>
      </div>
      <button className="btn mt-3" onClick={() => post({ action: 'set_user', user_name: edits.user_name, user_profile: edits.user_profile }, '已保存')}>
        保存
      </button>
    </Card>
  );
}