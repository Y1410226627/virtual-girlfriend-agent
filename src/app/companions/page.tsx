'use client';

import { useState } from 'react';
import { useApi, PageHeader, Loading, ErrorBox, Toast } from '@/components/ui';
import { CompanionList } from '@/components/companions/CompanionList';
import { errMsg } from '@/lib/utils';
import type { RosterView } from '@/components/companions/shared';

const EMPTY: RosterView = {
  primary: null,
  girlfriends: [],
  pursuing: [],
  acquaintances: [],
  pending: [],
  closed: [],
};

export default function CompanionsPage() {
  const { data, loading, error, reload } = useApi<RosterView>('/api/companions');
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [showCast, setShowCast] = useState(false);
  const [castList, setCastList] = useState<{ name: string; role: string; note: string }[] | null>(null);
  const [castOwner, setCastOwner] = useState<string | null>(null);
  const [casting, setCasting] = useState<string | null>(null);

  const post = async (url: string, body: Record<string, unknown>, msg: string) => {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `操作失败 ${r.status}`);
      setToast(msg);
      await reload();
    } catch (e) {
      setToast(errMsg(e) || '操作失败');
    }
  };

  const discover = async () => {
    setDiscovering(true);
    try {
      await post('/api/companions/discover', {}, '发现了新的人，去发现区看看');
    } finally {
      setDiscovering(false);
    }
  };

  /** 打开「她身边的人」：拉取当前伴侣社交圈里可认识的人（室友/同事/朋友…） */
  const openCast = async () => {
    setShowCast(true);
    if (castList) return;
    try {
      const r = await fetch('/api/companions/discover');
      const j = await r.json().catch(() => ({}));
      setCastList(Array.isArray(j?.cast) ? j.cast : []);
      setCastOwner(j?.owner ?? null);
    } catch {
      setCastList([]);
    }
  };

  const knowCast = async (name: string) => {
    setCasting(name);
    try {
      await post('/api/companions/discover', { mode: 'cast', castName: name }, `你见到了${name}，去发现区看看`);
      setCastList((prev) => (prev ? prev.filter((c) => c.name !== name) : prev));
    } finally {
      setCasting(null);
    }
  };

  const act = async (id: number, action: string, msg: string) => {
    setBusyId(id);
    try {
      // 注意：该路由的状态操作是 PATCH（POST 会 405）——与资料页 patch() 保持一致
      const r = await fetch(`/api/companions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `操作失败 ${r.status}`);
      setToast(msg);
      await reload();
    } catch (e) {
      setToast(errMsg(e) || '操作失败');
    } finally {
      setBusyId(null);
    }
  };

  if (loading && !data) return <Loading text="正在读通讯录…" />;
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />;

  return (
    <div className="pb-10">
      {error ? <ErrorBox message={error} onRetry={reload} /> : null}
      <PageHeader
        title="通讯录"
        desc="你能认识不止一个人。最常见的是通过她已经认识的人——室友、同事、朋友；也可能在生活里偶遇某个陌生人。每段关系都有独立的关系、记忆与生活。"
        right={
          <div className="flex gap-2">
            <button className="btn btn-ghost" onClick={openCast}>
              她身边的人
            </button>
            <button className="btn" disabled={discovering} onClick={discover}>
              {discovering ? '发现中…' : '遇见陌生人'}
            </button>
          </div>
        }
      />

      {showCast ? (
        <div className="px-5 pb-4 md:px-8">
          <div className="card-tight">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-sm font-medium ink-1">
                {castOwner ? `${castOwner}身边的人` : '她身边的人'}
                <span className="dim ml-2 text-xs">你见过这些人，也可以选择去认识她们</span>
              </div>
              <button className="text-xs dim hover:underline" onClick={() => setShowCast(false)}>
                收起
              </button>
            </div>
            {castList === null ? (
              <div className="dim py-3 text-sm">读取中…</div>
            ) : castList.length === 0 ? (
              <div className="dim py-3 text-sm">她身边暂时没有可认识的人（可以先和她聊聊她的朋友、同事）</div>
            ) : (
              <ul className="flex flex-col gap-2">
                {castList.map((c) => (
                  <li key={c.name} className="flex items-center justify-between gap-3 rounded-xl accent-soft px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm ink-1">
                        {c.name} <span className="dim">· {c.role}</span>
                      </div>
                      {c.note ? <div className="dim truncate text-xs">{c.note}</div> : null}
                    </div>
                    <button
                      className="btn-soft shrink-0"
                      disabled={casting === c.name}
                      onClick={() => knowCast(c.name)}
                    >
                      {casting === c.name ? '…' : '认识她'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      <div className="px-5 md:px-8">
        <CompanionList
          view={data ?? EMPTY}
          busyId={busyId}
          onPursue={(id) => act(id, 'pursue', '已选择攻略，去和她聊聊天吧')}
          onOptOut={(id) => act(id, 'opt_out', '已保留为认识的人')}
        />
      </div>
      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}
