'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { PageHeader, Loading, ErrorBox, Toast, Chip } from '@/components/ui';
import { GroupChatView } from '@/components/groups/GroupChatView';
import { GroupComposer } from '@/components/groups/GroupComposer';
import { DateScheduleView } from '@/components/activities/DateScheduleView';
import {
  colorOf,
  type GroupMemberLite,
  type GroupMessage,
  type GroupRunView,
} from '@/components/groups/shared';
import {
  activityStatusLabel,
  ACTIVITY_KIND_ICON,
  ACTIVITY_KIND_LABEL,
  templateLabel,
  type ActivityDetailData,
  type ActivityRowView,
  type ActivityScheduleItem,
} from '@/components/activities/shared';
import { errMsg } from '@/lib/utils';

/**
 * 活动房间：线上=群聊式互动；线下=约会日程 + 轮流聚焦 + 群聊式互动。
 * 复用群聊的展示（GroupChatView）与输入（GroupComposer），发言走 /api/activities/[id]/messages。
 */
export default function ActivityRoomPage() {
  const params = useParams<{ id: string }>();
  const aid = Math.trunc(Number(params?.id));

  const [detail, setDetail] = useState<ActivityDetailData | null>(null);
  const [activity, setActivity] = useState<ActivityRowView | null>(null);
  const [schedule, setSchedule] = useState<ActivityScheduleItem[]>([]);
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [run, setRun] = useState<GroupRunView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!Number.isFinite(aid) || aid <= 0) {
      setError('活动不存在');
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const r = await fetch(`/api/activities/${aid}`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.activity) throw new Error(j?.error || `HTTP ${r.status}`);
      const d = j as ActivityDetailData;
      setDetail(d);
      setActivity(d.activity);
      setSchedule(d.schedule ?? []);
      setMessages(d.messages ?? []);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [aid]);

  useEffect(() => {
    void load();
  }, [load]);

  const groupId = detail?.groupId ?? (activity?.group_id == null ? 0 : Number(activity.group_id));
  const isOffline = activity?.kind === 'offline';
  const ended = activity?.status === 'ended' || activity?.status === 'cancelled';

  const members: GroupMemberLite[] = useMemo(
    () =>
      (detail?.participants ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        avatar_url: null,
        identity: p.identity,
        age: p.age,
      })),
    [detail]
  );

  // 发言（线上多角色调度；线下强制聚焦一人）
  const post = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const r = await fetch(`/api/activities/${aid}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        const newMsgs: GroupMessage[] = Array.isArray(j?.messages) ? (j.messages as GroupMessage[]) : [];
        if (newMsgs.length) setMessages((prev) => [...prev, ...newMsgs]);
        if (j?.run !== undefined) setRun((j.run as GroupRunView | null) ?? null);
        if (!r.ok) throw new Error(j?.error || `发送失败 ${r.status}`);
      } catch (e) {
        setToast(errMsg(e) || '发送失败');
      } finally {
        setBusy(false);
      }
    },
    [aid]
  );

  const send = useCallback(
    async (text: string) => {
      setValue('');
      await post({ content: text });
    },
    [post]
  );

  const onStop = useCallback(async () => {
    if (!groupId) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/groups/${groupId}/stop`, { method: 'POST' });
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
  }, [groupId, load]);

  const patch = useCallback(
    async (body: Record<string, unknown>, okMsg?: string) => {
      setBusy(true);
      try {
        const r = await fetch(`/api/activities/${aid}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error || `操作失败 ${r.status}`);
        if (j?.activity) setActivity(j.activity as ActivityRowView);
        if (Array.isArray(j?.schedule)) setSchedule(j.schedule as ActivityScheduleItem[]);
        if (okMsg) setToast(okMsg);
        return j as Record<string, unknown>;
      } catch (e) {
        setToast(errMsg(e) || '操作失败');
        return null;
      } finally {
        setBusy(false);
      }
    },
    [aid]
  );

  const setFocus = useCallback((cid: number) => patch({ action: 'focus', companionId: cid }, '已切换陪伴对象'), [patch]);
  const advance = useCallback(() => patch({ action: 'advance' }), [patch]);
  const end = useCallback(
    async () => {
      const j = await patch({ action: 'end' }, '活动结束，关系与好感已结算');
      if (j?.summary) setToast(String(j.summary));
    },
    [patch]
  );
  const cancel = useCallback(() => patch({ action: 'cancel' }, '活动已取消'), [patch]);

  if (loading && !detail) return <Loading text="正在进入活动…" />;
  if (error && !detail) return <ErrorBox message={error} onRetry={load} />;
  if (!detail || !activity) return <ErrorBox message="活动不存在" onRetry={load} />;

  const focusId = activity.focus_companion_id == null ? null : Number(activity.focus_companion_id);

  return (
    <div className="pb-10">
      {error ? <ErrorBox message={error} onRetry={load} /> : null}
      <PageHeader
        title={`${ACTIVITY_KIND_ICON[activity.kind] || '🎈'} ${activity.title}`}
        desc={
          isOffline
            ? '线下约会：跟着日程走，轮流把注意力给到每一位。结束时她们的关系也会随之变化。'
            : `${templateLabel(activity.template_key) || '线上一起玩'}：她们会在群里彼此接话。`
        }
        right={
          <div className="flex items-center gap-1.5">
            <Chip tone={activity.status === 'ongoing' ? 'rose' : 'plain'}>{activityStatusLabel(activity.status)}</Chip>
            <Link className="btn-ghost" href="/activities">
              返回
            </Link>
          </div>
        }
      />

      <div className="px-5 md:px-8">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="chip-plain">{ACTIVITY_KIND_LABEL[activity.kind] || activity.kind}</span>
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
        </div>

        {isOffline ? (
          <div className="mb-4 grid gap-4 md:grid-cols-2">
            <div className="card">
              <h2 className="section-title mb-2">约会日程</h2>
              <DateScheduleView items={schedule} onAdvance={ended ? undefined : advance} busy={busy} />
            </div>
            <div className="card">
              <h2 className="section-title mb-2">现在陪着谁</h2>
              <div className="flex flex-wrap gap-2">
                {members.map((m) => {
                  const on = m.id === focusId;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      disabled={ended || busy}
                      onClick={() => setFocus(m.id)}
                      className={`chip ${on ? '!accent-soft !acc' : ''} ${ended ? 'opacity-50' : ''}`}
                      style={on ? { borderColor: colorOf(m.id), color: colorOf(m.id) } : undefined}
                    >
                      {on ? '● ' : ''}
                      {m.name}
                    </button>
                  );
                })}
              </div>
              <p className="dim mt-2 text-[11px] leading-relaxed">
                线下互动默认「只让当前这位发言」；被冷落的人可能会有点小情绪。
              </p>
            </div>
          </div>
        ) : null}

        <GroupChatView messages={messages} />

        <div className="mt-3">
          <GroupComposer
            members={members}
            value={value}
            onChange={setValue}
            onSend={send}
            onContinue={() => post({ continue: true })}
            onStop={onStop}
            busy={busy || ended}
            run={run}
          />
        </div>

        {activity.summary ? (
          <div className="card mt-4">
            <h2 className="section-title mb-1">活动小结</h2>
            <p className="text-sm ink-2">{activity.summary}</p>
          </div>
        ) : null}

        <div className="mt-4 flex items-center gap-2">
          {!ended ? (
            <>
              <button className="btn" onClick={end} disabled={busy}>
                结束活动（结算关系）
              </button>
              <button className="btn-ghost" onClick={cancel} disabled={busy}>
                取消活动
              </button>
            </>
          ) : (
            <Link className="btn-ghost" href="/activities">
              再来一次 →
            </Link>
          )}
        </div>
      </div>

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}
