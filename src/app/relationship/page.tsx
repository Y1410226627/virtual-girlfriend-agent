'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useApi, PageHeader, Stat, Loading, ErrorBox, Toast } from '@/components/ui';
import { errMsg } from '@/lib/utils';
import { withCompanionQuery } from '@/components/chat/companion-query';
import { useCompanionId, CompanionScopeBar } from '@/components/CompanionScopeBar';
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
import { RelationWeb } from '@/components/relationship/RelationWeb';

/** 各"写回表单"的 action 成功后，应清除哪些字段的 dirty 标记 */
const ACTION_KEYS: Record<string, (keyof Edits)[]> = {
  set_nickname: ['nickname'],
  set_anniversary: ['anniversary'],
  set_persona: ['agent_name', 'age', 'occupation', 'self_story'],
  set_user: ['user_name', 'user_profile'],
};

export default function RelationshipPage() {
  // 当前伴侣（URL ?companionId= → localStorage → 缺省主女友）：切换伴侣要重新加载该伴侣的关系
  const companionId = useCompanionId();
  const { data, loading, error, reload } = useApi<RelationshipData>(withCompanionQuery('/api/relationship', companionId));
  const [toast, setToast] = useState<string | null>(null);
  const [edits, setEdits] = useState<Edits>({});
  const [newEvent, setNewEvent] = useState({ title: '', event_date: '', kind: 'anniversary', repeat_yearly: true });
  const [tab, setTab] = useState<Tab>('bank');
  // 用户改过的字段（未保存前，后台 reload 只跳过这些字段，其余照常回填）（同 settings 页 dirtyRef 模式）
  const dirtyRef = useRef<Set<keyof Edits>>(new Set());

  useEffect(() => {
    if (!data) return;
    const fresh: Edits = {
      nickname: data.relationship?.nickname || '',
      anniversary: data.relationship?.anniversary || '',
      agent_name: data.persona?.agent_name || '',
      age: data.persona?.age || '',
      occupation: data.persona?.occupation || '',
      self_story: data.persona?.self_story || '',
      user_name: data.user?.name || '',
      user_profile: data.user?.profile || '',
    };
    setEdits((prev) => {
      const next: Edits = { ...fresh };
      // 已改过但还没保存的字段保留用户当前输入，其余回填服务端值
      for (const k of dirtyRef.current) {
        Object.assign(next, { [k]: prev[k] });
      }
      return next;
    });
  }, [data]);

  // 切换伴侣：清空"未保存草稿"标记（dirty），避免把 A 的未保存内容写进 B。
  // 用 prevRef 守卫：初次挂载（companionId=1）与取值不变时不触发，零额外渲染/请求、交互不变。
  const prevCompanionRef = useRef(companionId);
  useEffect(() => {
    if (prevCompanionRef.current === companionId) return;
    prevCompanionRef.current = companionId;
    dirtyRef.current.clear();
  }, [companionId]);

  const setEdit = (k: keyof Edits, v: string | number) => {
    dirtyRef.current.add(k);
    setEdits((s) => ({ ...s, [k]: v }) as Edits);
  };

  const post = async (body: PostBody, msg?: string) => {
    try {
      const r = await fetch(withCompanionQuery('/api/relationship', companionId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `操作失败 ${r.status}`);
      if (FORM_ACTIONS.includes(body.action)) {
        // 只清除本次保存涉及的字段；其它卡片未保存的草稿继续保留
        for (const k of ACTION_KEYS[body.action] ?? []) dirtyRef.current.delete(k);
      }
      setToast(msg || '已保存');
      await reload();
    } catch (e) {
      setToast(errMsg(e) || '操作失败');
    }
  };

  if (loading && !data) return <Loading text="正在读你们的关系…" />;
  // 仅初次加载就失败才整页替换；已有数据时用顶部横幅提示，保留已加载内容可继续查看/操作
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />;

  const rel = data?.relationship || ({} as RelationshipInfo);
  const stages = data?.stages || [];
  const nextStage = stages.find((s) => s.id === (rel.stage ?? 0) + 1);
  const capDays = rel.capSinceDays;
  const dwell = rel.dwellDays ?? 3;

  return (
    <div className="pb-10">
      <CompanionScopeBar companionId={companionId} />
      {error ? <ErrorBox message={error} onRetry={reload} /> : null}
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
            { k: 'relations', label: '伴侣关系网' },
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

          {tab === 'relations' ? (
            <div className="grid gap-3">
              <RelationWeb />
              {/* 关系网联动：一起参加活动会改变伴侣间关系（同场 +、线下被冷落 −） */}
              <div className="flex flex-wrap items-center gap-2">
                <Link className="btn-ghost" href={withCompanionQuery('/activities', companionId)}>
                  去「活动」页，让她们一起玩 →
                </Link>
                <span className="dim text-[11px]">同场活动会拉近彼此关系；线下被冷落的一方会有点小情绪。</span>
              </div>
            </div>
          ) : null}
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