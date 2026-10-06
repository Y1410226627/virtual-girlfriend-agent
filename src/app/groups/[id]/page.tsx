'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { PageHeader, Loading, ErrorBox, Toast, Chip } from '@/components/ui';
import { GroupChatView } from '@/components/groups/GroupChatView';
import { GroupComposer } from '@/components/groups/GroupComposer';
import { colorOf, runStatusLabel, type GroupDetailData, type GroupMessage, type GroupRunView } from '@/components/groups/shared';
import { errMsg } from '@/lib/utils';

export default function GroupChatPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const gid = Math.trunc(Number(params?.id));

  const [detail, setDetail] = useState<GroupDetailData | null>(null);
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [run, setRun] = useState<GroupRunView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!Number.isFinite(gid) || gid <= 0) {
      setError('群不存在');
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const r = await fetch(`/api/groups/${gid}`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.group) throw new Error(j?.error || `HTTP ${r.status}`);
      const d = j as GroupDetailData;
      setDetail(d);
      setMessages(d.messages ?? []);
      setRun(d.run ?? null);
      setError(null);
      // 已读：记录本地已看到的最后一条群消息 id（供导航未读角标）
      const last = (d.messages ?? []).at(-1);
      if (last) window.localStorage.setItem(`groupRead:${gid}`, String(last.id));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [gid]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const r = await fetch(`/api/groups/${gid}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        const newMsgs: GroupMessage[] = Array.isArray(j?.messages) ? (j.messages as GroupMessage[]) : [];
        if (newMsgs.length) {
          setMessages((prev) => [...prev, ...newMsgs]);
          const last = newMsgs.at(-1);
          if (last) window.localStorage.setItem(`groupRead:${gid}`, String(last.id));
        }
        if (j?.run !== undefined) setRun((j.run as GroupRunView | null) ?? null);
        if (!r.ok) throw new Error(j?.error || `发送失败 ${r.status}`);
      } catch (e) {
        setToast(errMsg(e) || '发送失败');
      } finally {
        setBusy(false);
      }
    },
    [gid]
  );

  const send = useCallback(
    async (text: string) => {
      setValue('');
      await post({ content: text });
    },
    [post]
  );

  const onContinue = useCallback(() => {
    void post({ continue: true });
  }, [post]);

  const onStop = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/groups/${gid}/stop`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || '停止失败');
      setRun((j.run as GroupRunView | null) ?? null);
      setToast('已停止本轮的后续发言');
      await load();
    } catch (e) {
      setToast(errMsg(e) || '停止失败');
    } finally {
      setBusy(false);
    }
  }, [gid, load]);

  const members = useMemo(() => detail?.members ?? [], [detail]);

  if (loading && !detail) return <Loading text="正在进入群聊…" />;
  if (error && !detail) return <ErrorBox message={error} onRetry={load} />;
  if (!detail) return <ErrorBox message="群不存在" onRetry={load} />;

  return (
    <div className="pb-10">
      {error ? <ErrorBox message={error} onRetry={load} /> : null}
      <PageHeader
        title={detail.group.name}
        desc={detail.group.topic ? `话题：${detail.group.topic}` : '随便聊聊'}
        right={
          <div className="flex items-center gap-1.5">
            <Chip tone={run?.status === 'running' ? 'rose' : 'plain'}>
              {runStatusLabel(run?.status)}
              {run ? ` · ${run.round}/${run.max_rounds}` : ''}
            </Chip>
            <Link className="btn-ghost" href="/groups">
              返回
            </Link>
          </div>
        }
      />

      <div className="px-5 md:px-8">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {members.map((m) => (
            <span key={m.id} className="flex items-center gap-1.5 text-xs ink-2">
              <span
                className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] text-white"
                style={{ backgroundColor: colorOf(m.id) }}
                aria-hidden
              >
                {(m.name || '她').slice(0, 1)}
              </span>
              {m.name}
            </span>
          ))}
          <button className="btn-ghost ml-auto" onClick={() => router.push('/groups/new')}>
            解散 / 新建
          </button>
        </div>

        <GroupChatView messages={messages} />

        <div className="mt-3">
          <GroupComposer
            members={members}
            value={value}
            onChange={setValue}
            onSend={send}
            onContinue={onContinue}
            onStop={onStop}
            busy={busy}
            run={run}
          />
        </div>
      </div>

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}
