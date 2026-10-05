'use client';

import { Card, Chip } from '@/components/ui';

export function AppearanceCard({ theme, onApplyTheme }: { theme: 'light' | 'dark'; onApplyTheme: (t: 'light' | 'dark') => void }) {
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
    </Card>
  );
}