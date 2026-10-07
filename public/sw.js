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

// 页面通过 postMessage({type:'notify', title, body, url}) 触发通知
// url（可选）：点击通知要去的页面（如 /?companionId=2 —— 有未读的那个伴侣）；缺省 '/'
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
      data: { url: data.url || '/' },
    })
  );
});

// 点击通知：优先导航到通知携带的目标页（有未读的那个伴侣），向后兼容无 data.url 的旧通知（回退 '/'）
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (let i = 0; i < clientList.length; i++) {
          const c = clientList[i];
          if ('focus' in c) {
            // 能原地导航就导航（把已有窗口带到目标伴侣），否则只聚焦
            if ('navigate' in c) {
              return c.navigate(new URL(targetUrl, self.location.origin).href)
                .then(() => c.focus())
                .catch(() => c.focus());
            }
            return c.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      })
  );
});