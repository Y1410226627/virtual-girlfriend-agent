'use client';

import { useEffect, useRef, useState } from 'react';
import { useApi, PageHeader, Loading, ErrorBox, Toast } from '@/components/ui';
import { errMsg } from '@/lib/utils';
import { withCompanionQuery } from '@/components/chat/companion-query';
import { useCompanionId, CompanionScopeBar } from '@/components/CompanionScopeBar';
import type { LifeData } from '@/components/world/shared';
import { NowDoingCard } from '@/components/world/NowDoingCard';
import { BodyCard } from '@/components/world/BodyCard';
import { PsychologyCard } from '@/components/world/PsychologyCard';
import { LifeArcCard } from '@/components/world/LifeArcCard';
import { CastCard } from '@/components/world/CastCard';
import { ManualStatesCard } from '@/components/world/ManualStatesCard';
import { TestCard } from '@/components/world/TestCard';
import { TimelineCard } from '@/components/world/TimelineCard';
import { LifeEventsCard } from '@/components/world/LifeEventsCard';
import { WeeklySnapshotCard } from '@/components/world/WeeklySnapshotCard';
import { ProfileCard } from '@/components/world/ProfileCard';
import { SharedPlansCard } from '@/components/world/SharedPlansCard';
import { SharedRitualsCard } from '@/components/world/SharedRitualsCard';
import { SharedPlacesCard } from '@/components/world/SharedPlacesCard';
import { SharedItemsCard } from '@/components/world/SharedItemsCard';

const TABS = [
  { k: 'now', label: '她现在' },
  { k: 'today', label: '她的一天' },
  { k: 'profile', label: '她的档案' },
  { k: 'shared', label: '共享世界' },
] as const;

export default function WorldPage() {
  // 当前伴侣（URL ?companionId= → localStorage → 缺省主女友）：切换伴侣要重新加载该伴侣的世界
  const companionId = useCompanionId();
  // P1-55：一次取最多 200 条生活日记，"展开全部"才有真实数据可展示（默认只返回 30）
  const { data, loading, error, reload } = useApi<LifeData>(withCompanionQuery('/api/life?limit=200', companionId));
  const [tab, setTab] = useState<(typeof TABS)[number]['k']>('now');
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editProfile, setEditProfile] = useState(false);
  const [pf, setPf] = useState<Record<string, string>>({});
  const [newPlan, setNewPlan] = useState('');
  const [newRitual, setNewRitual] = useState('');
  const [newItem, setNewItem] = useState('');
  // 手动调整她此刻的身体/心理数值
  const [editStates, setEditStates] = useState(false);
  const [sv, setSv] = useState<Record<string, string | number>>({});
  const [showAllEvents, setShowAllEvents] = useState(false);
  // 她身边的人（具名社会关系）编辑
  const [editCast, setEditCast] = useState(false);
  const [castDraft, setCastDraft] = useState<Array<{ name: string; role: string; note: string }>>([]);
  // 已提示过的错误：同一错误只弹一次，避免 data 刷新时反复弹同一条 toast
  const lastErrRef = useRef<string | null>(null);

  const post = async (body: Record<string, unknown>, msg?: string) => {
    setBusy(true);
    try {
      const r = await fetch(withCompanionQuery('/api/life', companionId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `操作失败 ${r.status}`);
      if (msg) setToast(msg);
      await reload();
      return j;
    } catch (e) {
      setToast(errMsg(e) || '操作失败');
      return null;
    } finally {
      setBusy(false);
    }
  };

  // 已有数据时只在顶部轻提示，不整页替换；同一错误只提示一次
  useEffect(() => {
    if (!error) {
      lastErrRef.current = null;
      return;
    }
    if (data && lastErrRef.current !== error) {
      lastErrRef.current = error;
      setToast(error);
    }
  }, [error, data]);

  if (loading && !data) return <Loading text="正在看她的生活…" />;
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />;
  if (!data) return null;

  const h = data.health;
  const p = data.psychology;
  const loc = data.location;
  const act = data.activity;

  return (
    <div className="pb-10">
      <CompanionScopeBar companionId={companionId} />
      <PageHeader
        title="她的世界"
        desc="她不是只在聊天时才存在的人。你有你的事，她也有她的日子。"
        right={
          <button
            className="btn-ghost"
            disabled={busy}
            onClick={() => post({ action: 'simulate_hours', hours: 6 }, '时间往前推了 6 小时，看看她的变化')}
            title="把她的生活推进 6 小时（方便你立刻看到变化）"
          >
            推进 6 小时
          </button>
        }
      />

      <div className="px-5 md:px-8">
        <div className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button key={t.k} className={tab === t.k ? 'btn-soft' : 'btn-ghost'} onClick={() => setTab(t.k)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'now' ? (
        <div className="space-y-4 px-5 pt-4 md:px-8">
          <NowDoingCard p={p} loc={loc} act={act} h={h} recently={data.recently} />

          <div className="grid gap-4 md:grid-cols-2">
            <BodyCard h={h} p={p} editStates={editStates} setSv={setSv} setEditStates={setEditStates} />
            <PsychologyCard p={p} />
          </div>

          <LifeArcCard lifeArc={data.lifeArc} />

          <CastCard cast={data.cast} busy={busy} post={post} editCast={editCast} setEditCast={setEditCast} castDraft={castDraft} setCastDraft={setCastDraft} />

          {editStates ? (
            <ManualStatesCard h={h} sv={sv} setSv={setSv} busy={busy} post={post} setEditStates={setEditStates} />
          ) : null}

          <TestCard busy={busy} post={post} illness={h.illness} illnessDay={h.illnessDay} />
        </div>
      ) : null}

      {tab === 'today' ? (
        <div className="space-y-4 px-5 pt-4 md:px-8">
          <TimelineCard timeline={data.timeline} />

          <LifeEventsCard events={data.events} eventsTotal={data.eventsTotal} showAllEvents={showAllEvents} setShowAllEvents={setShowAllEvents} />

          <WeeklySnapshotCard weeklySnapshots={data.weeklySnapshots} />
        </div>
      ) : null}

      {tab === 'profile' ? (
        <div className="space-y-4 px-5 pt-4 md:px-8">
          <ProfileCard profile={data.profile} busy={busy} post={post} editProfile={editProfile} setEditProfile={setEditProfile} pf={pf} setPf={setPf} />
        </div>
      ) : null}

      {tab === 'shared' ? (
        <div className="grid gap-4 px-5 pt-4 md:grid-cols-2 md:px-8">
          <SharedPlansCard plans={data.shared.plans} busy={busy} post={post} newPlan={newPlan} setNewPlan={setNewPlan} />

          <SharedRitualsCard rituals={data.shared.rituals} busy={busy} post={post} newRitual={newRitual} setNewRitual={setNewRitual} />

          <SharedPlacesCard places={data.shared.places} />

          <SharedItemsCard items={data.shared.items} busy={busy} post={post} newItem={newItem} setNewItem={setNewItem} />
        </div>
      ) : null}

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}