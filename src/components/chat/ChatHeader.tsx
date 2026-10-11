'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bar } from '@/components/ui';
import { withCompanionQuery } from '@/components/chat/companion-query';
import { computeDoki } from '@/lib/doki';
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
  /** 当前聊天对象；头部「摸头」互动随它定位到对应伴侣。 */
  companionId?: number;
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
  companionId = 1,
  children,
}: ChatHeaderProps) {
  // 头部快捷"摸头"：点击她的名字即可，反应以气泡浮现在头部附近（不进聊天流）
  const [reaction, setReaction] = useState<{ text: string; note?: string } | null>(null);
  const [patting, setPatting] = useState(false);
  const [coolLeft, setCoolLeft] = useState(0); // 剩余冷却（毫秒）
  // 手机端：状态详情默认收起（点「状态」展开）；桌面端始终显示（md:block）
  const [detailsOpen, setDetailsOpen] = useState(false);
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
      const r = await fetch(withCompanionQuery('/api/interact', companionId), {
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
  }, [coolLeft, companionId, flash, patting, startCooldown]);

  // 手机端紧凑心动指数（完整版在「状态」详情里）：与 DokiMeter 同源计算
  const doki = computeDoki({
    intimacy: state?.relationship?.intimacy,
    trust: state?.relationship?.trust,
    emotional_balance: state?.relationship?.emotional_balance,
    repair_credit: state?.relationship?.repair_credit,
    unresolved_tension: state?.relationship?.unresolved_tension,
    stage: state?.relationship?.stage,
  });

  // 她的次要状态标签：桌面端显示在第一行；手机端收进「状态」详情（避免顶栏占两三行）
  const statusChips = (
    <>
      {state?.relationship?.conflict_state && state.relationship.conflict_state !== 'none' ? (
        <span className="chip !accent-soft">别扭中</span>
      ) : null}
      {state?.relationship?.pending_relationship_talk ? <span className="chip-plain">想谈谈</span> : null}
      {state?.relationship?.pending_stage_confirm ? <span className="chip-plain">想确认关系</span> : null}
    </>
  );

  // 线上 / 线下：状态标签 + 三段切换（手机端收进「状态」详情）
  const sceneControls = (
    <>
      <span
        className={`chip-plain ${scene === 'offline' ? '!accent-soft !acc-2' : ''}`}
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
    </>
  );

  // 她此刻的生活状态（位置 / 活动 / 精力 / 情绪）：手机端随「状态」详情一起收起
  const lifeLine = (
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
  );

  return (
    <header className="sticky top-0 z-30 border-b line surf px-4 pb-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] backdrop-blur md:px-8 md:py-3">
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

      {/* 第一行：头像 + 名字/主要状态 + 右侧（手机：♥Lv + 状态开关；桌面：场景 + 关系面板） */}
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
          <div className="flex flex-wrap items-center gap-2">
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
            {/* 次要状态：桌面端跟在主状态后面；手机端在「状态」详情里 */}
            <span className="hidden md:contents">{statusChips}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="chip-plain md:hidden" title="心动指数（点「状态」看分项）">
            <span aria-hidden className="acc">
              ♥
            </span>
            Lv.{doki.level}
          </span>
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            aria-expanded={detailsOpen}
            aria-label={detailsOpen ? '收起状态详情' : '展开状态详情'}
            className={`btn-ghost !px-2.5 !py-1.5 text-[11px] md:hidden ${detailsOpen ? '!accent-soft !acc' : ''}`}
          >
            状态 {detailsOpen ? '▴' : '▾'}
          </button>
          {/* 桌面端：场景状态 + 切换（保持原样） */}
          <span className="hidden md:contents">{sceneControls}</span>
          <Link href="/relationship" className="btn-ghost hidden md:inline-flex">
            关系面板
          </Link>
        </div>
      </div>

      {/* 状态详情：手机默认收起（点「状态」展开）；桌面端始终显示 */}
      <div className={`${detailsOpen ? 'block' : 'hidden'} md:block`}>
        <div className="mt-2 flex flex-wrap items-center gap-2 md:hidden">
          {statusChips}
          {sceneControls}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 md:pl-[52px]">
          <span className="text-[11px] ink-3">亲密度 {Math.round(intimacy)}</span>
          <div className="w-24">
            <Bar value={intimacy} height={5} />
          </div>
          <DokiMeter rel={state?.relationship} />
        </div>
        {lifeLine}
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

      {children}
    </header>
  );
}