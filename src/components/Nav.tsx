'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/', label: '聊天', icon: '💬' },
  { href: '/world', label: '世界', icon: '🌤' },
  { href: '/relationship', label: '关系', icon: '💗' },
  { href: '/intimacy', label: '亲密', icon: '🔥' },
  { href: '/personality', label: '性格', icon: '🌱' },
  { href: '/attachment', label: '依恋', icon: '🫧' },
  { href: '/memories', label: '记忆', icon: '📖' },
  { href: '/settings', label: '设置', icon: '⚙️' },
];

export default function Nav() {
  const pathname = usePathname();
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <>
      {/* 桌面端侧边栏 */}
      <aside aria-label="主导航" className="hidden md:flex fixed left-0 top-0 h-screen w-60 flex-col gap-1 border-r border-rose-100/80 bg-white/60 backdrop-blur px-4 py-6">
        <div className="px-2 pb-4">
          <div className="text-lg font-semibold text-rose-600">她</div>
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
                : 'text-ink-700 hover:bg-rose-50'
            }`}
          >
            <span className="text-base" aria-hidden>{it.icon}</span>
            {it.label}
          </Link>
        ))}
        <div className="mt-auto px-3 text-[11px] leading-relaxed text-ink-300">
          所有数据都存在你自己电脑的本地数据库里，可随时查看、编辑、删除。
        </div>
      </aside>

      {/* 移动端底部导航（可横向滚动，页面多了也不会挤） */}
      <nav aria-label="主导航" className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-rose-100 bg-white/90 backdrop-blur">
        <div className="flex items-stretch overflow-x-auto">
          {ITEMS.map((it) => (
            <Link
              key={it.href}
              href={it.href}
              aria-current={isActive(it.href) ? 'page' : undefined}
              className={`flex min-w-[62px] flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] ${
                isActive(it.href) ? 'text-rose-600 font-medium' : 'text-ink-500'
              }`}
            >
              <span className="text-lg leading-none" aria-hidden>{it.icon}</span>
              {it.label}
            </Link>
          ))}
        </div>
      </nav>
    </>
  );
}