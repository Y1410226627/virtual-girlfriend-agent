'use client';

import { useState } from 'react';
import { errMsg } from '@/lib/utils';

/* 首次引导：昵称草稿与保存（原 page.tsx 逻辑原样搬移） */
export function useOnboarding(params: {
  setOnboard: (v: boolean) => void;
  loadState: () => Promise<void>;
  setToast: (v: string | null) => void;
}) {
  const { setOnboard, loadState, setToast } = params;

  const [nameDraft, setNameDraft] = useState({ user_name: '', agent_name: '' });

  const saveOnboard = async () => {
    const name = String(nameDraft.user_name || '').trim();
    if (!name) {
      setToast('先告诉我该怎么称呼你吧');
      return;
    }
    try {
      const r1 = await fetch('/api/relationship', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_user', user_name: name }),
      });
      if (!r1.ok) throw new Error(`保存失败 ${r1.status}`);
      if (nameDraft.agent_name.trim()) {
        const r2 = await fetch('/api/relationship', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'set_persona', agent_name: nameDraft.agent_name.trim() }),
        });
        if (!r2.ok) throw new Error(`保存失败 ${r2.status}`);
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