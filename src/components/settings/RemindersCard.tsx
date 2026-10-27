'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, Chip } from '@/components/ui';

interface Reminder {
  id: number;
  content: string;
  due_at: string;
  status: 'pending' | 'sent';
  sent_at: string | null;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/**
 * 提醒卡片：她在聊天里答应你的"到点提醒我"。
 * 创建入口在聊天里（说「20分钟后提醒我喝水」即可），这里只做查看与取消。
 */
export function RemindersCard({ companionId }: { companionId: number }) {
  const [items, setItems] = useState<Reminder[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/reminders?companionId=${companionId}`);
      const j = await r.json();
      if (Array.isArray(j?.reminders)) setItems(j.reminders as Reminder[]);
    } catch {
      /* 读取失败保持原列表 */
    }
  }, [companionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = async (id: number) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/reminders?companionId=${companionId}&id=${id}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      setMsg(r.ok && j?.ok ? '已取消' : String(j?.error || '取消失败'));
      await load();
    } catch {
      setMsg('取消失败：网络异常');
    } finally {
      setBusy(false);
    }
  };

  const pending = items.filter((x) => x.status === 'pending');

  return (
    <Card title="提醒（她答应你的事）" right={<Chip tone="plain">{pending.length} 条待提醒</Chip>}>
      <p className="dim leading-relaxed">
        在聊天里说「提醒我 20 分钟后喝水」「明天早上 8 点提醒我交报告」，她会自然答应，到点由她用自己的口吻提醒你。
        提醒只存在本机，不占主动消息额度。
      </p>
      <div className="mt-3 space-y-2">
        {items.length === 0 ? (
          <p className="text-[11px] ink-3">还没有提醒。去聊天里跟她说一句就行。</p>
        ) : (
          items.map((x) => (
            <div key={x.id} className="flex flex-wrap items-center gap-2 rounded-xl border line px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm ink-1">{x.content}</span>
              <span className="text-[11px] ink-3">{x.status === 'pending' ? `待提醒 · ${fmt(x.due_at)}` : `已提醒 · ${fmt(x.sent_at || x.due_at)}`}</span>
              {x.status === 'pending' ? (
                <button className="btn-ghost !px-2 !py-1 text-[11px]" type="button" onClick={() => cancel(x.id)} disabled={busy}>
                  取消
                </button>
              ) : (
                <Chip tone="plain">完成</Chip>
              )}
            </div>
          ))
        )}
      </div>
      {msg ? <p className="mt-2 text-[11px] acc">{msg}</p> : null}
    </Card>
  );
}
