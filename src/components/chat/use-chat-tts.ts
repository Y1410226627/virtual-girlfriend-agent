'use client';

import { useEffect, useRef, useState } from 'react';
import { errMsg } from '@/lib/utils';
import type { Msg } from '@/components/chat/shared';

/* 语音条：单条朗读（/api/tts）、停止与 blob URL 回收（原 page.tsx 逻辑原样搬移） */
export function useChatTts(setToast: (v: string | null) => void) {
  // 当前正在朗读的消息 id（null = 没有在播）
  const [playingId, setPlayingId] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null); // 当前在播的语音
  const audioUrlRef = useRef<string | null>(null); // 对应 blob URL，需回收

  /* 卸载时顺手停掉可能在播的语音、回收 blob URL */
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, []);

  /* 停掉当前播放并回收 blob URL */
  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
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
    if (playingId === m.id) {
      stopAudio();
      return;
    }
    stopAudio();
    const text = ttsText(m.content);
    if (!text) {
      setToast('这条没什么可读的');
      return;
    }
    setPlayingId(m.id); // 立刻给出"加载中/在播"的视觉反馈
    try {
      const r = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setPlayingId(null);
        setToast(j?.error || '语音生成失败');
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audioUrlRef.current = url;
      audio.onended = () => {
        if (audioUrlRef.current === url) {
          URL.revokeObjectURL(url);
          audioUrlRef.current = null;
        }
        audioRef.current = null;
        setPlayingId(null);
      };
      audio.onerror = () => {
        setToast('语音播放失败');
        stopAudio();
      };
      await audio.play();
    } catch (e) {
      setToast(`语音播放失败：${errMsg(e)}`);
      stopAudio();
    }
  };

  return { playingId, playTts };
}