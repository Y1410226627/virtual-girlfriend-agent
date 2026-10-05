'use client';

import { Card, Chip } from '@/components/ui';
import type { CastMember, PostFn } from './shared';

export function CastCard({
  cast,
  busy,
  post,
  editCast,
  setEditCast,
  castDraft,
  setCastDraft,
}: {
  cast?: CastMember[];
  busy: boolean;
  post: PostFn;
  editCast: boolean;
  setEditCast: React.Dispatch<React.SetStateAction<boolean>>;
  castDraft: Array<{ name: string; role: string; note: string }>;
  setCastDraft: React.Dispatch<React.SetStateAction<Array<{ name: string; role: string; note: string }>>>;
}) {
  return (
    <Card
      title="她身边的人"
      right={
        <button
          className="btn-ghost"
          onClick={() => {
            setCastDraft(
              editCast
                ? []
                : (cast || []).map((c) => ({ name: c.name || '', role: c.role || '', note: c.note || '' }))
            );
            setEditCast((v) => !v);
          }}
          title="编辑她身边的人（室友、闺蜜……）"
        >
          {editCast ? '收起' : '编辑'}
        </button>
      }
    >
      {cast?.length ? (
        <div className="space-y-2">
          {cast.map((c, i) => (
            <div key={i} className="flex items-start gap-3 rounded-2xl border line surf px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium ink-1">{c.name}</span>
                  {c.role ? <Chip tone="plain">{c.role}</Chip> : null}
                </div>
                {c.note ? <div className="dim mt-1">{c.note}</div> : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="dim">她身边还没有登记的人。</p>
      )}

      {editCast ? (
        <div className="mt-4 rounded-2xl border line surf p-3.5">
          <div className="space-y-3">
            {castDraft.map((c, i) => (
              <div key={i} className="rounded-2xl border line surf p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs ink-2">第 {i + 1} 位</span>
                  <button
                    className="btn-ghost !py-1 text-xs"
                    onClick={() => setCastDraft((d) => d.filter((_, k) => k !== i))}
                  >
                    删除
                  </button>
                </div>
                <div className="mt-2 grid gap-2 md:grid-cols-3">
                  <div>
                    <label className="label">名字</label>
                    <input
                      className="input"
                      maxLength={12}
                      value={c.name}
                      placeholder="例如：小夏"
                      onChange={(e) => setCastDraft((d) => d.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))}
                    />
                  </div>
                  <div>
                    <label className="label">关系</label>
                    <input
                      className="input"
                      maxLength={10}
                      value={c.role}
                      placeholder="例如：室友"
                      onChange={(e) => setCastDraft((d) => d.map((x, k) => (k === i ? { ...x, role: e.target.value } : x)))}
                    />
                  </div>
                  <div>
                    <label className="label">备注</label>
                    <input
                      className="input"
                      maxLength={60}
                      value={c.note}
                      placeholder="例如：同一个宿舍，爱睡懒觉"
                      onChange={(e) => setCastDraft((d) => d.map((x, k) => (k === i ? { ...x, note: e.target.value } : x)))}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
          {castDraft.length < 6 ? (
            <button
              className="btn-ghost mt-3"
              onClick={() => setCastDraft((d) => [...d, { name: '', role: '', note: '' }])}
            >
              + 再加一位
            </button>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              className="btn"
              disabled={busy || !castDraft.length || castDraft.some((c) => !c.name.trim())}
              onClick={async () => {
                await post(
                  {
                    action: 'set_cast',
                    cast: castDraft.map((c) => ({ name: c.name.trim(), role: c.role.trim(), note: c.note.trim() })),
                  },
                  '已保存她身边的人'
                );
                setEditCast(false);
              }}
            >
              保存
            </button>
            <button className="btn-ghost" onClick={() => setEditCast(false)}>
              取消
            </button>
            <span className="dim">她聊天时会自然提到这些人（她们也有自己的事），但不会每轮都提。</span>
          </div>
        </div>
      ) : null}
    </Card>
  );
}