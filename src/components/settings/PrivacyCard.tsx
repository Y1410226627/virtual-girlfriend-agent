'use client';

import { Card } from '@/components/ui';
import { withCompanionQuery } from '@/components/chat/companion-query';
import type { SetToast } from './shared';

export function PrivacyCard({
  download,
  reset,
  setToast,
  reload,
  companionId,
}: {
  download: () => void;
  reset: (keepSettings: boolean) => void;
  setToast: SetToast;
  reload: () => void;
  /** 当前伴侣：「只清空聊天记录」只清空该伴侣的消息（wipeAllMessages 走 cId 作用域） */
  companionId: number;
}) {
  return (
    <Card title="隐私与数据">
      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost" onClick={download}>
          导出全部数据（JSON）
        </button>
        <button
          className="btn-ghost"
          onClick={async () => {
            if (!confirm('确定清空聊天记录吗？记忆、性格、关系状态会保留。')) return;
            try {
              const r = await fetch(withCompanionQuery('/api/messages?all=1', companionId), { method: 'DELETE' });
              if (!r.ok) throw new Error();
              setToast('聊天记录已清空');
              reload();
            } catch {
              setToast('清空失败，请重试');
            }
          }}
        >
          只清空聊天记录
        </button>
        <button className="btn-ghost" onClick={() => reset(true)}>
          清空全部数据（保留设置）
        </button>
        <button className="btn-ghost" onClick={() => reset(false)}>
          恢复出厂状态
        </button>
      </div>
      <p className="dim mt-3 leading-relaxed">
        聊天记录、记忆、性格参数、依恋数据都存储在本机 <code className="rounded accent-soft px-1">data/girlfriend.db</code> 里，
        你可以随时查看、编辑、删除或整份导出。删除即彻底删除，不上传任何服务器。
      </p>
    </Card>
  );
}