'use client';

import { useEffect, useState } from 'react';
import { errMsg } from '@/lib/utils';
import type { AppState } from '@/components/chat/shared';

/* 事件条：当前事件控制（立即结束 / 智能时长 / 自定义时长）与倒计时刷新（原 page.tsx 逻辑原样搬移） */
export function useEventBar(params: {
  state: AppState | null;
  loadMessages: () => Promise<void>;
  loadState: () => Promise<void>;
  setToast: (v: string | null) => void;
}) {
  const { state, loadMessages, loadState, setToast } = params;

  // 当前事件控制（她开始睡觉/吃饭/洗澡这类事情时，由你决定它什么时候结束）
  const [evBusy, setEvBusy] = useState(false);
  const [evCustomOpen, setEvCustomOpen] = useState(false);
  const [evMin, setEvMin] = useState('20');
  // 立即结束 + "等效时长"（写 8 小时 = 按睡了 8 小时结算影响，马上结束）
  const [evImmediateOpen, setEvImmediateOpen] = useState(false);
  const [evHours, setEvHours] = useState('8');
  const [, setEvTick] = useState(0);

  /* 事件倒计时：每 30 秒刷新一次显示；事件结束（或换了一个）时收起自定义输入 */
  const ongoingEventId = state?.life?.ongoingEvent?.id;
  useEffect(() => {
    if (ongoingEventId === undefined) {
      setEvCustomOpen(false);
      setEvImmediateOpen(false);
      return;
    }
    const t = setInterval(() => setEvTick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, [ongoingEventId]);

  /* 当前事件：立即结束 / 智能时长 / 自定义时长 */
  const eventAction = async (body: Record<string, unknown>) => {
    setEvBusy(true);
    try {
      const r = await fetch('/api/life', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j?.ok) {
        setToast(j?.error || '操作失败');
        return;
      }
      if (j.ended) {
        const assum = Number(j.assumedMinutes || 0);
        setToast(
          assum > 0
            ? `已按 ${Math.round((assum / 60) * 10) / 10} 小时结算，她醒了`
            : j.message
              ? '这件事结束了，看看她说了什么～'
              : '已结束（她这次没说出话，你发一句试试）'
        );
        await loadMessages();
      } else {
        setToast('结束时间已更新，到点她会来告诉你');
      }
      await loadState();
    } catch (e) {
      setToast(`操作失败：${errMsg(e)}`);
    } finally {
      setEvBusy(false);
    }
  };

  return {
    evBusy,
    evCustomOpen,
    evMin,
    evImmediateOpen,
    evHours,
    setEvMin,
    setEvHours,
    setEvImmediateOpen,
    setEvCustomOpen,
    eventAction,
  };
}