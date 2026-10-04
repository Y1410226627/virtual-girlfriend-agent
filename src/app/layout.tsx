import type { Metadata, Viewport } from 'next';
import './globals.css';
import Nav from '@/components/Nav';
import StartupSplash from '@/components/StartupSplash';
import NotifyWatcher from '@/components/NotifyWatcher';

export const metadata: Metadata = {
  title: '她 · 虚拟女友',
  description: '一个有长期记忆、会慢慢长成自己性格的虚拟女友',
  // manifest 由 app/manifest.ts 自动注入；这里只补 iOS 添加到主屏用的图标
  icons: { apple: '/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5, // 允许缩放（无障碍：不要锁死用户的双指缩放）
  // 主题色随系统深浅色切换（浅色奶白 / 深色暗玫瑰）
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FFF9F5' },
    { media: '(prefers-color-scheme: dark)', color: '#191216' },
  ],
};

// 防闪烁：渲染前读取 localStorage 的 theme（缺省跟随系统），立即给 <html> 加/去 dark
const THEME_INIT = `(function(){try{var t=localStorage.getItem('theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="font-sans">
        {/* 主题初始化脚本：必须是 body 内第一个节点，先于内容渲染执行，避免闪白/闪暗 */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <StartupSplash />
        {/* 后台消息桌面通知：不渲染任何 UI */}
        <NotifyWatcher />
        <div className="mx-auto flex min-h-screen w-full max-w-6xl">
          <Nav />
          <main className="flex-1 min-w-0 pb-24 md:pb-0 md:pl-60">{children}</main>
        </div>
      </body>
    </html>
  );
}