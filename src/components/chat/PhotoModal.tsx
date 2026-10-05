'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusTrap } from './use-focus-trap';
import { INTERACTIONS, GLOBAL_COOLDOWN_MS, type InteractionKind } from '@/lib/interactions';

interface PhotoModalProps {
  open: boolean;
  loading: boolean;
  src: string | null;
  caption: string;
  onClose: () => void;
}

export default function PhotoModal({ open, loading, src, caption, onClose }: PhotoModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // 焦点陷阱：打开时聚焦框内首个可聚焦元素（"关闭"按钮），Tab 在框内循环，Escape 关闭，关闭后还原焦点
  useFocusTrap({ active: open, containerRef: dialogRef, onEscape: onClose });

  // 触摸互动：只在这里浮现她的反应气泡，不写进聊天记录
  const [busyKind, setBusyKind] = useState<InteractionKind | null>(null);
  const [reaction, setReaction] = useState<{ text: string; note?: string } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [allUntil, setAllUntil] = useState(0); // 全部互动的冷却截止（epoch ms）
  const [kindUntil, setKindUntil] = useState<Partial<Record<InteractionKind, number>>>({});
  const reactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  useEffect(() => {
    return () => {
      if (reactionTimer.current) clearTimeout(reactionTimer.current);
    };
  }, []);

  const flash = useCallback((text: string, note?: string) => {
    setReaction({ text, note });
    if (reactionTimer.current) clearTimeout(reactionTimer.current);
    reactionTimer.current = setTimeout(() => setReaction(null), 2600);
  }, []);

  const remainingMs = (kind: InteractionKind) =>
    Math.max(0, allUntil - nowMs, (kindUntil[kind] ?? 0) - nowMs);

  const interact = useCallback(
    async (kind: InteractionKind) => {
      if (busyKind) return;
      const remain = Math.max(0, allUntil - Date.now(), (kindUntil[kind] ?? 0) - Date.now());
      if (remain > 0) return;
      setBusyKind(kind);
      try {
        const r = await fetch('/api/interact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind }),
        });
        const j = await r.json().catch(() => ({}));
        if (j?.ok) {
          flash(String(j.text || ''), j.effectNote ? String(j.effectNote) : undefined);
          const now = Date.now();
          setAllUntil(now + GLOBAL_COOLDOWN_MS);
          setKindUntil((prev) => ({ ...prev, [kind]: now + (Number(j.cooldownMs) || 0) }));
        } else if (Number(j?.cooldownMs) > 0) {
          const until = Date.now() + Number(j.cooldownMs);
          setAllUntil((v) => Math.max(v, until));
          setKindUntil((prev) => ({ ...prev, [kind]: until }));
          flash('她还在缓神，等一等。');
        } else {
          flash('……这次没什么反应。');
        }
      } catch {
        flash('……她好像没连上。');
      } finally {
        setBusyKind(null);
        setNowMs(Date.now());
      }
    },
    [busyKind, flash, allUntil, kindUntil]
  );

  if (!open) return null;
  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="她"
      onClick={(e) => {
        // 仅点击遮罩本身时关闭：拖拽选中文字后松手不会误关
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md animate-fade-up rounded-3xl surf p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold ink-1">她</h3>
          <button className="btn-ghost !px-2 !py-1 text-xs" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="mt-3 flex flex-col items-center">
          <div className="relative">
            {loading ? (
              <div className="flex h-64 w-full items-center justify-center rounded-2xl accent-soft text-sm ink-2 animate-pulse-soft">
                正在翻相册…
              </div>
            ) : (
              <img
                src={src || '/splash-girl.jpg'}
                alt="她"
                className="max-h-[60vh] w-auto rounded-2xl border line object-contain shadow-soft"
              />
            )}
            {/* 她的反应气泡：浮在照片上，2.6 秒后淡出 */}
            {reaction ? (
              <div
                role="status"
                aria-live="polite"
                className="pointer-events-none absolute right-2 top-2 max-w-[220px] animate-fade-up rounded-2xl border line surf px-3 py-2 text-xs leading-relaxed ink-1 shadow-soft"
              >
                {reaction.text}
                {reaction.note ? <span className="mt-0.5 block text-[10px] ink-3">{reaction.note}</span> : null}
              </div>
            ) : null}
          </div>
          {!loading && caption ? (
            <p className="mt-2 text-center text-xs leading-relaxed ink-2">{caption}</p>
          ) : null}

          {/* 触摸互动：摸头 / 戳脸 / 牵手 / 抱抱 */}
          {!loading ? (
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {INTERACTIONS.map((def) => {
                const remain = remainingMs(def.kind);
                const disabled = remain > 0 || busyKind !== null;
                return (
                  <button
                    key={def.kind}
                    type="button"
                    onClick={() => interact(def.kind)}
                    disabled={disabled}
                    aria-label={def.aria}
                    className="btn-ghost !px-3 !py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span aria-hidden>{def.icon}</span>
                    <span>{def.label}</span>
                    {remain > 0 ? <span className="tabular-nums ink-3">{Math.ceil(remain / 1000)}s</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}