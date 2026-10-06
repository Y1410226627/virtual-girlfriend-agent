'use client';

import { useState } from 'react';
import { errMsg } from '@/lib/utils';
import { withCompanionQuery } from '@/components/chat/companion-query';

/* 首次引导：昵称草稿与保存（原 page.tsx 逻辑原样搬移） */
export function useOnboarding(params: {
  setOnboard: (v: boolean) => void;
  loadState: () => Promise<void>;
  setToast: (v: string | null) => void;
  companionId?: number;
}) {
  const { setOnboard, loadState, setToast, companionId = 1 } = params;

  const [nameDraft, setNameDraft] = useState({ user_name: '', agent_name: '' });

  const saveOnboard = async () => {
    const name = String(nameDraft.user_name || '').trim();
    if (!name) {
      setToast('先告诉我该怎么称呼你吧');
      return;
    }
    try {
      // P1-56：一次请求同时写 user_name + agent_name，服务端用同一事务落库（原子）。
      const r = await fetch(withCompanionQuery('/api/relationship', companionId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set_user',
          user_name: name,
          agent_name: nameDraft.agent_name.trim() || undefined,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `保存失败 ${r.status}`);
      }
      window.localStorage.setItem('onboardDismissed', '1');
      setOnboard(false);
      loadState();
      setToast('记住啦');
    } catch (e) {
      // 保存失败不要假装成功（否则轮询又把引导弹回来，用户以为卡住了）
      setToast(`没能保存：${errMsg(e)}`);
    }
  };

  return { nameDraft, setNameDraft, saveOnboard };
}