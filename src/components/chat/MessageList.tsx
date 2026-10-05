'use client';

import MessageBubble from './MessageBubble';
import type { Msg, Sticker } from './shared';

const SUGGESTIONS = ['今天过得怎么样？', '我今天遇到一件挺烦的事', '你刚才在忙什么呀？', '有点想你了'];

interface MessageListProps {
  listRef: React.RefObject<HTMLDivElement | null>;
  loadErr: string | null;
  messages: Msg[];
  onboard: boolean;
  sending: boolean;
  typing: boolean;
  busyNote: string | null;
  waitHint: string | null;
  lastMsgId: number;
  playingId: number | null;
  ttsEnabled?: boolean;
  stickers?: Sticker[];
  setInput: React.Dispatch<React.SetStateAction<string>>;
  send: (override?: string) => void | Promise<void>;
  onRequestDelete: (m: Msg) => void;
  onPlayTts: (m: Msg) => void;
  onRegenerate: () => void;
  onWithdraw: (m: Msg) => void;
  nameDraft: { user_name: string; agent_name: string };
  setNameDraft: React.Dispatch<React.SetStateAction<{ user_name: string; agent_name: string }>>;
  onSaveOnboard: () => void;
  onSkipOnboard: () => void;
}

export default function MessageList({
  listRef,
  loadErr,
  messages,
  onboard,
  sending,
  typing,
  busyNote,
  waitHint,
  lastMsgId,
  playingId,
  ttsEnabled,
  stickers,
  setInput,
  send,
  onRequestDelete,
  onPlayTts,
  onRegenerate,
  onWithdraw,
  nameDraft,
  setNameDraft,
  onSaveOnboard,
  onSkipOnboard,
}: MessageListProps) {
  return (
    <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 md:px-8">
      {loadErr ? (
        <div className="mx-auto max-w-md rounded-2xl border line accent-soft px-4 py-3 text-xs acc">
          {loadErr}
        </div>
      ) : null}

      {messages.length === 0 && !onboard ? (
        <div className="mx-auto mt-16 max-w-md text-center">
          <div className="text-4xl">💌</div>
          <p className="mt-4 text-sm leading-relaxed ink-2">
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
          <h2 className="text-base font-semibold ink-1">先认识一下吧</h2>
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
              <button className="btn" onClick={onSaveOnboard}>
                就这么定了
              </button>
              <button className="btn-ghost" onClick={onSkipOnboard}>
                先跳过
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="mx-auto max-w-3xl space-y-3">
        {waitHint ? <div className="text-center text-[11px] ink-3">{waitHint}</div> : null}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            m={m}
            stickers={stickers}
            ttsEnabled={ttsEnabled}
            playingId={playingId}
            lastMsgId={lastMsgId}
            sending={sending}
            onRequestDelete={onRequestDelete}
            onPlayTts={onPlayTts}
            onRegenerate={onRegenerate}
            onWithdraw={onWithdraw}
          />
        ))}

        {typing ? (
          <div className="flex justify-start">
            <div className="bubble-agent flex items-center gap-1 border line surf px-4 py-3 shadow-bubble">
              <span className="dot-1 h-1.5 w-1.5 rounded-full bg-rose-400" />
              <span className="dot-2 h-1.5 w-1.5 rounded-full bg-rose-400" />
              <span className="dot-3 h-1.5 w-1.5 rounded-full bg-rose-400" />
              <span className="ml-2 text-[11px] ink-3">{busyNote || '对方正在输入…'}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}