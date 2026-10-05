'use client';

import { useEffect, useRef } from 'react';

/* 弹层内可聚焦元素选择器（禁用元素与 tabindex=-1 的元素排除在外） */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 最小焦点陷阱：弹层打开时把焦点移入，Tab / Shift+Tab 在弹层内循环，
 * 关闭后把焦点还原到打开前的元素。
 * @param active 弹层是否打开
 * @param containerRef 弹层容器（通常就是 role="dialog" 的那个元素）
 * @param initialFocusRef 可选：打开时优先聚焦的元素（默认取容器内首个可聚焦元素）
 * @param onEscape 可选：按下 Escape 时的回调
 */
export function useFocusTrap({
  active,
  containerRef,
  initialFocusRef,
  onEscape,
}: {
  active: boolean;
  containerRef: React.RefObject<HTMLElement | null>;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  onEscape?: () => void;
}) {
  // 用 ref 保存最新回调：避免 onEscape 每次渲染变化导致陷阱重复挂载、还原焦点出错
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    // 打开前的活动元素，关闭后还原到它
    const previous = document.activeElement as HTMLElement | null;
    const getFocusable = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    (initialFocusRef?.current ?? getFocusable()[0])?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (onEscapeRef.current) {
          e.preventDefault();
          onEscapeRef.current();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const items = getFocusable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const last = items.length - 1;
      if (e.shiftKey) {
        if (idx <= 0) {
          e.preventDefault();
          items[last]?.focus();
        }
      } else if (idx === last || idx === -1) {
        e.preventDefault();
        items[0]?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);

    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus();
    };
  }, [active, containerRef, initialFocusRef]);
}