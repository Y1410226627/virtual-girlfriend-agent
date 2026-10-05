'use client';

import type { Sticker } from './shared';

interface StickerPanelProps {
  open: boolean;
  stickers?: Sticker[];
  onInsert: (id: string) => void;
  onClose: () => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
}

export default function StickerPanel({ open, stickers, onInsert, onClose, panelRef }: StickerPanelProps) {
  if (!open) return null;
  return (
    <div ref={panelRef} className="mx-auto mb-2 max-w-3xl animate-fade-up rounded-2xl border line surf p-3 shadow-soft">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium ink-2">挑一个表情，放进输入框再发</span>
        <button className="btn-ghost !py-1 text-xs" onClick={onClose}>
          收起
        </button>
      </div>
      <div className="grid max-h-56 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6">
        {(stickers || []).map((s) => (
          <button
            key={s.id}
            onClick={() => onInsert(s.id)}
            title={`${s.caption} · ${s.meaning}`}
            className="flex flex-col items-center gap-0.5 rounded-2xl border line accent-soft px-2 py-2 transition hover:border-rose-300 active:scale-95"
          >
            <span className="text-2xl leading-none">{s.emoji}</span>
            <span className="text-[10px] ink-2">{s.caption}</span>
          </button>
        ))}
      </div>
      <p className="dim mt-2">点一个会加到输入框里（不会直接发出去），可以配着文字一起发。她会看懂你发的表情包（含含义）。</p>
    </div>
  );
}