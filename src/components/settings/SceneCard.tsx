'use client';

import { Card } from '@/components/ui';
import type { SetFieldFn, SetToast } from './shared';

export function SceneCard({
  form,
  set,
  setToast,
  reload,
}: {
  form: Record<string, string>;
  set: SetFieldFn;
  setToast: SetToast;
  reload: () => void;
}) {
  return (
    <Card title="场景（线上聊天 / 线下相处）">
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ['auto', '自动识别'],
            ['online', '一直线上'],
            ['offline', '一直线下'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            aria-pressed={(form.scene_mode || 'auto') === k}
            className={(form.scene_mode || 'auto') === k ? 'btn' : 'btn-ghost'}
            onClick={async () => {
              // 直接提交目标值：save() 里读的是 setState 之前的旧 form，先 set 再 save 会把旧值存回去
              set('scene_mode', k);
              await fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings: { scene_mode: k } }),
              })
                .then((r) => {
                  if (!r.ok) throw new Error(`保存失败 ${r.status}`);
                  setToast(`场景已设为：${label}`);
                  reload();
                })
                .catch((e) => setToast(`保存失败：${e?.message || e}`));
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="dim mt-3 leading-relaxed">
        自动识别：规则先判（牵手、抱着、坐旁边…→ 线下；发消息、回我、屏幕…→ 线上），后台分析再用上下文校正。
        手动指定时优先级最高，不会被识别覆盖。聊天页右上角也有同样的开关。
      </p>
    </Card>
  );
}