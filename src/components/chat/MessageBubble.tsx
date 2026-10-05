'use client';

import { fmtTime, RichText } from '@/components/ui';
import type { Msg, Sticker } from './shared';

interface MessageBubbleProps {
  m: Msg;
  stickers?: Sticker[];
  ttsEnabled?: boolean;
  playingId: number | null;
  lastMsgId: number;
  sending: boolean;
  onRequestDelete: (m: Msg) => void;
  onPlayTts: (m: Msg) => void;
  onRegenerate: () => void;
  onWithdraw: (m: Msg) => void;
}

export default function MessageBubble({
  m,
  stickers,
  ttsEnabled,
  playingId,
  lastMsgId,
  sending,
  onRequestDelete,
  onPlayTts,
  onRegenerate,
  onWithdraw,
}: MessageBubbleProps) {
  return (
    <div
      className={`group flex items-center gap-1.5 ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-up`}
    >
      {m.role === 'assistant' ? (
        <button
          onClick={() => onRequestDelete(m)}
          title="删除这条消息"
          aria-label="删除这条消息"
          className="shrink-0 rounded-full border line surf px-2 py-0.5 text-[11px] ink-3 opacity-50 transition hover:accent-soft hover:acc focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
        >
          ✕
        </button>
      ) : null}
      <div className={`max-w-[82%] sm:max-w-[70%]`}>
        <div
          className={
            m.role === 'user'
              ? 'bubble-user bg-gradient-to-br from-rose-400 to-rose-500 px-4 py-2.5 text-sm text-white shadow-bubble whitespace-pre-wrap break-words'
              : 'bubble-agent border line surf px-4 py-2.5 text-sm ink-1 shadow-bubble whitespace-pre-wrap break-words'
          }
        >
          <RichText text={m.content} tone={m.role === 'user' ? 'user' : 'agent'} stickers={stickers} />
          {m.streaming ? <span className="ml-1 inline-block h-3 w-1.5 animate-pulse-soft bg-rose-400 align-middle" /> : null}
        </div>
        <div className={`mt-1 flex items-center gap-2 text-[10px] ink-3 ${m.role === 'user' ? 'justify-end' : ''}`}>
          <span>{fmtTime(m.created_at)}</span>
          {m.role === 'assistant' && m.emotion ? <span className="chip">{m.emotion}</span> : null}
          {m.is_proactive ? <span className="chip-plain">她主动找你的</span> : null}
          {m.role === 'assistant' && !m.streaming && m.id > 0 && ttsEnabled ? (
            <button
              onClick={() => onPlayTts(m)}
              title={playingId === m.id ? '停止播放' : '朗读这条'}
              aria-label={playingId === m.id ? '停止播放' : '朗读这条'}
              className={`btn-ghost !px-1.5 !py-0.5 text-[11px] ${playingId === m.id ? '!accent-soft !acc' : ''}`}
            >
              {playingId === m.id ? '⏹' : '🔊'}
            </button>
          ) : null}
        </div>
        {m.role === 'assistant' && m.id === lastMsgId && !m.streaming && !sending ? (
          <div className="mt-1 flex items-center gap-2 opacity-70 transition focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100">
            <button className="btn-ghost !px-2 !py-0.5 text-[11px]" onClick={onRegenerate} title="让她重新说一遍">
              重新生成
            </button>
            <button className="btn-ghost !px-2 !py-0.5 text-[11px]" onClick={() => onWithdraw(m)} title="撤回她这条回复">
              撤回
            </button>
          </div>
        ) : null}
      </div>
      {m.role === 'user' ? (
        <button
          onClick={() => onRequestDelete(m)}
          title="删除这条消息"
          aria-label="删除这条消息"
          className="shrink-0 rounded-full border line surf px-2 py-0.5 text-[11px] ink-3 opacity-50 transition hover:accent-soft hover:acc focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}