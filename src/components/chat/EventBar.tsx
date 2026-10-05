'use client';

import { fmtTime } from '@/components/ui';
import { remainText, type OngoingEvent } from './shared';

interface EventBarProps {
  ongoingEvent?: OngoingEvent | null;
  evBusy: boolean;
  evImmediateOpen: boolean;
  evCustomOpen: boolean;
  evMin: string;
  evHours: string;
  setEvMin: React.Dispatch<React.SetStateAction<string>>;
  setEvHours: React.Dispatch<React.SetStateAction<string>>;
  setEvImmediateOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setEvCustomOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onEventAction: (body: Record<string, unknown>) => void;
}

export default function EventBar({
  ongoingEvent,
  evBusy,
  evImmediateOpen,
  evCustomOpen,
  evMin,
  evHours,
  setEvMin,
  setEvHours,
  setEvImmediateOpen,
  setEvCustomOpen,
  onEventAction,
}: EventBarProps) {
  if (!ongoingEvent) return null;
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border line accent-soft px-3 py-2 text-[11px]">
        <span className="ink-1">
          她正在「{ongoingEvent.activity}」
          <span className="ml-2 ink-3">
            {ongoingEvent.expectedEnd
              ? `预计 ${fmtTime(ongoingEvent.expectedEnd)} 结束 · ${remainText(ongoingEvent.expectedEnd)}`
              : '结束时间由你定'}
          </span>
        </span>
        <span className="flex-1" />
        <button
          className={`btn-ghost !px-2 !py-1 text-[11px] ${evImmediateOpen ? '!accent-soft !acc' : ''}`}
          disabled={evBusy}
          onClick={() => {
            setEvImmediateOpen((v) => !v);
            setEvCustomOpen(false);
          }}
          title="现在就结束这件事；也可以填一个等效时长，按那个时长结算她恢复/消耗了多少"
        >
          立即结束
        </button>
        <button
          className="btn-ghost !px-2 !py-1 text-[11px]"
          disabled={evBusy}
          onClick={() => onEventAction({ action: 'end_event', mode: 'smart' })}
          title="按这类事情最自然的时长重新估算结束时间"
        >
          智能时长
        </button>
        <button
          className={`btn-ghost !px-2 !py-1 text-[11px] ${evCustomOpen ? '!accent-soft !acc' : ''}`}
          disabled={evBusy}
          onClick={() => {
            setEvCustomOpen((v) => !v);
            setEvImmediateOpen(false);
          }}
          title="自己设定还有多少分钟后结束"
        >
          自定义时长
        </button>
        {evBusy ? <span className="animate-pulse-soft acc">处理中…</span> : null}
      </div>
      {evImmediateOpen ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] ink-2">
          <span>按等效时长结束：假定「{ongoingEvent.activity}」持续了</span>
          <input
            className="input !w-20 !px-2 !py-1 text-xs"
            type="number"
            min={0.5}
            max={24}
            step={0.5}
            value={evHours}
            onChange={(e) => setEvHours(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onEventAction({ action: 'end_event', mode: 'immediate', hours: Number(evHours) });
                setEvImmediateOpen(false);
              }
            }}
          />
          <span>小时（她恢复/消耗多少按这个算，然后立即结束）</span>
          <button
            className="btn !px-2.5 !py-1 text-[11px]"
            disabled={evBusy}
            onClick={() => {
              onEventAction({ action: 'end_event', mode: 'immediate', hours: Number(evHours) });
              setEvImmediateOpen(false);
            }}
          >
            确定结束
          </button>
          <button
            className="btn-ghost !px-2 !py-1 text-[11px]"
            disabled={evBusy}
            onClick={() => {
              onEventAction({ action: 'end_event', mode: 'immediate' });
              setEvImmediateOpen(false);
            }}
          >
            按实际时长
          </button>
          <button className="btn-ghost !px-2 !py-1 text-[11px]" onClick={() => setEvImmediateOpen(false)}>
            取消
          </button>
        </div>
      ) : null}
      {evCustomOpen ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] ink-2">
          <span>再过</span>
          <input
            className="input !w-20 !px-2 !py-1 text-xs"
            type="number"
            min={5}
            max={720}
            value={evMin}
            onChange={(e) => setEvMin(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onEventAction({ action: 'end_event', mode: 'manual', minutes: Number(evMin) });
                setEvCustomOpen(false);
              }
            }}
          />
          <span>分钟后结束（5 - 720 分钟），到点她会主动来告诉你</span>
          <button
            className="btn !px-2.5 !py-1 text-[11px]"
            disabled={evBusy}
            onClick={() => {
              onEventAction({ action: 'end_event', mode: 'manual', minutes: Number(evMin) });
              setEvCustomOpen(false);
            }}
          >
            确定
          </button>
          <button className="btn-ghost !px-2 !py-1 text-[11px]" onClick={() => setEvCustomOpen(false)}>
            取消
          </button>
        </div>
      ) : null}
    </>
  );
}