'use client';

import { useEffect, useRef, useState } from 'react';
import { useApi, Chip } from '@/components/ui';
import { statusLabelOf, type RosterView, type RosterEntry } from './shared';

/**
 * 聊天主页顶部「伴侣切换器」：点开弹出通讯录，选择后切换当前聊天对象。
 * 说明：本组件自包含（自取 roster）；接入聊天主页由 T05 负责（传 currentId / onSwitch）。
 * 未传 onSwitch 时默认写 localStorage('companionId') 并以查询参数跳转。
 */
export function CompanionSwitcher({
  currentId = 1,
  onSwitch,
  onOpenRoster,
}: {
  currentId?: number;
  onSwitch?: (id: number) => void;
  onOpenRoster?: () => void;
}) {
  const { data } = useApi<RosterView>('/api/companions');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const all: RosterEntry[] = [
    ...(data?.girlfriends ?? []),
    ...(data?.pursuing ?? []),
    ...(data?.acquaintances ?? []),
    ...(data?.primary ? [data.primary] : []),
  ];
  const current = all.find((e) => e.id === currentId) ?? data?.primary ?? null;

  const select = (id: number) => {
    setOpen(false);
    if (onSwitch) {
      onSwitch(id);
      return;
    }
    try {
      window.localStorage.setItem('companionId', String(id));
    } catch {
      /* ignore */
    }
    window.location.href = `/?companionId=${id}`;
  };

  return (
    <div className="relative" ref={boxRef}>
      <button
        className="btn-ghost"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="切换伴侣"
      >
        <span aria-hidden>💞</span>
        <span className="max-w-[7rem] truncate">{current ? current.displayName : '她'}</span>
        <span className="ink-3" aria-hidden>
          ▾
        </span>
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute right-0 z-30 mt-2 w-72 rounded-2xl surf border line p-2 shadow-soft backdrop-blur"
        >
          {all.length ? (
            all.map((e) => (
              <button
                key={e.id}
                role="option"
                aria-selected={e.id === currentId}
                className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm transition ${
                  e.id === currentId ? 'accent-soft acc' : 'ink-2 hover:accent-soft'
                }`}
                onClick={() => select(e.id)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{e.displayName}</span>
                  {e.unread > 0 ? (
                    <span className="rounded-full bg-rose-500 px-1.5 text-[10px] text-white">{e.unread > 9 ? '9+' : e.unread}</span>
                  ) : null}
                </span>
                <Chip tone={e.status === 'girlfriend' ? 'rose' : 'plain'}>{statusLabelOf(e.status, e.statusLabel)}</Chip>
              </button>
            ))
          ) : (
            <div className="dim px-3 py-2">通讯录里还没有别人</div>
          )}
          {onOpenRoster ? (
            <button className="mt-1 w-full rounded-xl px-3 py-2 text-left text-xs acc hover:accent-soft" onClick={onOpenRoster}>
              打开通讯录 →
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
