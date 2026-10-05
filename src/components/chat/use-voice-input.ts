'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { errMsg } from '@/lib/utils';

/**
 * 语音输入：浏览器 MediaRecorder 录音 → POST /api/asr（用户自配的兼容 /audio/transcriptions 服务）
 * → 拿到文字交给 onText 填进输入框。音频只发往用户自己配置的端点，不接第三方。
 *
 * 未配置 ASR 时 `enabled` 为 false，Composer 据此不显示麦克风按钮。
 */
export function useVoiceInput(onText: (text: string) => void) {
  const [enabled, setEnabled] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);
  const startedAtRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // 是否启用：未配置时不显示麦克风按钮（只看开关+地址+Key 是否齐全，Key 不回传）
  useEffect(() => {
    let alive = true;
    fetch('/api/asr', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { enabled?: unknown }) => {
        if (alive) setEnabled(!!j?.enabled);
      })
      .catch(() => {
        /* 静默：拿不到就当未配置 */
      });
    return () => {
      alive = false;
    };
  }, []);

  // 卸载兜底：停止计时与采集，避免"切走页面后麦克风还亮着"
  useEffect(
    () => () => {
      clearTimer();
      releaseStream();
    },
    [clearTimer, releaseStream]
  );

  const transcribe = useCallback(async (blob: Blob) => {
    setTranscribing(true);
    try {
      const fd = new FormData();
      fd.append('file', blob, 'voice.webm');
      const r = await fetch('/api/asr', { method: 'POST', body: fd });
      const j = (await r.json().catch(() => ({}))) as { text?: unknown; error?: unknown };
      const text = typeof j?.text === 'string' ? j.text : '';
      if (!r.ok || !text) throw new Error(typeof j?.error === 'string' ? j.error : '没有听清，再说一次试试');
      onTextRef.current(text);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setTranscribing(false);
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (recorderRef.current) return;
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('当前浏览器不支持录音（建议用 Chrome / Edge）');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        clearTimer();
        setRecording(false);
        setSeconds(0);
        recorderRef.current = null;
        releaseStream();
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        chunksRef.current = [];
        if (cancelledRef.current) {
          cancelledRef.current = false;
          return;
        }
        // 极短的一段（误触）不送转写
        if (blob.size === 0 || Date.now() - startedAtRef.current < 400) {
          setError('说话时间太短了');
          return;
        }
        void transcribe(blob);
      };
      recorderRef.current = rec;
      startedAtRef.current = Date.now();
      rec.start();
      setRecording(true);
      setSeconds(0);
      clearTimer();
      timerRef.current = setInterval(() => {
        setSeconds(Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000)));
      }, 250);
    } catch (e) {
      releaseStream();
      setError(errMsg(e));
    }
  }, [clearTimer, releaseStream, transcribe]);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state === 'inactive') return;
    cancelledRef.current = false;
    rec.stop();
  }, []);

  const cancel = useCallback(() => {
    const rec = recorderRef.current;
    cancelledRef.current = true;
    if (rec && rec.state !== 'inactive') rec.stop();
    clearTimer();
    setRecording(false);
    setSeconds(0);
  }, [clearTimer]);

  const toggle = useCallback(() => {
    if (recording) stop();
    else void start();
  }, [recording, start, stop]);

  return { enabled, recording, transcribing, seconds, error, start, stop, cancel, toggle };
}