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
  const [busyNote, setBusyNote] = useState<string | null>(null); // 她忙时"正在输入"处的小字提示（在场闸门）
  const [recalling, setRecalling] = useState(false);
  const [state, setState] = useState<any>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [onboard, setOnboard] = useState(false);
  const [nameDraft, setNameDraft] = useState({ user_name: '', agent_name: '' });
  const [delTarget, setDelTarget] = useState<Msg | null>(null);
  const [delCascade, setDelCascade] = useState(false); // 默认不连带撤销记忆/数值（要撤销需自己勾）
  const [deleting, setDeleting] = useState(false);
  const [stickerOpen, setStickerOpen] = useState(false);
  // 当前事件控制（她开始睡觉/吃饭/洗澡这类事情时，由你决定它什么时候结束）
  const [evBusy, setEvBusy] = useState(false);
  const [evCustomOpen, setEvCustomOpen] = useState(false);
  const [evMin, setEvMin] = useState('20');
  // 立即结束 + "等效时长"（写 8 小时 = 按睡了 8 小时结算影响，马上结束）
  const [evImmediateOpen, setEvImmediateOpen] = useState(false);
  const [evHours, setEvHours] = useState('8');
  const [, setEvTick] = useState(0);

  const listRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef(0);
  const sendingRef = useRef(false);
  const visitAtRef = useRef<number>(Date.now()); // "你这次进来"的时间（用于"她等了你多久"）
  const delCancelRef = useRef<HTMLButtonElement>(null);
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

  /* 记录"你这次进来"的时间（用于顶部"她等了你 X 小时"） */
  useEffect(() => {
    visitAtRef.current = Date.now();
    try {
      window.localStorage.setItem('lastVisitAt', String(visitAtRef.current));
    } catch {
      /* ignore */
    }
  }, []);

  /* 删除确认弹窗：打开时聚焦首个按钮，支持 ESC 关闭 */
  useEffect(() => {
    if (!delTarget) return;
    delCancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDelTarget(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [delTarget]);

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
  const consumeChatStream = async (body: any, onEvt: (evt: any) => void | Promise<void>) => {
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
        let evt: any = null;
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
  const renderChatStream = async (body: any, streamId: number) => {
    const st: { text: string; ids: any; started: boolean; error: any } = {
      text: '',
      ids: null,
      started: false,
      error: null,
    };
    try {
      await consumeChatStream(body, async (evt: any) => {
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
          setMessages((prev) =>
            prev.map((m) => (m.id === streamId ? { ...m, id: evt.assistantMessageId, streaming: false } : m))
          );
          lastIdRef.current = Math.max(lastIdRef.current, evt.assistantMessageId || 0);
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

  const loadState = useCallback(async () => {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const j = await r.json();
      setState(j);
      // 没有昵称就提示补名字；但用户主动关掉之后就不再复活（原来 15s 轮询会把它弹回来）
      const dismissed = typeof window !== 'undefined' && window.localStorage.getItem('onboardDismissed') === '1';
      if (!j?.settings?.user_name && !dismissed) setOnboard(true);
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
  }, [loadState, scrollToBottom]);

  /* 事件倒计时：每 30 秒刷新一次显示；事件结束（或换了一个）时收起自定义输入 */
  useEffect(() => {
    if (!state?.life?.ongoingEvent) {
      setEvCustomOpen(false);
      setEvImmediateOpen(false);
      return;
    }
    const t = setInterval(() => setEvTick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, [state?.life?.ongoingEvent?.id]);

  const saveOnboard = async () => {
    const name = String(nameDraft.user_name || '').trim();
    if (!name) {
      setToast('先告诉我该怎么称呼你吧');
      return;
    }
    try {
      const r1 = await fetch('/api/relationship', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_user', user_name: name }),
      });
      if (!r1.ok) throw new Error(`保存失败 ${r1.status}`);
      if (nameDraft.agent_name.trim()) {
        const r2 = await fetch('/api/relationship', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'set_persona', agent_name: nameDraft.agent_name.trim() }),
        });
        if (!r2.ok) throw new Error(`保存失败 ${r2.status}`);
      }
      window.localStorage.setItem('onboardDismissed', '1');
      setOnboard(false);
      loadState();
      setToast('记住啦');
    } catch (e: any) {
      // 保存失败不要假装成功（否则轮询又把引导弹回来，用户以为卡住了）
      setToast(`没能保存：${e?.message || e}`);
    }
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
        const assum = Number(j.assumedMinutes || 0);
        setToast(
          assum > 0
            ? `已按 ${Math.round((assum / 60) * 10) / 10} 小时结算，她醒了`
            : j.message
              ? '这件事结束了，看看她说了什么～'
              : '已结束（她这次没说出话，你发一句试试）'
        );
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
    if (!text || sendingRef.current) return; // 用 ref 判定，避免慢设备/输入法下连发两条
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
    setTimeout(() => scrollToBottom(true, true), 30);

    // 在场闸门：她忙时回复更慢，"正在输入…"处显示一行状态小字
    const gate = presenceGate();
    if (gate.note) setBusyNote(gate.note);
    await new Promise((r) => setTimeout(r, gate.ms));
    setBusyNote(null);

    const streamId = -Date.now() - 1;
    let assistantText = '';
    let ids: any = null;

    try {
      const st = await renderChatStream({ content: text }, streamId);
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
      if (analysisTimerRef.current) clearInterval(analysisTimerRef.current);
      const timer = setInterval(async () => {
        try {
          const st = await (await fetch('/api/analyze', { cache: 'no-store' })).json();
          const done = !st?.busy && Number(st?.lastFinishedAt || 0) > enqueueAt;
          // 分析失败：真实错误在 st.last.error（旧代码看的 st.error 并不存在）
          const failed = !!st?.last && st.last.ok === false && Number(st.lastFinishedAt || 0) > enqueueAt;
          if (failed || st?.error || Date.now() - enqueueAt > 120000) {
            if (analysisTimerRef.current) clearInterval(analysisTimerRef.current);
            analysisTimerRef.current = null;
            setRecalling(false);
            return;
          }
          if (!done) return;
          if (analysisTimerRef.current) clearInterval(analysisTimerRef.current);
          analysisTimerRef.current = null;
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
      analysisTimerRef.current = timer;
    } catch (e: any) {
      setTyping(false);
      setToast(`发送失败：${e?.message || e}`);
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
    const last = messages[messages.length - 1];
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
    } catch (e: any) {
      setToast(`重新生成失败：${e?.message || e}`);
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
    try {
      const r = await fetch(`/api/messages?id=${m.id}&cascade=0`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) throw new Error(j?.error || '撤回失败');
      await loadMessages();
      setToast('已撤回她这条回复');
    } catch (e: any) {
      setToast(`撤回失败：${e?.message || e}`);
    }
  };

  const her = state?.persona?.agent_name || '她';
  const mood = state?.relationship?.mood || '平静';
  const stageName = state?.relationship?.stageName || '初识';
  const intimacy = Number(state?.relationship?.intimacy || 0);
  const scene = state?.relationship?.scene === 'offline' ? 'offline' : 'online';
  const sceneMode = (state?.relationship?.sceneMode || 'auto') as 'auto' | 'online' | 'offline';

  // 最后一条消息（仅它显示重新生成/撤回按钮）
  const lastMsg = messages.length ? messages[messages.length - 1] : null;
  const lastMsgId = lastMsg?.id || 0;

  // "她等了你 X 小时"：她最后一条（你还没回的）消息，距今 ≥ 1 小时
  const waitHint = (() => {
    if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.streaming) return null;
    const ts = new Date(lastMsg.created_at).getTime();
    if (!isFinite(ts)) return null;
    const ms = visitAtRef.current - ts;
    if (ms < 3600_000) return null;
    const h = Math.floor(ms / 3600_000);
    return h >= 24 ? `她等了你 ${Math.floor(h / 24)} 天` : `她等了你 ${h} 小时`;
  })();

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
              className={`btn-ghost !px-2 !py-1 text-[11px] ${evImmediateOpen ? '!bg-rose-100 !text-rose-700' : ''}`}
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
              onClick={() => eventAction({ action: 'end_event', mode: 'smart' })}
              title="按这类事情最自然的时长重新估算结束时间"
            >
              智能时长
            </button>
            <button
              className={`btn-ghost !px-2 !py-1 text-[11px] ${evCustomOpen ? '!bg-rose-100 !text-rose-700' : ''}`}
              disabled={evBusy}
              onClick={() => {
                setEvCustomOpen((v) => !v);
                setEvImmediateOpen(false);
              }}
              title="自己设定还有多少分钟后结束"
            >
              自定义时长
            </button>
            {evBusy ? <span className="animate-pulse-soft text-rose-500">处理中…</span> : null}
          </div>
        ) : null}
        {state?.life?.ongoingEvent && evImmediateOpen ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
            <span>按等效时长结束：假定「{state.life.ongoingEvent.activity}」持续了</span>
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
                  eventAction({ action: 'end_event', mode: 'immediate', hours: Number(evHours) });
                  setEvImmediateOpen(false);
                }
              }}
            />
            <span>小时（她恢复/消耗多少按这个算，然后立即结束）</span>
            <button
              className="btn !px-2.5 !py-1 text-[11px]"
              disabled={evBusy}
              onClick={() => {
                eventAction({ action: 'end_event', mode: 'immediate', hours: Number(evHours) });
                setEvImmediateOpen(false);
              }}
            >
              确定结束
            </button>
            <button
              className="btn-ghost !px-2 !py-1 text-[11px]"
              disabled={evBusy}
              onClick={() => {
                eventAction({ action: 'end_event', mode: 'immediate' });
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
                    if (sending) return;
                    setInput((cur) => (cur.trim() ? cur : s));
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
          {waitHint ? <div className="text-center text-[11px] text-ink-300">{waitHint}</div> : null}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`group flex items-center gap-1.5 ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-up`}
            >
              {m.role === 'assistant' ? (
                <button
                  onClick={() => {
                    setDelTarget(m);
                    setDelCascade(false);
                  }}
                  title="删除这条消息"
                  className="shrink-0 rounded-full border border-rose-100 bg-white/80 px-2 py-0.5 text-[11px] text-ink-300 opacity-50 transition hover:bg-rose-50 hover:text-rose-500 focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
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
                {m.role === 'assistant' && m.id === lastMsgId && !m.streaming && !sending ? (
                  <div className="mt-1 flex items-center gap-2 opacity-70 transition focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100">
                    <button className="btn-ghost !px-2 !py-0.5 text-[11px]" onClick={regenerate} title="让她重新说一遍">
                      重新生成
                    </button>
                    <button className="btn-ghost !px-2 !py-0.5 text-[11px]" onClick={() => withdraw(m)} title="撤回她这条回复">
                      撤回
                    </button>
                  </div>
                ) : null}
              </div>
              {m.role === 'user' ? (
                <button
                  onClick={() => {
                    setDelTarget(m);
                    setDelCascade(false);
                  }}
                  title="删除这条消息"
                  className="shrink-0 rounded-full border border-rose-100 bg-white/80 px-2 py-0.5 text-[11px] text-ink-300 opacity-50 transition hover:bg-rose-50 hover:text-rose-500 focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
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
                <span className="ml-2 text-[11px] text-ink-300">{busyNote || '对方正在输入…'}</span>
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
            onChange={(e) => {
              setInput(e.target.value);
              // 多行长文本自适应高度（最多 ~5 行）
              const el = e.target;
              el.style.height = 'auto';
              el.style.height = `${Math.min(Math.max(el.scrollHeight, 46), 128)}px`;
            }}
            onKeyDown={(e) => {
              // 中文/日文输入法组字中按 Enter 是"上屏候选词"，绝不能当发送（否则会发出半句话）
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            readOnly={sending}
          />
          <button className="btn h-[46px] px-5" onClick={() => send()} disabled={sending || !input.trim()}>
            {sending ? '…' : '发送'}
          </button>
        </div>
      </div>

      {delTarget ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/40 p-4 backdrop-blur-sm md:items-center"
          role="dialog"
          aria-modal="true"
          aria-label="删除这条消息？"
          onClick={() => setDelTarget(null)}
        >
          <div
            className="w-full max-w-md animate-fade-up rounded-3xl bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
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
              <button ref={delCancelRef} className="btn-ghost" onClick={() => setDelTarget(null)} disabled={deleting}>
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