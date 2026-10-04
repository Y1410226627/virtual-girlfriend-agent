/* eslint-disable */
// 极简 Service Worker —— 仅用于：1) PWA 安装资格  2) 页面在后台时弹出桌面通知
// 刻意不做任何缓存/离线逻辑，避免影响现有页面行为

self.addEventListener('install', () => {
  // 新 SW 立即接管
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // 立即接管未受控的页面
  event.waitUntil(self.clients.claim());
});

// 页面通过 postMessage({type:'notify', title, body}) 触发通知
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'notify') return;
  const title = data.title || '她';
  const body = data.body || '';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'gf-message',
    })
  );
});

// 点击通知：聚焦已打开的窗口（或用 '/' 打开新窗口）
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (let i = 0; i < clientList.length; i++) {
          const c = clientList[i];
          if ('focus' in c) return c.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow('/');
      })
  );
});