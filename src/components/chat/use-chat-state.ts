'use client';

import { useCallback, useState } from 'react';
import type { AppState } from '@/components/chat/shared';

/* 全局状态（/api/state）：state 拉取、首次引导提示、场景切换（原 page.tsx 逻辑原样搬移） */
export function useChatState(setToast: (v: string | null) => void) {
  const [state, setState] = useState<AppState | null>(null);
  const [onboard, setOnboard] = useState(false);

  const loadState = useCallback(async () => {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const j = await r.json();
      setState(j);
      // 没有昵称就提示补名字；但用户主动关掉之后就不再复活（原来 15s 轮询会把它弹回来）
      const dismissed = typeof window !== 'undefined' && window.localStorage.getItem('onboardDismissed') === '1';
      if (!j?.settings?.user_name && !dismissed) setOnboard(true);
    } catch {
      /* ignore */
    }
  }, []);

  const setSceneMode = async (mode: 'auto' | 'online' | 'offline') => {
    const r = await fetch('/api/relationship', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_scene', mode }),
    });
    const j = await r.json();
    if (j.ok) {
      setToast(mode === 'auto' ? '已恢复智能识别场景' : `已切换为${mode === 'offline' ? '线下相处' : '线上聊天'}`);
      loadState();
    }
  };

  return { state, onboard, setOnboard, loadState, setSceneMode };
}