'use client';

import { Card } from '@/components/ui';
import type { SaveFn } from './shared';

export function SceneCard({ form, save }: { form: Record<string, string>; save: SaveFn }) {
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
            // 提交"目标值"（overrides）：save() 读的是 setState 之前的旧 form，直接传目标值避免旧值回写。
            // 统一走同一保存路径（含失败提示与 reload）。
            onClick={() => void save(['scene_mode'], `场景已设为：${label}`, { scene_mode: k })}
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