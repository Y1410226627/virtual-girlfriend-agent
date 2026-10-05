'use client';

import { Card, Chip } from '@/components/ui';

export function NotificationCard({
  notifyStatusText,
  notifyOn,
  toggleNotify,
  notifyPerm,
  notifySupported,
}: {
  notifyStatusText: string;
  notifyOn: boolean;
  toggleNotify: () => void;
  notifyPerm: NotificationPermission;
  notifySupported: boolean | null;
}) {
  return (
    <Card title="通知" right={<Chip tone="plain">状态：{notifyStatusText}</Chip>}>
      <p className="dim leading-relaxed">她不看页面时发来消息，用系统通知告诉你（仅在这台设备上）。</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className={notifyOn ? 'btn' : 'btn-ghost'}
          onClick={toggleNotify}
          disabled={notifySupported === false}
          aria-pressed={notifyOn}
        >
          {notifyOn ? '已开启（点击关闭）' : '开启桌面通知'}
        </button>
        {notifyPerm === 'denied' ? <Chip tone="plain">权限被拒绝，请在浏览器设置里允许</Chip> : null}
        {notifySupported === false ? <Chip tone="plain">当前浏览器不支持，此开关不可用</Chip> : null}
      </div>
    </Card>
  );
}