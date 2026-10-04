'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Toast, fmtTime, Bar, RichText } from '@/components/ui';

const SUGGESTIONS = ['今天过得怎么样？', '我今天遇到一件挺烦的事', '你刚才在忙什么呀？', '有点想你了'];

interface Msg {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  emotion?: string | null;
  is_proactive?: number;
  created_at: string;
  streaming?: boolean;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const [recalling, setRecalling] = useState(false);
  const [state, setState] = useState<any>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [onboard, setOnboard] = useState(false);
  const [nameDraft, setNameDraft] = useState({ user_name: '', agent_name: '' });
  const [delTarget, setDelTarget] = useState<Msg | null>(null);
  const [delCascade, setDelCascade] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [stickerOpen, setStickerOpen] = useState(false);
  // 当前事件控制（她开始睡觉/吃饭/洗澡这类事情时，由你决定它什么时候结束）
  const [evBusy, setEvBusy] = useState(false);
  const [evCustomOpen, setEvCustomOpen] = useState(false);
  const [evMin, setEvMin] = useState('20');
  const [, setEvTick] = useState(0);

  const listRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef(0);
  const sendingRef = useRef(false);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  const loadState = useCallback(async () => {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const j = await r.json();
      setState(j);
      if (!j?.settings?.user_name) setOnboard(true);
    } catch {
      /* ignore */
    }
  }, []);

  const loadMessages = useCallback(async () => {
    try {
      const r = await fetch('/api/messages?limit=80', { cache: 'no-store' });
      const j = await r.json();
      if (j?.messages) {
        setMessages(j.messages);
        lastIdRef.current = j.messages.length ? j.messages[j.messages.length - 1].id : 0;
        setTimeout(() => scrollToBottom(), 30);
      }
    } catch (e: any) {
      setLoadErr(e?.message || String(e));
    }
  }, [scrollToBottom]);

  useEffect(() => {
    loadMessages();
    loadState();
  }, [loadMessages, loadState]);

  /* 轮询新消息（她会主动发消息） */
  useEffect(() => {
    const t = setInterval(async () => {
      if (sendingRef.current) return;
      try {
        const r = await fetch(`/api/messages?afterId=${lastIdRef.current}`, { cache: 'no-store' });
        const j = await r.json();
        if (j?.messages?.length) {
          setMessages((prev) => {
            const exists = new Set(prev.map((m) => m.id));
            const add = j.messages.filter((m: Msg) => !exists.has(m.id));
            if (!add.length) return prev;
            return [...prev, ...add];
          });
          lastIdRef.current = j.messages[j.messages.length - 1].id;
          setTimeout(() => scrollToBottom(true), 60);
        }
        loadState();
      } catch {
        /* ignore */
      }
    }, 15000);
    return () => clearInterval(t);
  }, [loadState, scrollToBottom]);

  /* 事件倒计时：每 30 秒刷新一次显示；事件结束（或换了一个）时收起自定义输入 */
  useEffect(() => {
    if (!state?.life?.ongoingEvent) {
      setEvCustomOpen(false);
      return;
    }
    const t = setInterval(() => setEvTick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, [state?.life?.ongoingEvent?.id]);

  const saveOnboard = async () => {
    await fetch('/api/relationship', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_user', user_name: nameDraft.user_name }),
    });
    if (nameDraft.agent_name.trim()) {
      await fetch('/api/relationship', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_persona', agent_name: nameDraft.agent_name }),
      });
    }
    setOnboard(false);
    loadState();
    setToast('记住啦');
  };

  const setSceneMode = async (mode: 'auto' | 'online' | 'offline') => {
    const r = await fetch('/api/relationship', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_scene', mode }),
    });
    const j = await r.json();
    if (j.ok) {
      setToast(mode === 'auto' ? '已恢复智能识别场景' : `已切换为${mode === 'offline' ? '线下相处' : '线上聊天'}`);
      loadState();
    }
  };

  /* 当前事件：立即结束 / 智能时长 / 自定义时长 */
  const remainText = (iso: string) => {
    const ms = new Date(iso).getTime() - Date.now();
    if (!isFinite(ms)) return '';
    if (ms <= 0) return '即将结束';
    const m = Math.max(1, Math.round(ms / 60000));
    if (m < 60) return `还有约 ${m} 分钟`;
    return `还有约 ${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
  };

  const eventAction = async (body: Record<string, any>) => {
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
        setToast('这件事结束了，看看她说了什么～');
        await loadMessages();
      } else {
        setToast('结束时间已更新，到点她会来告诉你');
      }
      await loadState();
    } catch (e: any) {
      setToast(`操作失败：${e?.message || e}`);
    } finally {
      setEvBusy(false);
    }
  };

  const sendSticker = async (id: string) => {
    setStickerOpen(false);
    await send(`[[sticker:${id}]]`);
  };

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
    } catch (e: any) {
      setToast(`删除失败：${e?.message || e}`);
    } finally {
      setDeleting(false);
    }
  };

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);
    sendingRef.current = true;
    setTyping(true);

    // 先把自己的消息显示出来
    const tempId = -Date.now();
    setMessages((prev) => [
      ...prev,
      { id: tempId, role: 'user', content: text, created_at: new Date().toISOString() },
    ]);
    setTimeout(() => scrollToBottom(true), 30);

    // 真人打字感：稍微延迟一下再发请求
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));

    let assistantText = '';
    let ids: any = null;
    const streamId = -Date.now() - 1;
    let started = false;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `请求失败 ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          let evt: any = null;
          try {
            evt = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (evt.type === 'delta') {
            assistantText += evt.text;
            if (!started) {
              started = true;
              setTyping(false);
              setMessages((prev) => [
                ...prev,
                { id: streamId, role: 'assistant', content: assistantText, created_at: new Date().toISOString(), streaming: true },
              ]);
            } else {
              setMessages((prev) =>
                prev.map((m) => (m.id === streamId ? { ...m, content: assistantText } : m))
              );
            }
            scrollToBottom();
          } else if (evt.type === 'final') {
            // 人味层可能在生成后补了神态动作 / 做了清洗，用最终版本替换
            assistantText = evt.text;
            setMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, content: evt.text } : m)));
          } else if (evt.type === 'done') {
            ids = evt;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamId ? { ...m, id: evt.assistantMessageId, streaming: false } : m
              )
            );
            lastIdRef.current = Math.max(lastIdRef.current, evt.assistantMessageId || 0);
          } else if (evt.type === 'error') {
            throw new Error(evt.message);
          }
        }
      }

      if (!assistantText) throw new Error('她这次没说话，再试一次吧');

      // 关键：回复一结束就解锁输入框，归档记忆 / 调整性格全部丢到后台
      setSending(false);
      sendingRef.current = false;

      // 后台分析（记忆/关系/性格信号/依恋信号）——入队即返回，完全不阻塞你打字
      setRecalling(true);
      const enqueueAt = Date.now();
      fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userMessage: text,
          assistantMessage: assistantText,
          userMessageId: ids?.userMessageId,
          assistantMessageId: ids?.assistantMessageId,
        }),
      }).catch(() => {
        /* 分析失败不影响聊天 */
      });

      // 轮询后台进度：跑完了再刷新状态、给一个小提示
      const timer = setInterval(async () => {
        try {
          const st = await (await fetch('/api/analyze', { cache: 'no-store' })).json();
          const done = !st?.busy && Number(st?.lastFinishedAt || 0) > enqueueAt;
          if (st?.error || Date.now() - enqueueAt > 120000) {
            clearInterval(timer);
            setRecalling(false);
            return;
          }
          if (!done) return;
          clearInterval(timer);
          setRecalling(false);
          const last = st.last;
          if (last?.ok) {
            const u = st.updated || {};
            const bits: string[] = [];
            if (u.mood) bits.push(`心情：${u.mood}`);
            if (last.applied?.memories) bits.push(`记住 ${last.applied.memories} 条`);
            if (last.applied?.personalitySignals) bits.push(`性格信号 +${last.applied.personalitySignals}`);
            if (last.applied?.conflict) bits.push('出现了小摩擦');
            if (last.applied?.repaired) bits.push('关系修复了');
            if (last.applied?.stageChanged) bits.push('关系阶段提升');
            if (bits.length) setToast(bits.join(' · '));
          }
          loadState();
        } catch {
          /* 继续轮询 */
        }
      }, 2500);
    } catch (e: any) {
      setTyping(false);
      setToast(`发送失败：${e?.message || e}`);
      setMessages((prev) => prev.filter((m) => m.id !== streamId));
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  };

  const her = state?.persona?.agent_name || '她';
  const mood = state?.relationship?.mood || '平静';
  const stageName = state?.relationship?.stageName || '初识';
  const intimacy = Number(state?.relationship?.intimacy || 0);
  const scene = state?.relationship?.scene === 'offline' ? 'offline' : 'online';
  const sceneMode = (state?.relationship?.sceneMode || 'auto') as 'auto' | 'online' | 'offline';

  return (
    <div className="flex h-screen flex-col">
      {/* 顶部状态 */}
      <header className="sticky top-0 z-30 border-b border-rose-100/80 bg-white/75 px-5 py-3 backdrop-blur md:px-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-rose-300 to-peach-400 text-lg text-white shadow-bubble">
            {her.slice(0, 1)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-ink-900">{her}</span>
              <span className="chip">{stageName}期</span>
              <span className="chip-plain">{mood}</span>
              {state?.relationship?.conflict_state && state.relationship.conflict_state !== 'none' ? (
                <span className="chip !bg-rose-200/90">别扭中</span>
              ) : null}
              {state?.relationship?.pending_relationship_talk ? <span className="chip-plain">想谈谈</span> : null}
              {state?.relationship?.pending_stage_confirm ? <span className="chip-plain">想确认关系</span> : null}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-[11px] text-ink-300">亲密度 {Math.round(intimacy)}</span>
              <div className="w-24">
                <Bar value={intimacy} height={5} />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`chip-plain hidden sm:inline-flex ${scene === 'offline' ? '!bg-peach-100 !text-peach-700' : ''}`}
              title={state?.relationship?.sceneReason || ''}
            >
              {scene === 'offline' ? '线下相处' : '线上聊天'}
            </span>
            <div className="flex items-center gap-0.5 rounded-full border border-rose-100 bg-white/70 p-0.5 text-[11px]">
              {(
                [
                  ['auto', '自动'],
                  ['online', '线上'],
                  ['offline', '线下'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setSceneMode(k)}
                  title={k === 'auto' ? '智能识别线上/线下' : `强制${label}对话`}
                  className={`rounded-full px-2.5 py-1 transition ${
                    sceneMode === k ? 'bg-rose-500 text-white' : 'text-ink-500 hover:bg-rose-50'
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
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-ink-500">
          {state?.life ? (
            <>
              <span title="她当前的位置">📍 {state.life.location}</span>
              <span title="她正在做什么">{state.life.activity}</span>
              <span title="精力">精力 {Math.round(state.life.energy)}</span>
              <span title="情绪">{state.life.emotion}</span>
              {state.life.illness && state.life.illness !== 'none' ? (
                <span className="text-rose-500">🤒 {state.life.illness}中</span>
              ) : null}
            </>
          ) : null}
          {state?.intimacy?.inAftercare ? <span className="text-rose-500">刚亲密过 · 事后</span> : null}
        </div>
        {state?.life?.ongoingEvent ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-peach-200 bg-peach-50/70 px-3 py-2 text-[11px]">
            <span className="text-ink-900">
              她正在「{state.life.ongoingEvent.activity}」
              <span className="ml-2 text-ink-300">
                {state.life.ongoingEvent.expectedEnd
                  ? `预计 ${fmtTime(state.life.ongoingEvent.expectedEnd)} 结束 · ${remainText(state.life.ongoingEvent.expectedEnd)}`
                  : '结束时间由你定'}
              </span>
            </span>
            <span className="flex-1" />
            <button
              className="btn-ghost !px-2 !py-1 text-[11px]"
              disabled={evBusy}
              onClick={() => eventAction({ action: 'end_event', mode: 'immediate' })}
              title="她现在就结束这件事，并马上回你一条消息"
            >
              立即结束
            </button>
            <button
              className="btn-ghost !px-2 !py-1 text-[11px]"
              disabled={evBusy}
              onClick={() => eventAction({ action: 'end_event', mode: 'smart' })}
              title="按这类事情最自然的时长重新估算结束时间"
            >
              智能时长
            </button>
            <button
              className={`btn-ghost !px-2 !py-1 text-[11px] ${evCustomOpen ? '!bg-rose-100 !text-rose-700' : ''}`}
              disabled={evBusy}
              onClick={() => setEvCustomOpen((v) => !v)}
              title="自己设定还有多少分钟后结束"
            >
              自定义时长
            </button>
            {evBusy ? <span className="animate-pulse-soft text-rose-500">处理中…</span> : null}
          </div>
        ) : null}
        {state?.life?.ongoingEvent && evCustomOpen ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
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
                  eventAction({ action: 'end_event', mode: 'manual', minutes: Number(evMin) });
                  setEvCustomOpen(false);
                }
              }}
            />
            <span>分钟后结束（5 - 720 分钟），到点她会主动来告诉你</span>
            <button
              className="btn !px-2.5 !py-1 text-[11px]"
              disabled={evBusy}
              onClick={() => {
                eventAction({ action: 'end_event', mode: 'manual', minutes: Number(evMin) });
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
        {recalling ? (
          <div className="mt-2 text-[11px] text-rose-500 animate-pulse-soft">她在回味刚才的对话…（更新记忆、性格信号、关系数值）</div>
        ) : null}
      </header>

      {/* 消息列表 */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 md:px-8">
        {loadErr ? (
          <div className="mx-auto max-w-md rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700">
            {loadErr}
          </div>
        ) : null}

        {messages.length === 0 && !onboard ? (
          <div className="mx-auto mt-16 max-w-md text-center">
            <div className="text-4xl">💌</div>
            <p className="mt-4 text-sm leading-relaxed text-ink-700">
              你们还没有聊过。
              <br />
              说句话试试——她还不知道你的名字，也不知道自己该叫什么。
            </p>
            <p className="dim mt-2">你给的信息，她会一件件记住；她的性格，也会在相处里慢慢长出来。</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  className="btn-ghost !py-1.5 text-xs"
                  onClick={() => {
                    setInput(s);
                    setTimeout(() => send(s), 0);
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {onboard ? (
          <div className="mx-auto mt-10 max-w-md card animate-fade-up">
            <h2 className="text-base font-semibold text-ink-900">先认识一下吧</h2>
            <p className="dim mt-1 leading-relaxed">
              她还没有名字，也还不知道怎么称呼你。可以现在填，也可以在聊天里慢慢聊出来。
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="label">你怎么称呼？</label>
                <input
                  className="input"
                  placeholder="比如：小明"
                  value={nameDraft.user_name}
                  onChange={(e) => setNameDraft((s) => ({ ...s, user_name: e.target.value }))}
                />
              </div>
              <div>
                <label className="label">给她起个名字（可留空，让她自己问你）</label>
                <input
                  className="input"
                  placeholder="比如：小满"
                  value={nameDraft.agent_name}
                  onChange={(e) => setNameDraft((s) => ({ ...s, agent_name: e.target.value }))}
                />
              </div>
              <div className="flex gap-2">
                <button className="btn" onClick={saveOnboard}>
                  就这么定了
                </button>
                <button className="btn-ghost" onClick={() => setOnboard(false)}>
                  先跳过
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="mx-auto max-w-3xl space-y-3">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`group flex items-center gap-1.5 ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-up`}
            >
              {m.role === 'assistant' ? (
                <button
                  onClick={() => {
                    setDelTarget(m);
                    setDelCascade(true);
                  }}
                  title="删除这条消息"
                  className="shrink-0 rounded-full border border-rose-100 bg-white/80 px-2 py-0.5 text-[11px] text-ink-300 opacity-50 transition hover:bg-rose-50 hover:text-rose-500 md:opacity-0 md:group-hover:opacity-100"
                >
                  ✕
                </button>
              ) : null}
              <div className={`max-w-[82%] sm:max-w-[70%]`}>
                <div
                  className={
                    m.role === 'user'
                      ? 'bubble-user bg-gradient-to-br from-rose-400 to-rose-500 px-4 py-2.5 text-sm text-white shadow-bubble whitespace-pre-wrap break-words'
                      : 'bubble-agent border border-rose-100 bg-white px-4 py-2.5 text-sm text-ink-900 shadow-bubble whitespace-pre-wrap break-words'
                  }
                >
                  <RichText text={m.content} tone={m.role === 'user' ? 'user' : 'agent'} stickers={state?.stickers} />
                  {m.streaming ? <span className="ml-1 inline-block h-3 w-1.5 animate-pulse-soft bg-rose-400 align-middle" /> : null}
                </div>
                <div className={`mt-1 flex items-center gap-2 text-[10px] text-ink-300 ${m.role === 'user' ? 'justify-end' : ''}`}>
                  <span>{fmtTime(m.created_at)}</span>
                  {m.role === 'assistant' && m.emotion ? <span className="chip">{m.emotion}</span> : null}
                  {m.is_proactive ? <span className="chip-plain">她主动找你的</span> : null}
                </div>
              </div>
              {m.role === 'user' ? (
                <button
                  onClick={() => {
                    setDelTarget(m);
                    setDelCascade(true);
                  }}
                  title="删除这条消息"
                  className="shrink-0 rounded-full border border-rose-100 bg-white/80 px-2 py-0.5 text-[11px] text-ink-300 opacity-50 transition hover:bg-rose-50 hover:text-rose-500 md:opacity-0 md:group-hover:opacity-100"
                >
                  ✕
                </button>
              ) : null}
            </div>
          ))}

          {typing ? (
            <div className="flex justify-start">
              <div className="bubble-agent flex items-center gap-1 border border-rose-100 bg-white px-4 py-3 shadow-bubble">
                <span className="dot-1 h-1.5 w-1.5 rounded-full bg-rose-400" />
                <span className="dot-2 h-1.5 w-1.5 rounded-full bg-rose-400" />
                <span className="dot-3 h-1.5 w-1.5 rounded-full bg-rose-400" />
                <span className="ml-2 text-[11px] text-ink-300">对方正在输入…</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* 输入框 */}
      <div className="sticky bottom-0 border-t border-rose-100/80 bg-white/85 px-4 py-3 pb-20 backdrop-blur md:px-8 md:pb-3">
        {stickerOpen ? (
          <div className="mx-auto mb-2 max-w-3xl animate-fade-up rounded-2xl border border-rose-100 bg-white/95 p-3 shadow-soft">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-700">挑一个表情包发给她</span>
              <button className="btn-ghost !py-1 text-xs" onClick={() => setStickerOpen(false)}>
                收起
              </button>
            </div>
            <div className="grid max-h-56 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6">
              {(state?.stickers || []).map((s: any) => (
                <button
                  key={s.id}
                  onClick={() => sendSticker(s.id)}
                  title={s.meaning}
                  className="flex flex-col items-center gap-0.5 rounded-2xl border border-rose-100 bg-gradient-to-br from-peach-50 to-rose-50 px-2 py-2 transition hover:border-rose-300 active:scale-95"
                >
                  <span className="text-2xl leading-none">{s.emoji}</span>
                  <span className="text-[10px] text-ink-500">{s.caption}</span>
                </button>
              ))}
            </div>
            <p className="dim mt-2">她会看懂你发的表情包（含含义），也会在合适的时候回你一个。</p>
          </div>
        ) : null}
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <button
            className={`btn-ghost h-[46px] px-3.5 ${stickerOpen ? '!bg-rose-100 !text-rose-700' : ''}`}
            onClick={() => setStickerOpen((v) => !v)}
            title="发表情包"
          >
            😀
          </button>
          <textarea
            className="textarea max-h-32 min-h-[46px] flex-1 py-3"
            rows={1}
            placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={sending}
          />
          <button className="btn h-[46px] px-5" onClick={() => send()} disabled={sending || !input.trim()}>
            {sending ? '…' : '发送'}
          </button>
        </div>
      </div>

      {delTarget ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/40 p-4 backdrop-blur-sm md:items-center">
          <div className="w-full max-w-md animate-fade-up rounded-3xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-semibold text-ink-900">删除这条消息？</h3>
            <div className="mt-2 rounded-2xl bg-rose-50/70 px-3 py-2 text-xs leading-relaxed text-ink-500">
              <RichText text={delTarget.content} stickers={state?.stickers} />
            </div>
            <label className="mt-3 flex items-start gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                className="mt-0.5 accent-rose-500"
                checked={delCascade}
                onChange={(e) => setDelCascade(e.target.checked)}
              />
              <span>
                同时撤销这条消息产生的记忆与影响
                <span className="mt-1 block text-[11px] leading-relaxed text-ink-300">
                  会一起撤销：这一轮抽取的记忆、性格信号与性格调整、依恋信号、情感银行收支、亲密度/信任/张力/修复信用等数值变化，以及这一轮的关系日志。
                  关系数值如果是最近这一轮，会精确还原到聊天前；更早的轮次按增量扣回，保留之后的成长。
                  只删被选中的这一条，同轮的另一条消息会保留。
                </span>
              </span>
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setDelTarget(null)} disabled={deleting}>
                取消
              </button>
              <button className="btn" onClick={doDelete} disabled={deleting}>
                {deleting ? '处理中…' : '删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}