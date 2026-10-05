'use client';

import { useEffect, useRef, useState } from 'react';
import { useApi, PageHeader, Stat, Loading, ErrorBox, Toast } from '@/components/ui';
import { errMsg } from '@/lib/utils';
import { FORM_ACTIONS, type Tab, type Edits, type PostBody, type RelationshipData, type RelationshipInfo } from '@/components/relationship/shared';
import { StageCard } from '@/components/relationship/StageCard';
import { BankCard } from '@/components/relationship/BankCard';
import { ConflictsCard } from '@/components/relationship/ConflictsCard';
import { LogsCard } from '@/components/relationship/LogsCard';
import { EventsCard } from '@/components/relationship/EventsCard';
import { MemoriesCard } from '@/components/relationship/MemoriesCard';
import { NicknameCard } from '@/components/relationship/NicknameCard';
import { PersonaCard } from '@/components/relationship/PersonaCard';
import { ProfileCard } from '@/components/relationship/ProfileCard';

export default function RelationshipPage() {
  const { data, loading, error, reload } = useApi<RelationshipData>('/api/relationship');
  const [toast, setToast] = useState<string | null>(null);
  const [edits, setEdits] = useState<Edits>({});
  const [newEvent, setNewEvent] = useState({ title: '', event_date: '', kind: 'anniversary', repeat_yearly: true });
  const [tab, setTab] = useState<Tab>('bank');
  // 用户改过表单后，后台 reload 不要覆盖他还没保存的编辑（同 settings 页 dirtyRef 模式）
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (data && !dirtyRef.current) {
      setEdits({
        nickname: data.relationship?.nickname || '',
        anniversary: data.relationship?.anniversary || '',
        agent_name: data.persona?.agent_name || '',
        age: data.persona?.age || '',
        occupation: data.persona?.occupation || '',
        self_story: data.persona?.self_story || '',
        user_name: data.user?.name || '',
        user_profile: data.user?.profile || '',
      });
    }
  }, [data]);

  const setEdit = (k: keyof Edits, v: string | number) => {
    dirtyRef.current = true;
    setEdits((s) => ({ ...s, [k]: v }) as Edits);
  };

  const post = async (body: PostBody, msg?: string) => {
    try {
      const r = await fetch('/api/relationship', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `操作失败 ${r.status}`);
      if (FORM_ACTIONS.includes(body.action)) dirtyRef.current = false;
      setToast(msg || '已保存');
      await reload();
    } catch (e) {
      setToast(errMsg(e) || '操作失败');
    }
  };

  if (loading && !data) return <Loading text="正在读你们的关系…" />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;

  const rel = data?.relationship || ({} as RelationshipInfo);
  const stages = data?.stages || [];
  const nextStage = stages.find((s) => s.id === (rel.stage ?? 0) + 1);
  const capDays = rel.capSinceDays;
  const dwell = rel.dwellDays ?? 3;

  return (
    <div className="pb-10">
      <PageHeader
        title="关系"
        desc="亲密度、阶段、情感银行账户、冲突与修复。关系不是永远甜的——会有摩擦，也需要经营。"
        right={
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost" onClick={() => post({ action: 'request_stage_talk' }, '她会在下次聊天时找机会和你确认关系')}>
              推进关系确认
            </button>
            <button className="btn-ghost" onClick={() => post({ action: 'request_relationship_talk' }, '她会主动把话说开')}>
              请她主动谈一谈
            </button>
          </div>
        }
      />

      <div className="px-5 md:px-8">
        <StageCard stages={stages} rel={rel} dwell={dwell} capDays={capDays} nextStage={nextStage} post={post} />
      </div>

      <div className="grid grid-cols-2 gap-3 px-5 pt-4 md:grid-cols-4 md:px-8">
        <Stat label="情感余额" value={rel.emotional_balance} tone={(rel.emotional_balance ?? 0) >= 0 ? 'rose' : 'ink'} />
        <Stat label="修复信用" value={rel.repair_credit} tone="peach" />
        <Stat label="未解决张力" value={rel.unresolved_tension} tone={(rel.unresolved_tension ?? 0) > 20 ? 'ink' : 'rose'} />
        <Stat label="当前心情" value={rel.mood} />
      </div>

      <div className="px-5 pt-4 md:px-8">
        <div className="flex flex-wrap gap-2">
          {([
            { k: 'bank', label: '情感银行流水' },
            { k: 'conflicts', label: `冲突记录（${(data?.conflicts || []).length}）` },
            { k: 'logs', label: '关系日志' },
            { k: 'events', label: '纪念日 / 约定' },
            { k: 'memories', label: '关系记忆 & 每日回顾' },
          ] as { k: Tab; label: string }[]).map((t) => (
            <button key={t.k} className={tab === t.k ? 'btn-soft' : 'btn-ghost'} onClick={() => setTab(t.k)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="mt-3">
          {tab === 'bank' ? <BankCard bank={data?.bank} /> : null}

          {tab === 'conflicts' ? <ConflictsCard conflicts={data?.conflicts || []} /> : null}

          {tab === 'logs' ? <LogsCard logs={data?.logs || []} /> : null}

          {tab === 'events' ? <EventsCard events={data?.events || []} newEvent={newEvent} setNewEvent={setNewEvent} post={post} /> : null}

          {tab === 'memories' ? <MemoriesCard memories={data?.memories || []} summaries={data?.summaries || []} /> : null}
        </div>
      </div>

      <div className="grid gap-4 px-5 pt-4 md:grid-cols-2 md:px-8">
        <NicknameCard edits={edits} setEdit={setEdit} post={post} />

        <PersonaCard edits={edits} setEdit={setEdit} post={post} />

        <ProfileCard edits={edits} setEdit={setEdit} post={post} />
      </div>

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}