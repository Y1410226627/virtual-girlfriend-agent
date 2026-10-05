'use client';

import Link from 'next/link';
import { Bar } from '@/components/ui';
import type { AppState } from './shared';

interface ChatHeaderProps {
  her: string;
  mood: string;
  stageName: string;
  intimacy: number;
  scene: 'online' | 'offline';
  sceneMode: 'auto' | 'online' | 'offline';
  state: AppState | null;
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
  onOpenPhoto,
  onSetSceneMode,
  children,
}: ChatHeaderProps) {
  return (
    <header className="sticky top-0 z-30 border-b line surf px-5 py-3 backdrop-blur md:px-8">
      <div className="flex items-center gap-3">
        <button
          onClick={onOpenPhoto}
          title="看看她"
          aria-label="看看她"
          className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-gradient-to-br from-rose-300 to-peach-400 text-lg text-white shadow-bubble transition hover:scale-105 active:scale-95"
        >
          {her.slice(0, 1)}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold ink-1">{her}</span>
            <span className="chip">{stageName}期</span>
            <span className="chip-plain">{mood}</span>
            {state?.relationship?.conflict_state && state.relationship.conflict_state !== 'none' ? (
              <span className="chip !accent-soft">别扭中</span>
            ) : null}
            {state?.relationship?.pending_relationship_talk ? <span className="chip-plain">想谈谈</span> : null}
            {state?.relationship?.pending_stage_confirm ? <span className="chip-plain">想确认关系</span> : null}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[11px] ink-3">亲密度 {Math.round(intimacy)}</span>
            <div className="w-24">
              <Bar value={intimacy} height={5} />
            </div>
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