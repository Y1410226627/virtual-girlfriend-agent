'use client';

import { useEffect, useRef } from 'react';
import { colorOf, type GroupMessage } from './shared';

/**
 * 群消息流：系统分隔居中、reaction 为小药丸、角色发言带头像+名字+专属色、用户消息右对齐。
 * 新消息到达时自动滚到底部（仅当用户已接近底部时，避免打断向上翻阅）。
 */
export function GroupChatView({ messages }: { messages: GroupMessage[] }) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      stickRef.current = nearBottom;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (stickRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  if (!messages.length) {
    return <div className="dim px-1 py-6">还没有消息。发一句话，让大家聊起来吧。</div>;
  }

  return (
    <div ref={scrollerRef} className="flex max-h-[58vh] flex-col gap-3 overflow-y-auto px-1 py-2">
      {messages.map((m) => {
        if (m.speaker_type === 'system') {
          return (
            <div key={m.id} className="my-1 text-center text-[11px] ink-3">
              <span className="rounded-full accent-soft px-3 py-1">{m.content}</span>
            </div>
          );
        }

        if (m.speaker_type === 'reaction') {
          return (
            <div key={m.id} className="flex items-center gap-2 pl-1">
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] text-white"
                style={{ backgroundColor: colorOf(m.companion_id) }}
                aria-hidden
              >
                {(m.speaker_name || '她').slice(0, 1)}
              </span>
              <span className="dim">
                {m.speaker_name || '她'} 发了表情
              </span>
              <span className="rounded-full accent-soft px-2 py-0.5 text-base leading-none" aria-hidden>
                {m.reaction || m.content}
              </span>
            </div>
          );
        }

        if (m.speaker_type === 'user') {
          return (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[78%] rounded-2xl rounded-br-md bg-rose-500 px-3.5 py-2 text-sm text-white shadow-bubble">
                {m.content}
              </div>
            </div>
          );
        }

        // companion
        const color = colorOf(m.companion_id);
        return (
          <div key={m.id} className="flex items-start gap-2">
            <span
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-sm text-white"
              style={{ backgroundColor: color }}
              aria-hidden
            >
              {(m.speaker_name || '她').slice(0, 1)}
            </span>
            <div className="min-w-0 max-w-[78%]">
              <div className="text-[11px] font-medium" style={{ color }}>
                {m.speaker_name || '她'}
              </div>
              <div className="mt-0.5 rounded-2xl rounded-tl-md surf border line px-3.5 py-2 text-sm ink-1">
                {m.content}
              </div>
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
