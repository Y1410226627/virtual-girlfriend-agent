'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { errMsg } from '@/lib/utils';

/* ---------------------- 数据请求 hook ---------------------- */
export function useApi<T = unknown>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!url);
  // 请求序号：旧响应不得覆盖新响应
  const reqIdRef = useRef(0);
  const [prevUrl, setPrevUrl] = useState(url);

  // url 变化时在渲染阶段就清空旧数据：否则切换筛选后会先渲染上一组结果（旧列表闪变）。
  // 这里同步推进请求序号，让改动前 url 的在途响应在提交前即失效。
  if (prevUrl !== url) {
    setPrevUrl(url);
    setData(null);
    setError(null);
    setLoading(!!url);
    reqIdRef.current += 1;
  }

  const reload = useCallback(async () => {
    // 每次请求都推进序号：url 变为 null 时也能让上一 url 的在途响应失效
    const reqId = ++reqIdRef.current;
    if (!url) return;
    try {
      setLoading(true);
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (reqId !== reqIdRef.current) return;
      setData(j);
      setError(null);
    } catch (e) {
      if (reqId !== reqIdRef.current) return;
      setError(errMsg(e));
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}

/* ---------------------- 小组件 ---------------------- */
export function PageHeader({ title, desc, right }: { title: string; desc?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-6 pb-3 md:px-8">
      <div>
        <h1 className="text-xl font-semibold ink-1">{title}</h1>
        {desc ? <p className="dim mt-1 max-w-2xl leading-relaxed">{desc}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function Card({ title, right, children, className = '' }: { title?: React.ReactNode; right?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between">
          {title ? <h2 className="section-title">{title}</h2> : <span />}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, unit, tone = 'rose' }: { label: string; value: React.ReactNode; unit?: string; tone?: 'rose' | 'peach' | 'ink' }) {
  const color = tone === 'peach' ? 'acc-2' : tone === 'ink' ? 'ink-2' : 'acc';
  return (
    <div className="rounded-2xl surf border line px-3.5 py-3">
      <div className="dim">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${color}`}>
        {value}
        {unit ? <span className="ml-0.5 text-xs font-normal ink-3">{unit}</span> : null}
      </div>
    </div>
  );
}

export function Bar({ value, max = 100, min = 0, tone = 'rose', height = 8 }: { value: number; max?: number; min?: number; tone?: string; height?: number }) {
  // value/max/min 可能是脏值（NaN 或 max===min），不能让 NaN 穿透成 width: NaN%
  const span = max - min;
  const raw = span > 0 ? ((value - min) / span) * 100 : 0;
  const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
  const bg =
    tone === 'peach'
      ? 'bg-gradient-to-r from-peach-300 to-peach-500'
      : tone === 'gray'
        ? 'bg-gradient-to-r from-ink-300 to-ink-500'
        : 'bg-gradient-to-r from-rose-300 to-rose-500';
  return (
    <div className="w-full rounded-full accent-soft overflow-hidden" style={{ height }}>
      <div className={`h-full ${bg} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Chip({ children, tone = 'rose' }: { children?: React.ReactNode; tone?: string }) {
  return <span className={tone === 'plain' ? 'chip-plain' : 'chip'}>{children}</span>;
}

export function Loading({ text = '加载中…' }: { text?: string }) {
  return <div className="dim animate-pulse-soft px-5 py-4 md:px-8">{text}</div>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="mx-5 my-3 rounded-2xl border line accent-soft px-4 py-3 text-sm acc md:mx-8">
      <div className="font-medium">出错了</div>
      <div className="mt-1 break-all text-xs leading-relaxed">{message}</div>
      {onRetry ? (
        <button className="btn-soft mt-2" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

/* ---------------------- 轻提示 ---------------------- */
export function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  // 固化回调身份：父组件每次渲染都会新建 onClose，直接进依赖会重置计时器。
  // 在 effect 里写 ref（而非渲染期赋值），避免并发渲染下读到未提交的脏值。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const t = setTimeout(() => onCloseRef.current(), 3200);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <div className="fixed left-1/2 top-5 z-50 -translate-x-1/2 animate-fade-up">
      <div role="status" aria-live="polite" className="rounded-full bg-ink-900/85 px-4 py-2 text-xs text-white shadow-lg backdrop-blur">{text}</div>
    </div>
  );
}

export function fmtTime(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return ''; // 历史数据里可能有非日期文本，避免显示 NaN
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function fmtDate(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 表情包数据 */
export interface Sticker {
  id: string;
  emoji?: React.ReactNode;
  caption?: React.ReactNode;
}

/** 表情包卡片 */
export function StickerCard({ id, stickers }: { id: string; stickers?: Sticker[] }) {
  const s = (stickers || []).find((x: Sticker) => x.id === id);
  if (!s) {
    return <span className="italic ink-3">（表情包）</span>;
  }
  return (
    <span className="my-0.5 inline-flex flex-col items-center gap-0.5 rounded-2xl border line accent-soft px-3.5 py-2 shadow-bubble">
      <span className="text-4xl leading-none">{s.emoji}</span>
      <span className="text-[11px] ink-2">{s.caption}</span>
    </span>
  );
}

/**
 * 消息渲染：
 * - 表情包 token（[[sticker:xx]]）渲染成表情包卡片
 * - 括号里的神态/动作渲染成斜体浅色
 * 兼容全角（）与半角()，也兼容流式输出时还没闭合的括号。
 */
export function RichText({
  text,
  tone = 'agent',
  stickers,
}: {
  text: string;
  tone?: 'agent' | 'user';
  stickers?: Sticker[];
}) {
  const actionCls = tone === 'user' ? 'italic text-white/75' : 'italic acc';
  const src = String(text || '');
  const nodes: React.ReactNode[] = [];
  let key = 0;

  const pushText = (segment: string) => {
    // 动作可能被写成：（全角）(半角)【方头括号】[方括号]、全/半角混搭、以及句尾未闭合——都认
    const re =
      /(?:（[^)）\n]{1,120})\)|(?:\([^)）\n]{1,120})）|(?:（[^）]{1,120})）|(?:\([^)]{1,120})\)|(?:【[^】]{1,120}】)|(?:\[[^\]\n]{1,120}\])|(?:（[^）]{1,120})$|(?:\([^)\n]{1,120})$/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(segment)) !== null) {
      if (m.index > last) nodes.push(<span key={key++}>{segment.slice(last, m.index)}</span>);
      nodes.push(
        <span key={key++} className={actionCls}>
          {m[0]}
        </span>
      );
      last = m.index + m[0].length;
    }
    if (last < segment.length) nodes.push(<span key={key++}>{segment.slice(last)}</span>);
  };

  const stickerRe = /\[\[\s*(?:sticker|表情包)\s*[:：]?\s*([a-z_]+)\s*\]\]/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = stickerRe.exec(src)) !== null) {
    if (m.index > last) pushText(src.slice(last, m.index));
    nodes.push(
      <span key={key++} className="block">
        <StickerCard id={m[1]!} stickers={stickers} />
      </span>
    );
    last = m.index + m[0].length;
  }
  if (last < src.length) pushText(src.slice(last));

  return <>{nodes}</>;
}