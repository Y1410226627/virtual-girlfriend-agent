'use client';

interface ComposerProps {
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  sending: boolean;
  onSend: () => void;
  stickerOpen: boolean;
  onToggleSticker: () => void;
  stickerBtnRef: React.RefObject<HTMLButtonElement | null>;
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
  return (
    <div className="mx-auto flex max-w-3xl items-end gap-2">
      <button
        ref={stickerBtnRef}
        className={`btn-ghost h-[46px] px-3.5 ${stickerOpen ? '!accent-soft !acc' : ''}`}
        onClick={onToggleSticker}
        title="表情包"
        aria-label="表情包"
      >
        😊
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
            onSend();
          }
        }}
        readOnly={sending}
      />
      <button className="btn h-[46px] px-5" onClick={onSend} disabled={sending || !input.trim()}>
        {sending ? '…' : '发送'}
      </button>
    </div>
  );
}