'use client';

import { Card } from '@/components/ui';
import type { Edits, PostFn } from './shared';

export function NicknameCard({
  edits,
  setEdit,
  post,
}: {
  edits: Edits;
  setEdit: (k: keyof Edits, v: string | number) => void;
  post: PostFn;
}) {
  return (
    <Card title="你们之间的称呼与日子">
      <div className="space-y-3">
        <div>
          <label className="label">你叫她什么 / 她叫你什么</label>
          <input className="input" value={edits.nickname || ''} onChange={(e) => setEdit('nickname', e.target.value)} placeholder="比如：小满 / 笨蛋" />
          <button className="btn mt-2" onClick={() => post({ action: 'set_nickname', nickname: edits.nickname }, '已更新昵称')}>
            保存昵称
          </button>
        </div>
        <div>
          <label className="label">重要日子（在一起的日子）</label>
          <input className="input" type="date" value={edits.anniversary || ''} onChange={(e) => setEdit('anniversary', e.target.value)} />
          <button className="btn mt-2" onClick={() => post({ action: 'set_anniversary', anniversary: edits.anniversary }, '已记录')}>
            保存日期
          </button>
        </div>
      </div>
    </Card>
  );
}