'use client';

import { useEffect, useRef, useState } from 'react';
import { withCompanionQuery } from '@/components/chat/companion-query';

/* 她的照片弹层：打开时请求 /api/photo，Esc 关闭（原 page.tsx 逻辑原样搬移） */
export function usePhoto(companionId = 1) {
  const [photoOpen, setPhotoOpen] = useState(false);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoSrc, setPhotoSrc] = useState<string | null>(null);
  const [photoCaption, setPhotoCaption] = useState('');
  const reqSeqRef = useRef(0); // 请求 token：快速重复打开时只认最新一次响应，避免旧响应盖掉新请求

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
    const seq = ++reqSeqRef.current; // 本次请求 token
    setPhotoOpen(true);
    setPhotoLoading(true);
    setPhotoSrc(null);
    setPhotoCaption('');
    try {
      const r = await fetch(withCompanionQuery('/api/photo', companionId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (seq !== reqSeqRef.current) return; // 已被更新的一次打开取代：丢弃本次结果
      setPhotoSrc(j?.image || j?.imageUrl || '/splash-girl.jpg');
      setPhotoCaption(j?.caption || '');
    } catch {
      if (seq !== reqSeqRef.current) return;
      setPhotoSrc('/splash-girl.jpg');
      setPhotoCaption('（她今天不太想拍照…）');
    } finally {
      if (seq === reqSeqRef.current) setPhotoLoading(false);
    }
  };

  return { photoOpen, setPhotoOpen, photoLoading, photoSrc, photoCaption, openPhoto };
}