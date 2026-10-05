'use client';

import { useRef, useState } from 'react';
import { fmtTime, RichText } from '@/components/ui';
import { useFocusTrap } from './use-focus-trap';
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

/** 消息在运行时还带着服务端的 meta 列（Msg 类型未声明，这里按需读取，勿改动共享类型） */
type MsgWithMeta = Msg & { meta?: string | null };

/** 从消息 meta 解析出图片地址：dataURL 原样用；相对路径（uploads/xxx.jpg）转成 /api/uploads/xxx.jpg */
function imageSources(m: Msg): string[] {
  const meta = (m as MsgWithMeta).meta;
  if (!meta || typeof meta !== 'string') return [];
  try {
    const obj = JSON.parse(meta) as { images?: unknown };
    const arr = obj?.images;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .map((p) => (p.startsWith('data:') || p.startsWith('/') || p.startsWith('http') ? p : `/api/${p}`));
  } catch {
    return [];
  }
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
  const [zoom, setZoom] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // 放大弹层：与 PhotoModal 同一套焦点陷阱（聚焦框内、Esc 关闭、关闭后还原焦点）
  useFocusTrap({ active: zoom !== null, containerRef: dialogRef, onEscape: () => setZoom(null) });
  const imgs = m.role === 'user' ? imageSources(m) : [];

  return (
    <>
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
          {imgs.length ? (
            <div className={`mb-1.5 flex flex-wrap gap-1.5 ${m.role === 'user' ? 'justify-end' : ''}`}>
              {imgs.map((src, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setZoom(src)}
                  title="点击放大"
                  aria-label="查看图片"
                  className="overflow-hidden rounded-xl border line shadow-soft transition hover:opacity-90"
                >
                  <img src={src} alt="发来的图片" className="h-24 w-24 object-cover sm:h-28 sm:w-28" />
                </button>
              ))}
            </div>
          ) : null}
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

      {zoom ? (
        <div
          ref={dialogRef}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="图片"
          onClick={(e) => {
            if (e.target === e.currentTarget) setZoom(null);
          }}
        >
          <div className="w-full max-w-md animate-fade-up rounded-3xl surf p-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold ink-1">你发来的图片</h3>
              <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => setZoom(null)} aria-label="关闭">
                关闭
              </button>
            </div>
            <img src={zoom} alt="你发来的图片" className="mt-3 max-h-[70vh] w-full rounded-2xl object-contain" />
          </div>
        </div>
      ) : null}
    </>
  );
}