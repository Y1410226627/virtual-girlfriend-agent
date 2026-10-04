import type { MetadataRoute } from 'next';

// PWA 清单：让应用可以被"添加到主屏幕 / 安装为应用"
// 注：Next 15 检测到 app/manifest.ts 会自动注入 <link rel="manifest" href="/manifest.webmanifest">，无需在 layout 手动添加
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '她 · 虚拟女友',
    short_name: '她',
    // 复用 layout.tsx 里的 description
    description: '一个有长期记忆、会慢慢长成自己性格的虚拟女友',
    start_url: '/',
    display: 'standalone',
    background_color: '#FFF9F5',
    theme_color: '#f65c8a',
    lang: 'zh-CN',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      // Next 的 ManifestIcon.purpose 类型只接受 'any' | 'maskable' | 'monochrome'（不接受空格组合串），
      // 故用两条同源图标分别声明 'any' 与 'maskable'，语义等价于 'any maskable'
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}