'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bar } from '@/components/ui';
import DokiMeter from './DokiMeter';
import type { AppState } from './shared';

interface ChatHeaderProps {
  her: string;
  mood: string;
  stageName: string;
  intimacy: number;
  scene: 'online' | 'offline';
  sceneMode: 'auto' | 'online' | 'offline';
  state: AppState | null;
  /** 她正在输入 / 说话（来自 use-chat-stream）——头像加一点呼吸感 */
  typing?: boolean;
  onOpenPhoto: () => void;
  onSetSceneMode: (mode: 'auto' | 'online' | 'offline') => void;
  children?: React.ReactNode;
}

export default function ChatHeader({
  her,
  mood,
  stageName,
  intimacy,
  scene,
  sceneMode,
  state,
  typing = false,
  onOpenPhoto,
  onSetSceneMode,
  children,
}: ChatHeaderProps) {
  // 头部快捷"摸头"：点击她的名字即可，反应以气泡浮现在头部附近（不进聊天流）
  const [reaction, setReaction] = useState<{ text: string; note?: string } | null>(null);
  const [patting, setPatting] = useState(false);
  const [coolLeft, setCoolLeft] = useState(0); // 剩余冷却（毫秒）
  const reactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coolTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const flash = useCallback((text: string, note?: string) => {
    setReaction({ text, note });
    if (reactionTimer.current) clearTimeout(reactionTimer.current);
    reactionTimer.current = setTimeout(() => setReaction(null), 2600);
  }, []);

  const startCooldown = useCallback((ms: number) => {
    if (!(ms > 0)) return;
    setCoolLeft(ms);
    if (coolTimer.current) clearInterval(coolTimer.current);
    coolTimer.current = setInterval(() => {
      setCoolLeft((left) => {
        const next = left - 1000;
        if (next <= 0 && coolTimer.current) {
          clearInterval(coolTimer.current);
          coolTimer.current = null;
        }
        return next > 0 ? next : 0;
      });
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (reactionTimer.current) clearTimeout(reactionTimer.current);
      if (coolTimer.current) clearInterval(coolTimer.current);
    };
  }, []);

  const quickPat = useCallback(async () => {
    if (patting) return;
    if (coolLeft > 0) {
      flash(`她还在缓神…… ${Math.ceil(coolLeft / 1000)}s`);
      return;
    }
    setPatting(true);
    try {
      const r = await fetch('/api/interact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'pat' }),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.ok) {
        flash(String(j.text || ''), j.effectNote ? String(j.effectNote) : undefined);
        startCooldown(Number(j.cooldownMs) || 0);
      } else if (Number(j?.cooldownMs) > 0) {
        startCooldown(Number(j.cooldownMs));
        flash('她还在缓神，等一等。');
      } else {
        flash('……这次没什么反应。');
      }
    } catch {
      flash('……她好像没连上。');
    } finally {
      setPatting(false);
    }
  }, [coolLeft, flash, patting, startCooldown]);

  return (
    <header className="sticky top-0 z-30 border-b line surf px-5 py-3 backdrop-blur md:px-8">
      <style>{`
        @keyframes her-halo {
          0%, 100% { opacity: 0; transform: scale(0.9); }
          50% { opacity: 0.5; transform: scale(1.12); }
        }
        .her-halo {
          border: 1.5px solid var(--accent);
          animation: her-halo 2.4s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .her-halo { animation: none !important; opacity: 0.35; }
        }
      `}</style>
      <div className="flex items-center gap-3">
        <span className="relative inline-flex">
          <button
            onClick={onOpenPhoto}
            title="看看她"
            aria-label="看看她"
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-gradient-to-br from-rose-300 to-peach-400 text-lg text-white shadow-bubble transition hover:scale-105 active:scale-95"
          >
            {her.slice(0, 1)}
          </button>
          {typing ? (
            <span aria-hidden className="her-halo pointer-events-none absolute -inset-1 rounded-full" />
          ) : null}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={quickPat}
              title="摸摸她的头"
              aria-label="摸摸她的头（快捷互动）"
              className="cursor-pointer rounded-md font-semibold ink-1 transition hover:acc"
            >
              {her}
            </button>
            <span className="chip">{stageName}期</span>
            <span className="chip-plain">{mood}</span>
            {state?.relationship?.conflict_state && state.relationship.conflict_state !== 'none' ? (
              <span className="chip !accent-soft">别扭中</span>
            ) : null}
            {state?.relationship?.pending_relationship_talk ? <span className="chip-plain">想谈谈</span> : null}
            {state?.relationship?.pending_stage_confirm ? <span className="chip-plain">想确认关系</span> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="text-[11px] ink-3">亲密度 {Math.round(intimacy)}</span>
            <div className="w-24">
              <Bar value={intimacy} height={5} />
            </div>
            <DokiMeter rel={state?.relationship} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`chip-plain hidden sm:inline-flex ${scene === 'offline' ? '!accent-soft !acc-2' : ''}`}
            title={state?.relationship?.sceneReason || ''}
          >
            {scene === 'offline' ? '线下相处' : '线上聊天'}
          </span>
          <div className="flex items-center gap-0.5 rounded-full border line surf p-0.5 text-[11px]">
            {(
              [
                ['auto', '自动'],
                ['online', '线上'],
                ['offline', '线下'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => onSetSceneMode(k)}
                title={k === 'auto' ? '智能识别线上/线下' : `强制${label}对话`}
                className={`rounded-full px-2.5 py-1 transition ${
                  sceneMode === k ? 'bg-rose-500 text-white' : 'ink-2 hover:accent-soft'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <Link href="/relationship" className="btn-ghost hidden sm:inline-flex">
            关系面板
          </Link>
        </div>
      </div>

      {/* 快捷互动的反应气泡（只在这里浮现，不写进聊天记录） */}
      {reaction ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute left-16 top-14 z-40 max-w-[260px] animate-fade-up rounded-2xl border line surf px-3 py-2 text-xs leading-relaxed ink-1 shadow-soft"
        >
          {reaction.text}
          {reaction.note ? <span className="mt-0.5 block text-[10px] ink-3">{reaction.note}</span> : null}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] ink-2">
        {state?.life ? (
          <>
            <span title="她当前的位置">📍 {state.life.location}</span>
            <span title="她正在做什么">{state.life.activity}</span>
            <span title="精力">精力 {Math.round(state.life.energy)}</span>
            <span title="情绪">{state.life.emotion}</span>
            {state.life.illness && state.life.illness !== 'none' ? (
              <span className="acc">🤒 {state.life.illness}中</span>
            ) : null}
          </>
        ) : null}
        {state?.intimacy?.inAftercare ? <span className="acc">刚亲密过 · 事后</span> : null}
      </div>
      {children}
    </header>
  );
}