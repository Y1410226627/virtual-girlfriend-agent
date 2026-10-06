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

  const act = async (id: number, action: string, msg: string) => {
    setBusyId(id);
    try {
      await post(`/api/companions/${id}`, { action }, msg);
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
        desc="你能认识不止一个人。有人只是认识，有人正在攻略中，有人已经是女友——每段关系都有独立的关系、记忆与生活。"
        right={
          <button className="btn" disabled={discovering} onClick={discover}>
            {discovering ? '发现中…' : '发现新的人'}
          </button>
        }
      />
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
