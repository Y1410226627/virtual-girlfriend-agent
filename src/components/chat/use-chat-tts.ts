'use client';

import { useEffect, useRef, useState } from 'react';
import { errMsg } from '@/lib/utils';
import type { Msg } from '@/components/chat/shared';

/* 语音条：单条朗读（/api/tts）、停止与 blob URL 回收（原 page.tsx 逻辑原样搬移） */
export function useChatTts(setToast: (v: string | null) => void) {
  // 当前正在朗读的消息 id（null = 没有在播）
  const [playingId, setPlayingId] = useState<number | null>(null);
  const playingIdRef = useRef<number | null>(null); // 与 state 同步的即时值，避免闭包读到滞后的 playingId
  const audioRef = useRef<HTMLAudioElement | null>(null); // 当前在播的语音
  const audioUrlRef = useRef<string | null>(null); // 对应 blob URL，需回收
  const sessionRef = useRef(0); // 会话 token：每次 play/stop 递增，用来作废"停在半路"的异步请求

  /* 卸载时顺手停掉可能在播的语音、回收 blob URL，并作废进行中的请求 */
  useEffect(() => {
    return () => {
      sessionRef.current += 1;
      const a = audioRef.current;
      if (a) {
        a.onended = null;
        a.onerror = null;
        a.pause();
        audioRef.current = null;
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, []);

  /* 停掉当前播放并回收 blob URL；同时递增 token，让仍在 await 的旧播放请求作废 */
  const stopAudio = () => {
    sessionRef.current += 1;
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.onended = null;
      a.onerror = null;
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    playingIdRef.current = null;
    setPlayingId(null);
  };

  /* 朗读文本清洗：去掉表情包标记与（动作）这类舞台提示，避免念出来很奇怪 */
  const ttsText = (content: string) =>
    String(content || '')
      .replace(/\[\[\s*(?:sticker|表情包)\s*[:：]?\s*[a-z_]+\s*\]\]/gi, ' ')
      .replace(/（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  /* 朗读一条她的消息：同一个按钮再点一次 = 停止；同时只允许一个在播 */
  const playTts = async (m: Msg) => {
    if (playingIdRef.current === m.id) {
      stopAudio();
      return;
    }
    // 切换朗读目标：先停掉旧的（含进行中的请求作废），旧 audio 不会被新请求覆盖
    stopAudio();
    const token = sessionRef.current; // 本次播放的会话 token
    const text = ttsText(m.content);
    if (!text) {
      setToast('这条没什么可读的');
      return;
    }
    playingIdRef.current = m.id;
    setPlayingId(m.id); // 立刻给出"加载中/在播"的视觉反馈
    try {
      const r = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (token !== sessionRef.current) return; // 期间被停止/换条：丢弃，不创建 audio
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        if (token !== sessionRef.current) return;
        playingIdRef.current = null;
        setPlayingId(null);
        setToast(j?.error || '语音生成失败');
        return;
      }
      const blob = await r.blob();
      if (token !== sessionRef.current) return;
      const url = URL.createObjectURL(blob);
      if (token !== sessionRef.current) {
        URL.revokeObjectURL(url); // 已被取代：回收刚建的 blob，避免泄漏
        return;
      }
      const audio = new Audio(url);
      audioRef.current = audio;
      audioUrlRef.current = url;
      audio.onended = () => {
        if (audioRef.current === audio) {
          audioRef.current = null;
          playingIdRef.current = null;
          setPlayingId(null);
        }
        if (audioUrlRef.current === url) {
          URL.revokeObjectURL(url);
          audioUrlRef.current = null;
        }
      };
      audio.onerror = () => {
        if (token !== sessionRef.current) return;
        setToast('语音播放失败');
        stopAudio();
      };
      await audio.play();
    } catch (e) {
      if (token !== sessionRef.current) return;
      setToast(`语音播放失败：${errMsg(e)}`);
      stopAudio();
    }
  };

  return { playingId, playTts };
}