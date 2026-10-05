'use client';

import { useEffect, useRef, useState } from 'react';
import { errMsg } from '@/lib/utils';
import { useVoiceInput } from './use-voice-input';

interface ComposerProps {
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  sending: boolean;
  onSend: () => void;
  stickerOpen: boolean;
  onToggleSticker: () => void;
  stickerBtnRef: React.RefObject<HTMLButtonElement | null>;
}

/** 单轮最多附几张图（与后端一致；此处本地常量，避免把服务端模块打进前端包） */
const MAX_IMAGES = 2;
/** 压缩后最长边 / JPEG 质量 */
const MAX_SIDE = 1024;
const JPEG_QUALITY = 0.8;

/**
 * 待发送图片的跨组件暂存：Composer 选中/压缩的图，use-chat-stream 在 send() 时读取。
 * （page.tsx 只做了输入框与发送的接线，这里用模块级单例，避免改动其它组件文件。）
 */
export const composerAttachments: { images: string[] } = { images: [] };

/** 选图 → canvas 压缩到最长边 ≤MAX_SIDE、JPEG 质量 0.8 → dataURL */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片读取失败'));
    img.src = src;
  });
}

async function compressImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width || 1, img.height || 1));
    const w = Math.max(1, Math.round((img.width || 1) * scale));
    const h = Math.max(1, Math.round((img.height || 1) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('图片处理失败');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function Composer({
  input,
  setInput,
  sending,
  onSend,
  stickerOpen,
  onToggleSticker,
  stickerBtnRef,
}: ComposerProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<string[]>([]);
  const [imgError, setImgError] = useState<string | null>(null);

  const voice = useVoiceInput((text) => setInput((cur) => (cur.trim() ? `${cur} ${text}` : text)));

  // 图片列表同步到跨组件暂存（send() 从这里取）
  useEffect(() => {
    composerAttachments.images = images;
  }, [images]);

  // 高度自适应：value 变化（含发送后编程式清空、插入表情包等）都要重算，
  // 不能只在 onChange 里调，否则清空后高度会残留上一段多行文本的高。
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 46), 128)}px`;
  }, [input]);

  const addFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      setImgError(`最多只能发 ${MAX_IMAGES} 张图片`);
      return;
    }
    const picked = Array.from(files)
      .filter((f) => f.type.startsWith('image/'))
      .slice(0, room);
    if (!picked.length) {
      setImgError('只能选图片文件');
      return;
    }
    try {
      const out: string[] = [];
      for (const f of picked) out.push(await compressImage(f));
      setImages((prev) => [...prev, ...out].slice(0, MAX_IMAGES));
      setImgError(null);
    } catch (e) {
      setImgError(errMsg(e));
    }
  };

  const canSend = !sending && (!!input.trim() || images.length > 0);
  // 先触发发送（send() 会同步读取 composerAttachments），再清空预览
  const handleSend = () => {
    if (!canSend) return;
    onSend();
    setImages([]);
  };

  const err = imgError || voice.error;

  return (
    <div className="mx-auto max-w-3xl">
      {images.length ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {images.map((src, i) => (
            <div key={i} className="relative">
              <img
                src={src}
                alt="待发送的图片"
                className="h-16 w-16 rounded-xl border line object-cover shadow-soft"
              />
              <button
                type="button"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                title="移除这张"
                aria-label="移除这张图片"
                className="absolute -right-1.5 -top-1.5 rounded-full border line surf px-1.5 text-[10px] ink-3 transition hover:accent-soft hover:acc"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {voice.recording ? (
        <div className="mb-2 flex items-center justify-between rounded-2xl border line surf px-3 py-2">
          <div className="flex items-center gap-2 text-xs ink-2" role="status" aria-live="polite">
            <span className="h-2 w-2 animate-pulse-soft rounded-full bg-rose-500" />
            <span>正在听…</span>
            <span className="tabular-nums ink-3">{fmtDuration(voice.seconds)}</span>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-ghost !px-2 !py-0.5 text-[11px]" onClick={voice.stop}>
              停止并转写
            </button>
            <button className="btn-ghost !px-2 !py-0.5 text-[11px]" onClick={voice.cancel}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {voice.transcribing ? (
        <div className="mb-2 text-[11px] ink-3" role="status" aria-live="polite">
          正在识别…
        </div>
      ) : null}

      {err ? (
        <div className="mb-2 text-[11px] acc" role="alert">
          {err}
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <button
          ref={stickerBtnRef}
          className={`btn-ghost h-[46px] px-3.5 ${stickerOpen ? '!accent-soft !acc' : ''}`}
          onClick={onToggleSticker}
          title="表情包"
          aria-label="表情包"
        >
          😊
        </button>
        <button
          className="btn-ghost h-[46px] px-3.5"
          onClick={() => fileRef.current?.click()}
          title="发图片给她看（最多 2 张）"
          aria-label="发图片"
        >
          🖼
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        {voice.enabled ? (
          <button
            className={`btn-ghost h-[46px] px-3.5 ${voice.recording ? '!accent-soft !acc' : ''}`}
            onClick={voice.toggle}
            disabled={voice.transcribing}
            title={voice.recording ? '正在听…点击停止' : '按住/点击说话'}
            aria-label={voice.recording ? '停止录音' : '语音输入'}
            aria-pressed={voice.recording}
          >
            {voice.recording ? '⏺' : '🎤'}
          </button>
        ) : null}
        <textarea
          ref={taRef}
          className="textarea max-h-32 min-h-[46px] flex-1 py-3"
          rows={1}
          placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // 中文/日文输入法组字中按 Enter 是"上屏候选词"，绝不能当发送（否则会发出半句话）
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button className="btn h-[46px] px-5" onClick={handleSend} disabled={!canSend}>
          {sending ? '…' : '发送'}
        </button>
      </div>
    </div>
  );
}