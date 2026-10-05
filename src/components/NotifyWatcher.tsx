'use client';

import { useEffect } from 'react';

// 主动消息的桌面通知：
// 页面处于后台标签 / 最小化时，轮询她的新消息，用系统通知提醒你。
// 所有浏览器能力都做了静默降级——不支持 SW / 非安全上下文（如局域网 http）/ 权限未授予 / 用户关闭，
// 都直接什么都不做，绝不报错、绝不阻塞界面。

const POLL_MS = 60_000; // 每 60 秒轮询一次
const MAX_LEN = 60; // 通知正文最大字数

interface MessageRow {
  id?: number | string;
  role?: string;
  content?: string;
}

// 去掉 [[sticker:xx]] 标记、压缩空白，并截断到 60 字
function cleanText(raw: string): string {
  const s = String(raw || '')
    .replace(/\[\[\s*(?:sticker|表情包)\s*[:：]?\s*[a-z_]+\s*\]\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > MAX_LEN ? s.slice(0, MAX_LEN) + '…' : s;
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

    const readLastId = (): number => {
      try {
        return Number(window.localStorage.getItem('lastNotifiedMsgId')) || 0;
      } catch {
        return 0;
      }
    };
    const writeLastId = (id: number) => {
      try {
        window.localStorage.setItem('lastNotifiedMsgId', String(id));
      } catch {
        /* ignore */
      }
    };

    // 优先用 Service Worker 的 showNotification，失败回退到页面级 new Notification
    const showNotification = async (title: string, body: string) => {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          await reg.showNotification(title, {
            body,
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            tag: 'gf-message',
          });
          return;
        }
      } catch {
        /* 回退 */
      }
      try {
        new Notification(title, { body, icon: '/icon-192.png', tag: 'gf-message' });
      } catch {
        /* ignore */
      }
    };

    const poll = async () => {
      const lastId = readLastId();
      let rows: MessageRow[] = [];
      try {
        const r = await fetch(`/api/messages?afterId=${lastId}&limit=20`, { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        rows = Array.isArray(j?.messages) ? j.messages : [];
      } catch {
        return; // 网络失败：静默跳过，下一轮再试
      }
      if (stopped) return;

      // 只看在游标之后、她（assistant）发来的新消息
      const hers = rows.filter((m) => m && m.role === 'assistant' && Number(m.id) > lastId);
      if (hers.length === 0) return;

      let maxId = lastId;
      let latest = hers[0]!;
      for (const m of hers) {
        const id = Number(m.id) || 0;
        if (id > maxId) maxId = id;
        if (Number(m.id) > Number(latest.id)) latest = m;
      }

      const hidden =
        typeof document !== 'undefined' && (document.hidden || document.visibilityState !== 'visible');
      let enabled = false;
      try {
        enabled = window.localStorage.getItem('notify_enabled') === '1';
      } catch {
        /* ignore */
      }

      // 页面不可见 + 权限已授予 + 用户开关打开 → 通知（只发最新一条，避免刷屏）
      if (hidden && Notification.permission === 'granted' && enabled) {
        const body = cleanText(latest?.content ?? '');
        await showNotification('她', body || '给你发来一条消息');
      }
      // 页面可见 / 未开启通知：只推进游标，不打扰
      writeLastId(maxId);
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