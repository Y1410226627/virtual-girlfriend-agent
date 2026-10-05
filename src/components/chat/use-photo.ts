'use client';

import { useEffect, useState } from 'react';

/* 她的照片弹层：打开时请求 /api/photo，Esc 关闭（原 page.tsx 逻辑原样搬移） */
export function usePhoto() {
  const [photoOpen, setPhotoOpen] = useState(false);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoSrc, setPhotoSrc] = useState<string | null>(null);
  const [photoCaption, setPhotoCaption] = useState('');

  /* 她的照片弹层：Esc 关闭 */
  useEffect(() => {
    if (!photoOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPhotoOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [photoOpen]);

  /* 打开"她的照片"弹层：每次点击都重新请求，失败也显示本地立绘兜底 */
  const openPhoto = async () => {
    setPhotoOpen(true);
    setPhotoLoading(true);
    setPhotoSrc(null);
    setPhotoCaption('');
    try {
      const r = await fetch('/api/photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      setPhotoSrc(j?.image || j?.imageUrl || '/splash-girl.jpg');
      setPhotoCaption(j?.caption || '');
    } catch {
      setPhotoSrc('/splash-girl.jpg');
      setPhotoCaption('（她今天不太想拍照…）');
    } finally {
      setPhotoLoading(false);
    }
  };

  return { photoOpen, setPhotoOpen, photoLoading, photoSrc, photoCaption, openPhoto };
}