'use client';

import { Card } from '@/components/ui';
import type { PostFn } from './shared';

export function TestCard({ busy, post, illness, illnessDay }: { busy: boolean; post: PostFn; illness: string; illnessDay?: number }) {
  // 服务端 startIllness 是覆盖式（重置 illness_start 与病程天数），她已在生病时再点等于延长病程；
  // 这里直接用世界页传来的健康状态禁用按钮并说明原因，比 confirm 更清晰、也从根本上避免误延长。
  const sick = !!illness && illness !== 'none';
  return (
    <Card title="测试用（想看她不同状态时的反应）">
      <div className="flex flex-wrap gap-2">
        <button
          className="btn-ghost"
          disabled={busy || sick}
          title={sick ? '她正在生病中，先让她痊愈再重新测试' : undefined}
          onClick={() => {
            post({ action: 'set_illness', kind: '感冒', days: 3 }, '她感冒了（3 天）');
          }}
        >
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
      {sick ? <p className="dim mt-2">她现在正在生病（第 {illnessDay || 1} 天）。想重新测试请先点「让她痊愈」，避免误把病程延长。</p> : null}
      <p className="dim mt-2">这些只是让你立刻看到不同状态下的她，平时她的状态由时间和你们相处自然推进。</p>
    </Card>
  );
}