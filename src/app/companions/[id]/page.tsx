'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useApi, PageHeader, Card, Stat, Loading, ErrorBox, Toast, Chip } from '@/components/ui';
import { PursuitProgress } from '@/components/companions/PursuitProgress';
import { statusLabelOf, type CompanionProfileData } from '@/components/companions/shared';
import { errMsg, humanTime } from '@/lib/utils';

export default function CompanionProfilePage() {
  const { id } = useParams<{ id: string }>();
  const cid = String(id || '');
  const { data, loading, error, reload } = useApi<CompanionProfileData>(cid ? `/api/companions/${cid}` : null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (url: string, init: RequestInit, msg: string) => {
    setBusy(true);
    try {
      const r = await fetch(url, init);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `操作失败 ${r.status}`);
      setToast(msg);
      await reload();
      return j;
    } catch (e) {
      setToast(errMsg(e) || '操作失败');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const patch = (action: string, msg: string) =>
    send(`/api/companions/${cid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }, msg);

  const confess = async () => {
    const j = await send(
      `/api/companions/${cid}/pursue`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confess' }) },
      '已表白'
    );
    if (j?.ok && j.accepted) setToast('她答应了，你们在一起了');
    else if (j?.ok && j.accepted === false) setToast('她婉拒了，先做朋友吧');
  };

  const remove = async () => {
    if (!window.confirm('确定删除这名伴侣及其全部数据吗？此操作不可撤销。')) return;
    await send(`/api/companions/${cid}`, { method: 'DELETE' }, '已删除');
  };

  if (loading && !data) return <Loading text="正在读她的资料…" />;
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />;

  const row = data?.roster ?? null;
  const rel = data?.relationship ?? null;
  const isPrimary = row?.is_primary === 1;
  const canPursue = row && !isPrimary && row.status !== 'girlfriend' && row.status !== 'closed';

  return (
    <div className="pb-10">
      {error ? <ErrorBox message={error} onRetry={reload} /> : null}
      <PageHeader
        title={row?.displayName ?? '她'}
        desc={row?.intro || row?.identity || '你们还不够熟。'}
        right={
          <div className="flex flex-wrap gap-2">
            {canPursue && row?.pursue_opt_in !== 1 ? (
              <button className="btn" disabled={busy} onClick={() => patch('pursue', '已选择攻略')}>
                攻略
              </button>
            ) : null}
            {canPursue ? (
              <button className="btn-ghost" disabled={busy} onClick={() => patch('opt_out', '已保留为认识的人')}>
                暂不
              </button>
            ) : null}
            {row?.status === 'pursuing' || row?.status === 'ambiguous' ? (
              <button className="btn-soft" disabled={busy} onClick={confess}>
                表白
              </button>
            ) : null}
            {!isPrimary ? (
              <button className="btn-ghost" disabled={busy} onClick={remove}>
                删除
              </button>
            ) : null}
          </div>
        }
      />

      <div className="space-y-4 px-5 md:px-8">
        {/* 基本角色卡 */}
        <Card title="角色卡">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={row?.status === 'girlfriend' ? 'rose' : 'plain'}>{statusLabelOf(row?.status ?? 'stranger', row?.statusLabel)}</Chip>
            {row?.age ? <Chip tone="plain">{row.age} 岁</Chip> : null}
            {row?.identity ? <Chip tone="plain">{row.identity}</Chip> : null}
            {(row?.personality_tags ?? []).map((t) => (
              <Chip key={t} tone="plain">
                #{t}
              </Chip>
            ))}
          </div>
          {row?.portrait_desc ? <div className="dim mt-3 leading-relaxed">立绘：{row.portrait_desc}</div> : null}
          {data?.persona?.self_story ? <div className="dim mt-2 leading-relaxed">{data.persona.self_story}</div> : null}
        </Card>

        {/* 攻略进度 */}
        {data?.pursuit ? <PursuitProgress progress={data.pursuit} /> : null}

        {/* 关系数值 */}
        {rel ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="好感" value={rel.intimacy} tone="rose" />
            <Stat label="信任" value={rel.trust} tone="peach" />
            <Stat label="情感余额" value={rel.emotional_balance} tone={rel.emotional_balance >= 0 ? 'rose' : 'ink'} />
            <Stat label="当前心情" value={rel.mood} />
          </div>
        ) : null}

        {/* 伴侣关系 */}
        {data?.relations?.length ? (
          <Card title="她与别人的关系">
            <ul className="space-y-2">
              {data.relations.map((r) => (
                <li key={r.id} className="dim">
                  {r.a_name ?? `#${r.a_id}`} ↔ {r.b_name ?? `#${r.b_id}`}：{Math.round(r.value)}（{r.state}）
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {/* 事件流 */}
        <Card title="最近发生">
          {data?.events?.length ? (
            <ul className="space-y-2">
              {data.events.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 text-sm">
                  <span className="ink-2">{e.summary}</span>
                  <span className="dim shrink-0">{humanTime(e.created_at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="dim">还没有记录。</div>
          )}
        </Card>
      </div>

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}
