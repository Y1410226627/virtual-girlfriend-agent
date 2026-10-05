'use client';

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/* 表情面板：开关状态、点外部/Esc 收起、选中后把 token 追加进输入框（原 page.tsx 逻辑原样搬移） */
export function useSticker(setInput: Dispatch<SetStateAction<string>>) {
  const [stickerOpen, setStickerOpen] = useState(false);
  const stickerPanelRef = useRef<HTMLDivElement>(null); // 表情面板（点外部关闭）
  const stickerBtnRef = useRef<HTMLButtonElement>(null); // 表情按钮（点它不算外部）

  /* 表情面板：点面板/按钮之外的地方，或按 Esc 都收起 */
  useEffect(() => {
    if (!stickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStickerOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (stickerPanelRef.current?.contains(t) || stickerBtnRef.current?.contains(t)) return;
      setStickerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [stickerOpen]);

  /* 表情面板选一个：把 token 追加进输入框（不直接发送），然后收起面板 */
  const insertSticker = (id: string) => {
    const token = `[[sticker:${id}]]`;
    setInput((cur) => (cur && !cur.endsWith(' ') ? `${cur} ${token}` : `${cur}${token}`));
    setStickerOpen(false);
  };

  return { stickerOpen, setStickerOpen, stickerPanelRef, stickerBtnRef, insertSticker };
}