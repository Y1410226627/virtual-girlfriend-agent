'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { withCompanionQuery, companionReadKey } from '@/components/chat/companion-query';

interface MessageRow {
  id?: number | string;
  role?: string;
}

const ITEMS = [
  { href: '/', label: '聊天', icon: '💬' },
  { href: '/groups', label: '群聊', icon: '👥' },
  { href: '/activities', label: '活动', icon: '🎡' },
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
  const [groupUnread, setGroupUnread] = useState(0);
  // 当前聊天对象（与聊天页同源：URL ?companionId= → localStorage）——未读按伴侣分别计算
  const [companionId, setCompanionId] = useState(1);

  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get('companionId');
      const ls = window.localStorage.getItem('companionId');
      setCompanionId(Math.trunc(Number(q || ls || 1)) || 1);
    } catch {
      /* ignore */
    }
  }, [pathname]);

  /* 未读红点：一律以本地 lastReadMsgId 为准（该值只有聊天页真正加载成功后才写入），
     所以"进了聊天页但消息加载失败"时红点不会被丢掉。不在此处无条件清零。 */
  useEffect(() => {
    let stopped = false;
    const checkMessages = async () => {
      try {
        const lastRead = Number(window.localStorage.getItem(companionReadKey(companionId)) || 0);
        let after = lastRead;
        let n = 0;
        // 分页拉取未读：单页 limit 太小会系统性少报（显示封顶 9+，够 10 条即可停）
        for (let page = 0; page < 5; page++) {
          const r = await fetch(withCompanionQuery(`/api/messages?afterId=${after}&limit=100`, companionId), { cache: 'no-store' });
          const j = await r.json();
          const msgs = (j?.messages || []) as MessageRow[];
          for (const m of msgs) {
            const id = Number(m.id);
            if (m.role === 'assistant' && id > lastRead) n++;
            if (Number.isInteger(id) && id > after) after = id;
          }
          if (msgs.length < 100 || n >= 10) break;
        }
        if (!stopped) setUnread(n);
      } catch {
        /* ignore */
      }
    };
    // 群聊未读：每个群「最后一条群消息 id > 本地已读」即算有新消息，未读群数封顶 9+
    const checkGroups = async () => {
      try {
        const r = await fetch('/api/groups', { cache: 'no-store' });
        const j = await r.json();
        const groups = Array.isArray(j?.groups)
          ? (j.groups as Array<{ id?: number; lastMessageId?: number }>)
          : [];
        let n = 0;
        for (const g of groups) {
          const id = Number(g?.id);
          if (!Number.isInteger(id) || id <= 0) continue;
          const lastRead = Number(window.localStorage.getItem(`groupRead:${id}`) || 0);
          if (Number(g?.lastMessageId || 0) > lastRead) n++;
        }
        if (!stopped) setGroupUnread(n);
      } catch {
        /* ignore */
      }
    };
    void checkMessages();
    void checkGroups();
    // 在聊天/群聊页更勤一点，让"加载成功后红点消失"来得更快（失败则继续保留）
    const fast = pathname === '/' || pathname.startsWith('/groups');
    const t = setInterval(() => {
      void checkMessages();
      void checkGroups();
    }, fast ? 15000 : 60000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [pathname, companionId]);

  const badge = (href: string) => {
    const count = href === '/' ? unread : href === '/groups' ? groupUnread : 0;
    if (count <= 0) return null;
    const label = href === '/groups' ? `有 ${count} 个群有新消息` : `有 ${count} 条未读消息`;
    return (
      <span className="absolute -right-2 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-medium leading-none text-white shadow-bubble">
        <span aria-hidden>{count > 9 ? '9+' : count}</span>
        {/* 挂在 aria-hidden 图标外的可读文本：读屏能把未读数并入链接名称 */}
        <span className="sr-only">{label}</span>
      </span>
    );
  };

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
            href={withCompanionQuery(it.href, companionId)}
            aria-current={isActive(it.href) ? 'page' : undefined}
            className={`flex items-center gap-3 rounded-2xl px-3.5 py-2.5 text-sm transition ${
              isActive(it.href)
                ? 'bg-rose-500 text-white shadow-bubble'
                : 'ink-2 hover:accent-soft'
            }`}
          >
            <span className="relative text-base">
              <span aria-hidden>{it.icon}</span>
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
              href={withCompanionQuery(it.href, companionId)}
              aria-current={isActive(it.href) ? 'page' : undefined}
              className={`flex min-w-[62px] flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] ${
                isActive(it.href) ? 'acc font-medium' : 'ink-2'
              }`}
            >
              <span className="relative text-lg leading-none">
                <span aria-hidden>{it.icon}</span>
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