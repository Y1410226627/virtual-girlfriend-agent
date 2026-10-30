'use client';

import { Card, Chip } from '@/components/ui';
import { SKINS, skinName, type SkinId } from '@/lib/skins';

export function AppearanceCard({
  theme,
  onApplyTheme,
  skin,
  onApplySkin,
}: {
  theme: 'light' | 'dark';
  onApplyTheme: (t: 'light' | 'dark') => void;
  skin: SkinId;
  onApplySkin: (s: SkinId) => void;
}) {
  return (
    <Card title="外观">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2" role="radiogroup" aria-label="外观主题">
          <button
            className={theme === 'light' ? 'btn' : 'btn-ghost'}
            role="radio"
            aria-checked={theme === 'light'}
            onClick={() => onApplyTheme('light')}
          >
            浅色
          </button>
          <button
            className={theme === 'dark' ? 'btn' : 'btn-ghost'}
            role="radio"
            aria-checked={theme === 'dark'}
            onClick={() => onApplyTheme('dark')}
          >
            深色
          </button>
        </div>
        <Chip tone="plain">当前：{theme === 'dark' ? '深色' : '浅色'}</Chip>
      </div>
      <p className="dim mt-3 leading-relaxed">默认跟随系统深浅色；在这里选择后会记住你的偏好，下次打开仍然生效。</p>

      <div className="mt-5 border-t line pt-4">
        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="配色皮肤">
          <span className="label !mb-0 !mr-1">配色皮肤</span>
          {SKINS.map((s) => (
            <button
              key={s.id}
              className={`${skin === s.id ? 'btn' : 'btn-ghost'} !px-3 !py-1.5 text-xs`}
              role="radio"
              aria-checked={skin === s.id}
              onClick={() => onApplySkin(s.id)}
            >
              <span
                aria-hidden
                className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-middle"
                style={{ background: s.dot }}
              />
              {s.name}
            </button>
          ))}
          <Chip tone="plain">当前：{skinName(skin)}</Chip>
        </div>
        <p className="dim mt-2 leading-relaxed">四套配色都同时适配浅色/深色模式；选择只保存在这台设备。</p>
      </div>
    </Card>
  );
}
