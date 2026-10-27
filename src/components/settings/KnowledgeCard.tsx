'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Card, Chip } from '@/components/ui';

interface KbDoc {
  id: number;
  title: string;
  source: string | null;
  char_count: number;
  chunk_count: number;
  created_at: string;
}

/**
 * 知识库卡片：导入 .txt/.md 或直接粘贴资料，让她"读过"这些内容。
 * 内容只存在本机数据库；聊天时最多引用 3 段最相关的片段（按话题自动检索）。
 */
export function KnowledgeCard({ companionId }: { companionId: number }) {
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/knowledge?companionId=${companionId}`);
      const j = await r.json();
      if (Array.isArray(j?.docs)) setDocs(j.docs as KbDoc[]);
    } catch {
      /* 读取失败时保持列表不变 */
    }
  }, [companionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const body = await f.text();
    setText(body);
    if (!title.trim()) setTitle(f.name.replace(/\.[^.]+$/, ''));
    e.target.value = '';
  };

  const importNow = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/knowledge?companionId=${companionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, text: body, source: 'paste' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        setMsg(String(j?.error || '导入失败'));
      } else {
        setMsg(`已导入：${j.chunks} 段`);
        setTitle('');
        setText('');
        await load();
      }
    } catch {
      setMsg('导入失败：网络异常');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/knowledge?companionId=${companionId}&id=${id}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) setMsg(String(j?.error || '删除失败'));
      else setMsg('已删除');
      setConfirmId(null);
      await load();
    } catch {
      setMsg('删除失败：网络异常');
    } finally {
      setBusy(false);
    }
  };

  const total = docs.length;

  return (
    <Card title="知识库（她读过的资料）" right={<Chip tone="plain">{total} 篇</Chip>}>
      <p className="dim leading-relaxed">
        把设定集、日记、备忘等资料导入，她聊天时会按话题自然引用（最多 3 段最相关的内容）。
        内容只保存在<b>本机</b>的数据库里、不会上传；单篇最多 60000 字，最多 30 篇。
      </p>

      <div className="mt-3 grid gap-3">
        <div>
          <label className="label" htmlFor="kb_title">
            标题
          </label>
          <input
            id="kb_title"
            className="input"
            value={title}
            maxLength={80}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：我们的设定集 / 我的日记"
          />
        </div>
        <div>
          <label className="label" htmlFor="kb_text">
            内容（也可从文件读入）
          </label>
          <textarea
            id="kb_text"
            className="textarea min-h-[120px]"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="粘贴文字，或点下面的「选择文件」读入 .txt / .md"
          />
          <div className="mt-1 text-[11px] ink-3">{text.length} 字</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".txt,.md,.markdown,text/plain" className="hidden" onChange={pickFile} />
          <button className="btn-ghost" type="button" onClick={() => fileRef.current?.click()} disabled={busy}>
            选择文件
          </button>
          <button className="btn" type="button" onClick={importNow} disabled={busy || !text.trim()}>
            {busy ? '处理中…' : '导入'}
          </button>
          {msg ? <span className="text-[11px] acc">{msg}</span> : null}
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {docs.length === 0 ? (
          <p className="text-[11px] ink-3">还没有导入任何资料。</p>
        ) : (
          docs.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-2 rounded-xl border line px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm ink-1">{d.title}</span>
              <span className="text-[11px] ink-3">
                {d.chunk_count} 段 · {d.char_count} 字
              </span>
              {confirmId === d.id ? (
                <>
                  <button className="btn-ghost !px-2 !py-1 text-[11px]" type="button" onClick={() => remove(d.id)} disabled={busy}>
                    确认删除
                  </button>
                  <button className="btn-ghost !px-2 !py-1 text-[11px]" type="button" onClick={() => setConfirmId(null)} disabled={busy}>
                    取消
                  </button>
                </>
              ) : (
                <button className="btn-ghost !px-2 !py-1 text-[11px]" type="button" onClick={() => setConfirmId(d.id)} disabled={busy}>
                  删除
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
