'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { errMsg } from '@/lib/utils';
import { composerAttachments } from '@/components/chat/Composer';
import type { Msg, AppState, ChatEvent, ChatRequest } from '@/components/chat/shared';

/** /api/chat 请求体：在既有协议上扩展 images（随消息附带的图片 dataURL） */
type ChatRequestBody = ChatRequest & { images?: string[] };
/** 消息在运行时还带着服务端 meta 列（Msg 类型未声明） */
type MsgWithMeta = Msg & { meta?: string | null };

/* 消息流：消息加载/轮询、/api/chat SSE 消费与流式渲染、发送/重新生成/撤回（原 page.tsx 逻辑原样搬移） */
export function useChatStream(params: {
  state: AppState | null;
  loadState: () => Promise<void>;
  setToast: (v: string | null) => void;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
}) {
  const { state, loadState, setToast, input, setInput } = params;

  const [messages, setMessagesState] = useState<Msg[]>([]);
  // 最新消息快照：regenerate/withdraw 用它确认"最后一条是她"，避免读到渲染期的过期闭包
  const messagesRef = useRef<Msg[]>([]);
  const setMessages = useCallback((updater: SetStateAction<Msg[]>) => {
    setMessagesState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      messagesRef.current = next;
      return next;
    });
  }, []);
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const [busyNote, setBusyNote] = useState<string | null>(null); // 她忙时"正在输入"处的小字提示（在场闸门）
  const [recalling, setRecalling] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // P1-51 历史分页：是否还有更早的消息 / 是否正在加载更早的消息
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef(0);
  const sendingRef = useRef(false);
  const analysisTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* 卸载时清掉分析轮询定时器（避免路由切换后还在跑、对已卸载组件 setState） */
  useEffect(() => {
    return () => {
      if (analysisTimerRef.current) {
        clearInterval(analysisTimerRef.current);
        analysisTimerRef.current = null;
      }
    };
  }, []);

  const scrollToBottom = useCallback((smooth = false, force = false) => {
    const el = listRef.current;
    if (!el) return;
    // 用户正在上滑看历史时不要把他拽回底部（除非是"我自己刚发了一条"这种必须跟随的情况）
    if (!force && el.scrollHeight - el.scrollTop - el.clientHeight > 80) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  /* 把完整文本切成 2~3 段（换行 / 句末标点为界；表情包 token 不切断；含代码块不切） */
  const splitIntoSegments = (text: string): string[] => {
    const t = text;
    if (t.includes('```')) return [t];
    if (t.trim().length < 30) return [t];
    if ((t.match(/[。！？…]/g) || []).length < 2) return [t];
    const pieces: string[] = [];
    let cur = '';
    for (const ch of t) {
      cur += ch;
      if (ch === '\n' || '。！？…'.includes(ch)) {
        pieces.push(cur);
        cur = '';
      }
    }
    if (cur) pieces.push(cur);
    if (pieces.length <= 1) return [t];
    const groups = pieces.length >= 4 ? 3 : 2;
    const per = Math.ceil(pieces.length / groups);
    const out: string[] = [];
    for (let i = 0; i < pieces.length; i += per) out.push(pieces.slice(i, i + per).join(''));
    return out.length > 1 ? out : [t];
  };

  /* 逐段追加到同一个气泡（段间 300~900ms 停顿，停顿期间重新显示"正在输入…"） */
  const appendInSegments = async (streamId: number, add: string) => {
    const segs = splitIntoSegments(add);
    if (segs.length <= 1) {
      setMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, content: m.content + add } : m)));
      scrollToBottom();
      return;
    }
    for (let i = 0; i < segs.length; i++) {
      if (i > 0) {
        setTyping(true);
        await new Promise((r) => setTimeout(r, 300 + Math.random() * 600));
        setTyping(false);
      }
      const piece = segs[i];
      setMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, content: m.content + piece } : m)));
      scrollToBottom();
    }
  };

  /* 发起 /api/chat 并把 SSE 逐条回调（正常回复与重新生成共用，避免复制粘贴读流代码） */
  const consumeChatStream = async (body: ChatRequestBody, onEvt: (evt: ChatEvent) => void | Promise<void>) => {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
        let evt: ChatEvent;
        try {
          evt = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        await onEvt(evt);
      }
    }
  };

  /* 标准流式渲染：把她的回复落到一个流式气泡上，收敛后返回 {text, ids, error} */
  const renderChatStream = async (body: ChatRequestBody, streamId: number, userTempId?: number) => {
    const st: { text: string; ids: ChatEvent | null; started: boolean; error: unknown } = {
      text: '',
      ids: null,
      started: false,
      error: null,
    };
    try {
      await consumeChatStream(body, async (evt: ChatEvent) => {
        if (evt.type === 'delta') {
          st.text += evt.text;
          if (!st.started) {
            st.started = true;
            setTyping(false);
            setMessages((prev) => [
              ...prev,
              { id: streamId, role: 'assistant', content: st.text, created_at: new Date().toISOString(), streaming: true },
            ]);
          } else {
            setMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, content: st.text } : m)));
          }
          scrollToBottom();
        } else if (evt.type === 'final') {
          const fin = String(evt.text || '');
          // 服务端在 notes 里标注的降级（如"她暂时看不懂图片"）用现有 toast 提示一下
          const notes = (evt as ChatEvent & { notes?: unknown }).notes;
          if (Array.isArray(notes)) {
            const note = notes.find((n): n is string => typeof n === 'string' && n.includes('看不懂图片'));
            if (note) setToast(note);
          }
          const prevText = st.text;
          st.text = fin;
          if (!st.started) {
            st.started = true;
            setTyping(false);
            setMessages((prev) => [
              ...prev,
              { id: streamId, role: 'assistant', content: '', created_at: new Date().toISOString(), streaming: true },
            ]);
            await appendInSegments(streamId, fin);
          } else if (fin.startsWith(prevText)) {
            // 能接上的增量：只把新增部分分句追加（短文本仍是一次性）
            await appendInSegments(streamId, fin.slice(prevText.length));
          } else {
            // 人味层改动过大：整段重排，长文本分句出现
            setMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, content: '' } : m)));
            await appendInSegments(streamId, fin);
          }
        } else if (evt.type === 'done') {
          st.ids = evt;
          // 用服务端真实 id 替换本地临时 id（负 id）：否则删除/撤回会带着负 id 请求服务端
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id === streamId) return { ...m, id: evt.assistantMessageId ?? m.id, streaming: false };
              if (userTempId !== undefined && m.id === userTempId && evt.userMessageId)
                return { ...m, id: evt.userMessageId };
              return m;
            })
          );
          lastIdRef.current = Math.max(
            lastIdRef.current,
            evt.assistantMessageId || 0,
            evt.userMessageId || 0
          );
        } else if (evt.type === 'error') {
          throw new Error(evt.message);
        }
      });
    } catch (e) {
      st.error = e;
    }
    return st;
  };

  /* 在场闸门：按她当前状态放大"真人打字感"延迟，并给出"正在输入"处的小字提示 */
  const presenceGate = (): { ms: number; note: string | null } => {
    const et = String(state?.life?.ongoingEvent?.eventType || state?.life?.activityType || '');
    if (et === 'sleep') return { ms: 2500 + Math.random() * 2500, note: '（她好像正睡着，迷迷糊糊地回你）' };
    if (et === 'class' || et === 'study' || et === 'work')
      return { ms: 1500 + Math.random() * 2000, note: '（她正忙着，悄悄回你一句）' };
    if (et === 'shower' || et === 'commute' || et === 'out')
      return { ms: 800 + Math.random() * 1000, note: '（她正忙着，抽空瞄了眼手机）' };
    return { ms: 250 + Math.random() * 500, note: null };
  };

  /* 结束后台分析轮询并复位"她在回味…"提示（正常完成 / 失败 / 超时 / 任务丢失共用） */
  const endAnalysisPoll = () => {
    if (analysisTimerRef.current) {
      clearInterval(analysisTimerRef.current);
      analysisTimerRef.current = null;
    }
    setRecalling(false);
  };

  const loadMessages = useCallback(async () => {
    try {
      const r = await fetch('/api/messages?limit=80', { cache: 'no-store' });
      const j = await r.json();
      if (j?.messages) {
        setMessages(j.messages);
        // 一次拿满一页 → 可能还有更早的消息可加载（P1-51）
        setHasOlder(Array.isArray(j.messages) && j.messages.length >= 80);
        lastIdRef.current = j.messages.length ? j.messages[j.messages.length - 1].id : 0;
        // 记录已读位置，供导航栏未读红点使用
        if (j.messages.length) {
          try {
            window.localStorage.setItem('lastReadMsgId', String(j.messages[j.messages.length - 1].id));
          } catch {
            /* ignore */
          }
        }
        setTimeout(() => scrollToBottom(), 30);
      }
    } catch (e) {
      setLoadErr(errMsg(e));
    }
  }, [scrollToBottom, setMessages]);

  useEffect(() => {
    loadMessages();
    loadState();
  }, [loadMessages, loadState]);

  /* P1-51：加载更早的历史消息（前插，并保持当前滚动位置） */
  const loadOlder = useCallback(async () => {
    const first = messagesRef.current[0];
    if (!first || first.id <= 0 || loadingOlder) return;
    setLoadingOlder(true);
    const el = listRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      const r = await fetch(`/api/messages?beforeId=${first.id}&limit=60`, { cache: 'no-store' });
      const j = await r.json();
      const older: Msg[] = Array.isArray(j?.messages) ? j.messages : [];
      if (!older.length) {
        setHasOlder(false);
        return;
      }
      setMessages((prev) => {
        const exists = new Set(prev.map((m) => m.id));
        const add = older.filter((m) => !exists.has(m.id));
        return add.length ? [...add, ...prev] : prev;
      });
      if (older.length < 60) setHasOlder(false);
      // 前插后内容变高：把 scrollTop 加上"新增的高度"，视觉上位置不动
      requestAnimationFrame(() => {
        const e = listRef.current;
        if (e) e.scrollTop = prevTop + (e.scrollHeight - prevHeight);
      });
    } catch {
      /* 忽略：下次再试 */
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, setMessages]);

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
          try {
            window.localStorage.setItem('lastReadMsgId', String(j.messages[j.messages.length - 1].id));
          } catch {
            /* ignore */
          }
          setTimeout(() => scrollToBottom(true), 60);
        }
        loadState();
      } catch {
        /* ignore */
      }
    }, 15000);
    return () => clearInterval(t);
  }, [loadState, scrollToBottom, setMessages]);

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    // 本轮附带的图片（Composer 压缩后的 dataURL）；必须在任何 await 之前同步取走
    const images = composerAttachments.images.slice(0, 2);
    // 用 ref 判定，避免慢设备/输入法下连发两条；文字与图片至少要有一个
    if ((!text && images.length === 0) || sendingRef.current) return;
    setInput('');
    setSending(true);
    sendingRef.current = true;
    setTyping(true);

    // 先把自己的消息显示出来（带图时把 dataURL 写进 meta，气泡立即能显示缩略图）
    const tempId = -Date.now();
    const optimistic: MsgWithMeta = {
      id: tempId,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
      meta: images.length ? JSON.stringify({ images }) : null,
    };
    setMessages((prev) => [...prev, optimistic]);
    setTimeout(() => scrollToBottom(true, true), 30);

    // 在场闸门：她忙时回复更慢，"正在输入…"处显示一行状态小字
    const gate = presenceGate();
    if (gate.note) setBusyNote(gate.note);
    await new Promise((r) => setTimeout(r, gate.ms));
    setBusyNote(null);

    const streamId = -Date.now() - 1;
    let assistantText = '';
    let ids: ChatEvent | null = null;

    try {
      const st = await renderChatStream(images.length ? { content: text, images } : { content: text }, streamId, tempId);
      if (st.error) throw st.error;
      if (!st.text) throw new Error('她这次没说话，再试一次吧');
      assistantText = st.text;
      ids = st.ids;

      // 没收到 done（连接被中断 / 服务端异常）：也要收敛——复位流式状态，并用服务端数据兜底拿真实 id
      // （否则光标常闪，且 15s 轮询会把同一条落库消息当成新消息再追加一次，出现重复气泡）
      if (!ids) {
        await loadMessages().catch(() => null);
      }

      // 关键：回复一结束就解锁输入框，归档记忆 / 调整性格全部丢到后台
      setSending(false);
      sendingRef.current = false;
      setTyping(false);

      // 后台分析：新版服务端在落库后已自行入队（done 事件带 analysisStartedAt / analysisJobId），
      // 前端不再主动 POST /api/analyze，只轮询 GET 看进度。
      setRecalling(true);
      let enqueueAt = Number(ids?.analysisStartedAt) || 0;
      const serverEnqueued = !!ids && (enqueueAt > 0 || ids.analysisJobId != null);
      if (!serverEnqueued) {
        // 兼容尚未切换的服务端（done 未携带入队信息）：兜底主动触发一次，避免分析被静默丢弃。
        enqueueAt = Date.now();
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
      }

      // 轮询后台进度：跑完了再刷新状态、给一个小提示
      // 服务端语义：busy = running || 队列非空（入队未开始/运行中皆为 true），lastFinishedAt 在每轮完成时更新，
      // 因此 !busy && lastFinishedAt > enqueueAt 能正确判定"本轮已结束"。
      if (analysisTimerRef.current) clearInterval(analysisTimerRef.current);
      let sawBusy = false; // 是否观测到过 busy，用于识别"本轮任务被队列丢弃"的异常空窗
      const timer = setInterval(async () => {
        // 超时兜底放在 fetch 之外：GET 一直失败也必须能收尾，绝不让"她在回味…"永久卡住、轮询空转
        if (Date.now() - enqueueAt > 120000) {
          endAnalysisPoll(); // 超 120s 静默结束
          return;
        }
        try {
          const st = await (await fetch('/api/analyze', { cache: 'no-store' })).json();
          if (st?.busy) sawBusy = true;
          const finishedAfterEnqueue = Number(st?.lastFinishedAt || 0) > enqueueAt;
          // 分析失败：真实错误在 st.last.error（旧代码看的 st.error 并不存在）
          const failed = !!st?.last && st.last.ok === false && finishedAfterEnqueue;
          if (failed || st?.error) {
            endAnalysisPoll();
            return;
          }
          // 见过 busy、如今队列空闲却没有本轮完成时间 → 本轮被队列上限丢弃，静默收尾（不再空等）
          if (sawBusy && !st?.busy && !finishedAfterEnqueue) {
            endAnalysisPoll();
            return;
          }
          if (st?.busy || !finishedAfterEnqueue) return;
          endAnalysisPoll();
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
      analysisTimerRef.current = timer;
    } catch (e) {
      setTyping(false);
      setToast(`发送失败：${errMsg(e)}`);
      // 连自己那条临时消息一起撤掉（服务端失败时也会删掉落库的那条，刷新不会"复活"）
      setMessages((prev) => prev.filter((m) => m.id !== streamId && m.id !== tempId));
      // 把刚打的字还回去（除非用户已经在输入框里写了新内容）
      setInput((cur) => (cur.trim() ? cur : text));
    } finally {
      setSending(false);
      sendingRef.current = false;
      setTyping(false);
      setBusyNote(null);
    }
  };

  /* 重新生成她最后一条回复（服务端删除后重跑，客户端复用同一套流式渲染） */
  const regenerate = async () => {
    if (sendingRef.current) return;
    // 用 ref 取"当下真正的最后一条"：避免 15s 轮询插入新消息后，闭包里的 messages 已过期
    const last = messagesRef.current[messagesRef.current.length - 1];
    if (!last || last.role !== 'assistant' || last.streaming) return;
    setSending(true);
    sendingRef.current = true;
    // 先撤掉旧气泡，新的会以流式重新出现
    setMessages((prev) => prev.filter((m) => m.id !== last.id));
    const streamId = -Date.now() - 1;
    try {
      const st = await renderChatStream({ regenerate: true }, streamId);
      if (st.error) throw st.error;
      if (!st.text) throw new Error('她这次没说话，再试一次吧');
      if (!st.ids) await loadMessages().catch(() => null);
    } catch (e) {
      setToast(`重新生成失败：${errMsg(e)}`);
      await loadMessages().catch(() => null); // 旧的已被服务端删除，拉回真实状态
    } finally {
      setSending(false);
      sendingRef.current = false;
      setTyping(false);
    }
  };

  /* 撤回她最后一条回复（只删这一条，不撤销记忆与影响） */
  const withdraw = async (m: Msg) => {
    if (sendingRef.current) return;
    // 以 ref 为准确认要撤回的确实是"最后一条她"：消息列表变动后旧闭包可能已指向过期气泡
    const last = messagesRef.current[messagesRef.current.length - 1];
    if (!last || last.id !== m.id) {
      setToast('只能撤回她最新的一条回复');
      return;
    }
    try {
      const r = await fetch(`/api/messages?id=${m.id}&cascade=0`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) throw new Error(j?.error || '撤回失败');
      await loadMessages();
      setToast('已撤回她这条回复');
    } catch (e) {
      setToast(`撤回失败：${errMsg(e)}`);
    }
  };

  return {
    messages,
    setMessages,
    sending,
    typing,
    busyNote,
    recalling,
    loadErr,
    hasOlder,
    loadingOlder,
    listRef,
    loadMessages,
    loadOlder,
    send,
    regenerate,
    withdraw,
  };
}