'use client';

import { useEffect, useRef, useState } from 'react';
import { Chip, fmtTime } from '@/components/ui';
import { TYPES } from './shared';
import type { MemoryItem } from './shared';

/** 重要度滑杆：拖动时只改本地值，松手/失焦才提交一次 */
function ImportanceSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [local, setLocal] = useState(value);
  const committed = useRef(value);
  useEffect(() => {
    setLocal(value);
    committed.current = value;
  }, [value]);
  const commit = () => {
    if (local !== committed.current) {
      committed.current = local;
      onChange(local);
    }
  };
  return (
    <input
      type="range"
      min={0}
      max={10}
      value={local}
      aria-label="重要度"
      className="h-1 w-20 accent-rose-500"
      onChange={(e) => setLocal(Number(e.target.value))}
      onMouseUp={commit}
      onTouchEnd={commit}
      onBlur={commit}
    />
  );
}

export function MemoryList({
  memories,
  editing,
  draft,
  setDraft,
  setEditing,
  saveEdit,
  remove,
  changeImportance,
}: {
  memories: MemoryItem[];
  editing: number | null;
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setEditing: React.Dispatch<React.SetStateAction<number | null>>;
  saveEdit: (id: number) => void;
  remove: (id: number) => void;
  changeImportance: (id: number, importance: number) => void;
}) {
  return (
    <div className="space-y-3 px-5 pt-4 md:px-8">
      {memories.length === 0 ? (
        <div className="card dim text-center">这里还是空的，多聊聊她就会记住你的事了。</div>
      ) : null}
      {memories.map((m) => (
        <div key={m.id} className="card-tight">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Chip>{TYPES.find((t) => t.key === m.type)?.label || m.type}</Chip>
                <span className="text-[11px] ink-3">
                  重要度 {m.importance} · {fmtTime(m.created_at)}
                  {m.access_count ? ` · 被想起 ${m.access_count} 次` : ''}
                </span>
                {m.emotion ? <Chip tone="plain">{m.emotion}</Chip> : null}
              </div>
              {editing === m.id ? (
                <div className="mt-2">
                  <textarea className="textarea" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} />
                  <div className="mt-2 flex gap-2">
                    <button className="btn" onClick={() => saveEdit(m.id)}>
                      保存
                    </button>
                    <button className="btn-ghost" onClick={() => setEditing(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-sm leading-relaxed ink-1 break-words">{m.content}</p>
              )}
            </div>
            {editing === m.id ? null : (
              <div className="flex shrink-0 flex-col gap-1.5">
                <button
                  className="btn-ghost !px-2.5 !py-1 text-xs"
                  onClick={() => {
                    setEditing(m.id);
                    setDraft(m.content);
                  }}
                >
                  编辑
                </button>
                <ImportanceSlider value={m.importance} onChange={(v) => changeImportance(m.id, v)} />
                <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => remove(m.id)}>
                  删除
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}