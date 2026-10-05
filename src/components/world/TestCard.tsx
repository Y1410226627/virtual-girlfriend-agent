'use client';

import { Card } from '@/components/ui';
import type { PostFn } from './shared';

export function TestCard({ busy, post }: { busy: boolean; post: PostFn }) {
  return (
    <Card title="测试用（想看她不同状态时的反应）">
      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost" disabled={busy} onClick={() => post({ action: 'set_illness', kind: '感冒', days: 3 }, '她感冒了（3 天）')}>
          让她感冒
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => post({ action: 'set_illness', kind: 'none' }, '她恢复了')}>
          让她痊愈
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => post({ action: 'set_cycle', enabled: true, day: 2 }, '设为生理期第 2 天')}>
          设为生理期
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => post({ action: 'set_cycle', enabled: false }, '关闭生理周期')}>
          关闭生理周期
        </button>
      </div>
      <p className="dim mt-2">这些只是让你立刻看到不同状态下的她，平时她的状态由时间和你们相处自然推进。</p>
    </Card>
  );
}