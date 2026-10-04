import type { Metadata, Viewport } from 'next';
import './globals.css';
import Nav from '@/components/Nav';
import StartupSplash from '@/components/StartupSplash';

export const metadata: Metadata = {
  title: '她 · 虚拟女友',
  description: '一个有长期记忆、会慢慢长成自己性格的虚拟女友',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#FFF9F5',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="font-sans">
        <StartupSplash />
        <div className="mx-auto flex min-h-screen w-full max-w-6xl">
          <Nav />
          <main className="flex-1 min-w-0 pb-24 md:pb-0 md:pl-60">{children}</main>
        </div>
      </body>
    </html>
  );
}