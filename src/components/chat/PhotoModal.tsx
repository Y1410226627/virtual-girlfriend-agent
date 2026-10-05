'use client';

interface PhotoModalProps {
  open: boolean;
  loading: boolean;
  src: string | null;
  caption: string;
  onClose: () => void;
}

export default function PhotoModal({ open, loading, src, caption, onClose }: PhotoModalProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="她"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md animate-fade-up rounded-3xl surf p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold ink-1">她</h3>
          <button className="btn-ghost !px-2 !py-1 text-xs" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="mt-3 flex flex-col items-center">
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
          {!loading && caption ? (
            <p className="mt-2 text-center text-xs leading-relaxed ink-2">{caption}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}