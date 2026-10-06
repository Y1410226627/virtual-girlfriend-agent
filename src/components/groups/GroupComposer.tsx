'use client';

import { useState } from 'react';
import { colorOf, type GroupMemberLite, type GroupRunView } from './shared';

/**
 * 群输入框：文本 + @ 指定（点成员名插入 @名字）+ 发送/继续/停止。
 * 运行中显示「停止」；已结束/已停止显示「继续」；发送中禁用。
 */
export function GroupComposer({
  members,
  value,
  onChange,
  onSend,
  onContinue,
  onStop,
  busy,
  run,
}: {
  members: GroupMemberLite[];
  value: string;
  onChange: (v: string) => void;
  onSend: (text: string) => void;
  onContinue: () => void;
  onStop: () => void;
  busy: boolean;
  run: GroupRunView | null;
}) {
  const [showMentions, setShowMentions] = useState(false);
  const running = run?.status === 'running';

  const insertMention = (name: string) => {
    const prefix = value && !value.endsWith(' ') ? `${value} ` : value;
    onChange(`${prefix}@${name} `);
    setShowMentions(false);
  };

  const submit = () => {
    const t = value.trim();
    if (!t || busy) return;
    onSend(t);
  };

  return (
    <div className="card-tight">
      {showMentions ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {members.map((m) => (
            <button
              key={m.id}
              type="button"
              className="chip"
              style={{ color: colorOf(m.id), borderColor: colorOf(m.id) }}
              onClick={() => insertMention(m.name)}
            >
              @{m.name}
            </button>
          ))}
        </div>
      ) : null}

      <textarea
        className="w-full resize-none rounded-2xl surf border line px-3.5 py-2.5 text-sm ink-1 outline-none"
        rows={2}
        placeholder="在群里说点什么……（用 @ 指定某人必须回应）"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />

      <div className="mt-2 flex items-center gap-2">
        <button type="button" className="btn-ghost" onClick={() => setShowMentions((v) => !v)} disabled={busy}>
          @ 指定
        </button>
        <div className="flex-1" />
        {running ? (
          <button type="button" className="btn-ghost" onClick={onStop} disabled={busy}>
            停止
          </button>
        ) : (
          <button type="button" className="btn-ghost" onClick={onContinue} disabled={busy}>
            继续
          </button>
        )}
        <button type="button" className="btn" onClick={submit} disabled={busy || !value.trim()}>
          {busy ? '发送中…' : '发送'}
        </button>
      </div>
    </div>
  );
}
