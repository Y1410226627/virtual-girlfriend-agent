'use client';

import { useEffect } from 'react';
import { withCompanionQuery } from '@/components/chat/companion-query';

// 主动消息的桌面通知（跨伴侣）：
// 页面处于后台标签 / 最小化时，轮询"她/她们"的新消息，用系统通知提醒你。
//
// 多女友隔离要点：原来是裸查 `/api/messages?afterId=`（只覆盖主女友），新女友的新消息不会提醒。
// 现在先取一次通讯录 `/api/companions`（全局，返回主女友 + 女友），再逐个伴侣查各自的新消息。
//   - 主女友（id=1）沿用旧游标键与旧请求 URL：单女友时**逐字节**与改造前一致（只查一个伴侣）；
//   - 其它伴侣用 `...#c<id>` 游标键，各自独立，谁的新消息最新就通知谁，点击跳转到该伴侣。
// 所有浏览器能力都做了静默降级——不支持 SW / 非安全上下文 / 权限未授予 / 用户关闭，都直接什么都不做。

const POLL_MS = 60_000; // 每 60 秒轮询一次
const MAX_LEN = 60; // 通知正文最大字数

interface MessageRow {
  id?: number | string;
  role?: string;
  content?: string;
}

interface RosterEntry {
  id?: number;
  name?: string;
  displayName?: string;
}

interface RosterView {
  primary?: RosterEntry | null;
  girlfriends?: RosterEntry[];
  pursuing?: RosterEntry[];
  acquaintances?: RosterEntry[];
  pending?: RosterEntry[];
  closed?: RosterEntry[];
}

// 去掉 [[sticker:xx]] 标记、压缩空白，并截断到 60 字
function cleanText(raw: string): string {
  const s = String(raw || '')
    .replace(/\[\[\s*(?:sticker|表情包)\s*[:：]?\s*[a-z_]+\s*\]\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > MAX_LEN ? s.slice(0, MAX_LEN) + '…' : s;
}

/** 需要关心的伴侣：主女友 + 已晋升女友（与后端推进范围 listAdvanceableCompanions 一致），去重按 id 升序 */
function pickCompanions(view: RosterView | null): Array<{ id: number; name: string }> {
  const out: Array<{ id: number; name: string }> = [];
  const seen = new Set<number>();
  const push = (e: RosterEntry | null | undefined) => {
    const id = Math.trunc(Number(e?.id));
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) return;
    seen.add(id);
    out.push({ id, name: String(e?.displayName || e?.name || '她') });
  };
  push(view?.primary);
  for (const g of view?.girlfriends ?? []) push(g);
  return out.sort((a, b) => a.id - b.id);
}

export default function NotifyWatcher() {
  useEffect(() => {
    // 能力检测：缺一即静默退出（不报错）
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
    if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
    if (!window.isSecureContext) return; // localhost / https 之外（如 http://IP:3000）直接放弃

    // 注册 Service Worker（失败静默）
    try {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    } catch {
      /* ignore */
    }

    let stopped = false;

    // 游标按伴侣分键：
    //  - 主女友（id=1）沿用旧键 'gf_notify_seen' / 'gf_notify_last'（零回归，既有游标不丢）
    //  - 其它伴侣用 '...#c<id>'，互不影响
    const seenKey = (id: number) => (id === 1 ? 'gf_notify_seen' : `gf_notify_seen#c${id}`);
    const notifiedKey = (id: number) => (id === 1 ? 'gf_notify_last' : `gf_notify_last#c${id}`);
    const readNum = (key: string): number => {
      try {
        return Number(window.localStorage.getItem(key)) || 0;
      } catch {
        return 0;
      }
    };
    const writeNum = (key: string, id: number) => {
      try {
        window.localStorage.setItem(key, String(id));
      } catch {
        /* ignore */
      }
    };

    // 迁移旧版本游标（lastNotifiedMsgId）：当作"已看过"，避免升级后被历史消息刷屏（作用于主女友的两个游标）
    const legacy = readNum('lastNotifiedMsgId');
    if (legacy) {
      if (!readNum(seenKey(1))) writeNum(seenKey(1), legacy);
      if (!readNum(notifiedKey(1))) writeNum(notifiedKey(1), legacy);
    }

    // 优先用 Service Worker 的 showNotification，失败回退到页面级 new Notification
    // url：点击通知应跳转的目标（有未读的那个伴侣）；sw.js 会读 notification.data.url（旧 SW 忽略，行为不变）
    const showNotification = async (title: string, body: string, url: string) => {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          await reg.showNotification(title, {
            body,
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            tag: 'gf-message',
            data: { url },
          });
          return;
        }
      } catch {
        /* 回退 */
      }
      try {
        const n = new Notification(title, { body, icon: '/icon-192.png', tag: 'gf-message' });
        n.onclick = () => {
          try {
            window.location.href = url;
          } catch {
            /* ignore */
          }
        };
      } catch {
        /* ignore */
      }
    };

    const poll = async () => {
      // 1) 取通讯录 → 需要关心的伴侣（主女友 + 女友）。失败/为空则退回只关心主女友（= 旧行为）。
      let companions: Array<{ id: number; name: string }> = [{ id: 1, name: '她' }];
      try {
        const r = await fetch('/api/companions', { cache: 'no-store' });
        if (r.ok) {
          const j = (await r.json()) as RosterView;
          const picked = pickCompanions(j);
          if (picked.length) companions = picked;
        }
      } catch {
        /* 退回 [主女友] */
      }
      if (stopped) return;

      const hidden =
        typeof document !== 'undefined' && (document.hidden || document.visibilityState !== 'visible');
      let enabled = false;
      try {
        enabled = window.localStorage.getItem('notify_enabled') === '1';
      } catch {
        /* ignore */
      }
      const canNotify = hidden && Notification.permission === 'granted' && enabled;

      // 2) 逐个伴侣拉"游标之后"的新消息，找出全局最新的一条（her = assistant）
      let best: { id: number; name: string; body: string; maxId: number } | null = null;
      const touched: Array<{ id: number; maxId: number }> = [];

      for (const c of companions) {
        // 只关心"两个游标之后的最新消息"（取较大值，避免已看过的又被当成新消息）
        const cursor = Math.max(readNum(seenKey(c.id)), readNum(notifiedKey(c.id)));
        let rows: MessageRow[] = [];
        try {
          const r = await fetch(withCompanionQuery(`/api/messages?afterId=${cursor}&limit=20`, c.id), {
            cache: 'no-store',
          });
          if (!r.ok) continue;
          const j = await r.json();
          rows = Array.isArray(j?.messages) ? j.messages : [];
        } catch {
          continue; // 网络失败：静默跳过，下一轮再试
        }
        if (stopped) return;

        const hers = rows.filter((m) => m && m.role === 'assistant' && Number(m.id) > cursor);
        if (hers.length === 0) continue;

        let maxId = cursor;
        let latest = hers[0]!;
        for (const m of hers) {
          const id = Number(m.id) || 0;
          if (id > maxId) maxId = id;
          if (Number(m.id) > Number(latest.id)) latest = m;
        }
        touched.push({ id: c.id, maxId });
        if (!best || maxId > best.maxId) {
          best = { id: c.id, name: c.name, body: cleanText(latest?.content ?? ''), maxId };
        }
      }

      if (touched.length === 0) return;

      if (canNotify && best) {
        // 页面不可见 + 权限已授予 + 用户开关打开 → 通知（只发最新一条，避免刷屏）
        // 主女友沿用原标题 '她'（单女友零回归）；其它伴侣带上名字，让你知道是谁发来的
        const title = best.id === 1 ? '她' : best.name;
        await showNotification(title, best.body || '给你发来一条消息', withCompanionQuery('/', best.id));
        if (stopped) return;
        // 真正通知了，才把本轮所有有更新的伴侣一起推进 NOTIFIED+SEEN（两个游标一起推进）
        for (const t of touched) {
          writeNum(notifiedKey(t.id), Math.max(readNum(notifiedKey(t.id)), t.maxId));
          writeNum(seenKey(t.id), Math.max(readNum(seenKey(t.id)), t.maxId));
        }
      } else if (!hidden) {
        // 页面可见：他看到了，只推进 SEEN，不推进 NOTIFIED
        // （这样即使现在没开通知，之后开启也不会补推他早就看过的消息）
        for (const t of touched) {
          writeNum(seenKey(t.id), Math.max(readNum(seenKey(t.id)), t.maxId));
        }
      }
      // 页面隐藏但未开启通知 / 权限未授予：两个游标都不推进 → 用户开启通知后仍能补通知，绝不静默吞掉
    };

    void poll(); // 首次加载立即跑一次
    const timer = setInterval(() => void poll(), POLL_MS);

    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  return null; // 不渲染任何东西
}
