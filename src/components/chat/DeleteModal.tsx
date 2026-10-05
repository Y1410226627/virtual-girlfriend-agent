'use client';

import { useRef } from 'react';
import { RichText } from '@/components/ui';
import { useFocusTrap } from './use-focus-trap';
import type { Msg, Sticker } from './shared';

interface DeleteModalProps {
  target: Msg | null;
  cascade: boolean;
  setCascade: React.Dispatch<React.SetStateAction<boolean>>;
  deleting: boolean;
  stickers?: Sticker[];
  cancelRef: React.RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onDelete: () => void;
}

export default function DeleteModal({
  target,
  cascade,
  setCascade,
  deleting,
  stickers,
  cancelRef,
  onCancel,
  onDelete,
}: DeleteModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // 焦点陷阱：打开时聚焦"取消"（安全性优先），Tab 在框内循环，关闭后还原焦点。
  // Escape 关闭已由 use-delete-flow 处理，此处不重复。
  useFocusTrap({ active: !!target, containerRef: dialogRef, initialFocusRef: cancelRef });
  if (!target) return null;
  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/40 p-4 backdrop-blur-sm md:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="删除这条消息？"
      onClick={(e) => {
        // 仅点击遮罩本身时关闭：拖拽选中文字后松手不会误关
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-md animate-fade-up rounded-3xl surf p-5 shadow-xl">
        <h3 className="text-base font-semibold ink-1">删除这条消息？</h3>
        <div className="mt-2 rounded-2xl accent-soft px-3 py-2 text-xs leading-relaxed ink-2">
          <RichText text={target.content} stickers={stickers} />
        </div>
        <label className="mt-3 flex items-start gap-2 text-sm ink-2">
          <input
            type="checkbox"
            className="mt-0.5 accent-rose-500"
            checked={cascade}
            onChange={(e) => setCascade(e.target.checked)}
          />
          <span>
            同时撤销这条消息产生的记忆与影响
            <span className="mt-1 block text-[11px] leading-relaxed ink-3">
              会一起撤销：这一轮抽取的记忆、性格信号与性格调整、依恋信号、情感银行收支、亲密度/信任/张力/修复信用等数值变化，以及这一轮的关系日志。
              关系数值如果是最近这一轮，会精确还原到聊天前；更早的轮次按增量扣回，保留之后的成长。
              只删被选中的这一条，同轮的另一条消息会保留。
            </span>
          </span>
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button ref={cancelRef} className="btn-ghost" onClick={onCancel} disabled={deleting}>
            取消
          </button>
          <button className="btn" onClick={onDelete} disabled={deleting}>
            {deleting ? '处理中…' : '删除'}
          </button>
        </div>
      </div>
    </div>
  );
}