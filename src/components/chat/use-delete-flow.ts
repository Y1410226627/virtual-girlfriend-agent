'use client';

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { errMsg } from '@/lib/utils';
import type { Msg } from '@/components/chat/shared';

/* 删除流：删除确认弹窗状态、Esc 聚焦、执行删除（原 page.tsx 逻辑原样搬移） */
export function useDeleteFlow(params: {
  setMessages: Dispatch<SetStateAction<Msg[]>>;
  loadState: () => Promise<void>;
  setToast: (v: string | null) => void;
}) {
  const { setMessages, loadState, setToast } = params;

  const [delTarget, setDelTarget] = useState<Msg | null>(null);
  const [delCascade, setDelCascade] = useState(false); // 默认不连带撤销记忆/数值（要撤销需自己勾）
  const [deleting, setDeleting] = useState(false);
  const delCancelRef = useRef<HTMLButtonElement>(null);

  /* 删除确认弹窗：打开时聚焦首个按钮，支持 ESC 关闭 */
  useEffect(() => {
    if (!delTarget) return;
    delCancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDelTarget(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [delTarget]);

  const doDelete = async () => {
    if (!delTarget) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/messages?id=${delTarget.id}&cascade=${delCascade ? 1 : 0}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) throw new Error(j?.error || '删除失败');
      setMessages((prev) => prev.filter((m) => m.id !== delTarget.id));
      const rm = j.removed || {};
      const bits: string[] = [];
      if (rm.memories) bits.push(`记忆 -${rm.memories}`);
      if (rm.personalitySignals) bits.push(`性格信号 -${rm.personalitySignals}`);
      if (rm.personalityLogs) bits.push(`性格调整 -${rm.personalityLogs}`);
      if (rm.attachmentSignals) bits.push(`依恋信号 -${rm.attachmentSignals}`);
      if (rm.bankEntries) bits.push(`银行流水 -${rm.bankEntries}`);
      if (rm.relationshipLogs) bits.push(`关系日志 -${rm.relationshipLogs}`);
      setToast(
        delCascade
          ? `已删除并撤销影响${bits.length ? '：' + bits.join(' · ') : '（这一轮没有留下痕迹）'}`
          : '已删除这条消息（记忆与影响保留）'
      );
      setDelTarget(null);
      loadState();
    } catch (e) {
      setToast(`删除失败：${errMsg(e)}`);
    } finally {
      setDeleting(false);
    }
  };

  return { delTarget, setDelTarget, delCascade, setDelCascade, deleting, delCancelRef, doDelete };
}