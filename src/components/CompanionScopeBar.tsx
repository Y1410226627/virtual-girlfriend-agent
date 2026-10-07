'use client';

// 「当前伴侣」作用域的共享工具与顶部轻量指示条。
//
// 多女友隔离：各功能页（记忆/关系/亲密/性格/世界/依恋/纪念册/设置）都须按当前伴侣取数，
// 并在顶部明确告诉用户"正在查看谁"。本模块集中这两件事，避免每个页面各写一份：
//   - useCompanionId()：照抄 src/app/page.tsx 的来源顺序（URL ?companionId= → localStorage → 缺省 1），
//     在 effect 内读取以避免 SSR/水合不一致；缺省/非法一律回落 1（保证单女友路径零回归）。
//   - <CompanionScopeBar companionId={...} />：非主女友（id !== 1）时渲染"正在查看：X"+「切换伴侣」入口；
//     主女友/单女友路径返回 null（不渲染、不发任何请求），确保既有单女友体验逐字节不变。

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useApi } from '@/components/ui';
import { DEFAULT_COMPANION_ID } from '@/components/chat/companion-query';
import type { RosterView, RosterEntry } from '@/components/companions/shared';

/** 当前聊天对象：URL ?companionId= → localStorage → 缺省主女友（1）。必须在客户端 effect 内读取。 */
export function useCompanionId(): number {
  const [companionId, setCompanionId] = useState<number>(DEFAULT_COMPANION_ID);
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get('companionId');
      const ls = window.localStorage.getItem('companionId');
      setCompanionId(Math.trunc(Number(q || ls || DEFAULT_COMPANION_ID)) || DEFAULT_COMPANION_ID);
    } catch {
      /* ignore */
    }
  }, []);
  return companionId;
}

/** 顶部轻量指示条：主女友（缺省）时不渲染，从而零回归。 */
export function CompanionScopeBar({ companionId }: { companionId: number }) {
  if (!Number.isFinite(companionId) || companionId === DEFAULT_COMPANION_ID) return null;
  return <ScopeBarInner companionId={companionId} />;
}

function ScopeBarInner({ companionId }: { companionId: number }) {
  const { data } = useApi<RosterView>('/api/companions');
  const all: RosterEntry[] = [
    ...(data?.girlfriends ?? []),
    ...(data?.pursuing ?? []),
    ...(data?.acquaintances ?? []),
    ...(data?.primary ? [data.primary] : []),
  ];
  const current = all.find((e) => e.id === companionId) ?? null;
  const name = current?.displayName || current?.name || `#${companionId}`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 md:px-8">
      <span className="dim text-xs">
        正在查看：<span className="acc font-medium">{name}</span>
      </span>
      <Link href="/companions" className="btn-ghost !px-2.5 !py-1 text-xs">
        切换伴侣 →
      </Link>
    </div>
  );
}
