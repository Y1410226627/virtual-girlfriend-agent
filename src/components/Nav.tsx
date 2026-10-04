'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const ITEMS = [
  { href: '/', label: '聊天', icon: '💬' },
  { href: '/world', label: '世界', icon: '🌤' },
  { href: '/relationship', label: '关系', icon: '💗' },
  { href: '/intimacy', label: '亲密', icon: '🔥' },
  { href: '/personality', label: '性格', icon: '🌱' },
  { href: '/attachment', label: '依恋', icon: '🫧' },
  { href: '/memories', label: '记忆', icon: '📖' },
  { href: '/story', label: '纪念册', icon: '📔' },
  { href: '/settings', label: '设置', icon: '⚙️' },
];

export default function Nav() {
  const pathname = usePathname();
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const [unread, setUnread] = useState(0);

  /* 未读红点：不在聊天页时每 60s 拉一次"她是否又发来了新消息" */
  useEffect(() => {
    if (pathname === '/') {
      setUnread(0);
      return;
    }
    let stopped = false;
    const check = async () => {
      try {
        const lastRead = Number(window.localStorage.getItem('lastReadMsgId') || 0);
        const r = await fetch(`/api/messages?afterId=${lastRead}&limit=20`, { cache: 'no-store' });
        const j = await r.json();
        const n = (j?.messages || []).filter((m: any) => m.role === 'assistant' && Number(m.id) > lastRead).length;
        if (!stopped) setUnread(n);
      } catch {
        /* ignore */
      }
    };
    check();
    const t = setInterval(check, 60000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [pathname]);

  const badge = (href: string) =>
    href === '/' && unread > 0 ? (
      <span className="absolute -right-2 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-medium leading-none text-white shadow-bubble">
        {unread > 9 ? '9+' : unread}
      </span>
    ) : null;

  return (
    <>
      {/* 桌面端侧边栏 */}
      <aside aria-label="主导航" className="hidden md:flex fixed left-0 top-0 h-screen w-60 flex-col gap-1 border-r line surf-2 backdrop-blur px-4 py-6">
        <div className="px-2 pb-4">
          <div className="text-lg font-semibold acc">她</div>
          <div className="dim mt-0.5">会慢慢长成自己的性格</div>
        </div>
        {ITEMS.map((it) => (
          <Link
            key={it.href}
            href={it.href}
            aria-current={isActive(it.href) ? 'page' : undefined}
            className={`flex items-center gap-3 rounded-2xl px-3.5 py-2.5 text-sm transition ${
              isActive(it.href)
                ? 'bg-rose-500 text-white shadow-bubble'
                : 'ink-2 hover:accent-soft'
            }`}
          >
            <span className="relative text-base" aria-hidden>
              {it.icon}
              {badge(it.href)}
            </span>
            {it.label}
          </Link>
        ))}
        <div className="mt-auto px-3 text-[11px] leading-relaxed ink-3">
          所有数据都存在你自己电脑的本地数据库里，可随时查看、编辑、删除。
        </div>
      </aside>

      {/* 移动端底部导航（可横向滚动，页面多了也不会挤） */}
      <nav aria-label="主导航" className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t line surf backdrop-blur">
        <div className="flex items-stretch overflow-x-auto">
          {ITEMS.map((it) => (
            <Link
              key={it.href}
              href={it.href}
              aria-current={isActive(it.href) ? 'page' : undefined}
              className={`flex min-w-[62px] flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] ${
                isActive(it.href) ? 'acc font-medium' : 'ink-2'
              }`}
            >
              <span className="relative text-lg leading-none" aria-hidden>
                {it.icon}
                {badge(it.href)}
              </span>
              {it.label}
            </Link>
          ))}
        </div>
      </nav>
    </>
  );
}