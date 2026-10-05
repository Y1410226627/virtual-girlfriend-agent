'use client';

import { useCallback, useRef, useState } from 'react';
import { errMsg } from '@/lib/utils';
import type { AppState } from '@/components/chat/shared';

/* 全局状态（/api/state）：state 拉取、首次引导提示、场景切换（原 page.tsx 逻辑原样搬移） */
export function useChatState(setToast: (v: string | null) => void) {
  const [state, setState] = useState<AppState | null>(null);
  const [onboard, setOnboard] = useState(false);
  // 响应序号守卫：并发多次拉取 /api/state 时，只应用"最新一次请求"的响应，避免慢响应后到覆盖先到
  // （切场景后 scene 闪回旧值）。
  // 刻意不做 in-flight Promise 复用：写操作（切场景/登记事件/存昵称）后若复用到"写入前发出"的在途请求，
  // 会把旧快照盖回来，导致变更短暂不生效——所以这里始终发新请求，只用序号丢弃过期响应。
  const seqRef = useRef(0); // 已发出的最新请求序号
  const appliedRef = useRef(0); // 已应用的响应序号

  const loadState = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const j = await r.json();
      if (seq < appliedRef.current) return; // 比已应用的响应更旧：丢弃，不覆盖较新的快照
      appliedRef.current = seq;
      setState(j);
      // 没有昵称就提示补名字；但用户主动关掉之后就不再复活（原来 15s 轮询会把它弹回来）
      const dismissed = typeof window !== 'undefined' && window.localStorage.getItem('onboardDismissed') === '1';
      if (!j?.settings?.user_name && !dismissed) setOnboard(true);
    } catch {
      /* ignore */
    }
  }, []);

  const setSceneMode = async (mode: 'auto' | 'online' | 'offline') => {
    try {
      const r = await fetch('/api/relationship', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_scene', mode }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j?.error || '场景切换失败');
      setToast(mode === 'auto' ? '已恢复智能识别场景' : `已切换为${mode === 'offline' ? '线下相处' : '线上聊天'}`);
      await loadState();
    } catch (e) {
      setToast(`场景切换失败：${errMsg(e)}`);
    }
  };

  return { state, onboard, setOnboard, loadState, setSceneMode };
}