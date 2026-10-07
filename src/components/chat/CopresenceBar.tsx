'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { errMsg } from '@/lib/utils';
import { withCompanionQuery } from './companion-query';

/** GET /api/presence 返回的在场者（契约见 /api/presence） */
export interface Cohabitant {
  kind: 'companion' | 'cast';
  id?: number;
  name: string;
  role: string;
  note?: string;
}

/** presence 相关错误 code → 可读文案（建群页同样沿用） */
export function presenceErrText(code: unknown): string | null {
  if (code === 'PERMISSION_NOT_ACQUAINTED') return '还不认识，先聊聊再说';
  if (code === 'COMPANION_CLOSED') return '已关闭';
  if (code === 'NO_CAST') return '没有这位身边的人';
  return null;
}

/**
 * 同场感知提示条：有人在当前伴侣身边时显示「她的室友小雨在旁边 · 一起聊」。
 * 缺省态零回归：cohabitants 为空（含 404/请求失败静默当空）时不渲染任何元素；
 * 首屏只发一次 GET，切换伴侣（companionId 变化）时重拉。
 */
export default function CopresenceBar({
  companionId,
  setToast,
}: {
  companionId: number;
  setToast: (v: string | null) => void;
}) {
  const router = useRouter();
  const [cohabitants, setCohabitants] = useState<Cohabitant[]>([]);
  const [busy, setBusy] = useState(false);
  // 请求序号：旧响应不得覆盖新响应（切换伴侣时）
  const reqIdRef = useRef(0);

  useEffect(() => {
    const reqId = ++reqIdRef.current;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(withCompanionQuery('/api/presence', companionId), { cache: 'no-store' });
        // 后端未部署 / 群接口不存在：静默当空，不打扰用户
        if (!r.ok) {
          if (!cancelled && reqId === reqIdRef.current) setCohabitants([]);
          return;
        }
        const j = await r.json().catch(() => null);
        const list: Cohabitant[] = Array.isArray(j?.cohabitants) ? j.cohabitants : [];
        if (!cancelled && reqId === reqIdRef.current) setCohabitants(list);
      } catch {
        if (!cancelled && reqId === reqIdRef.current) setCohabitants([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companionId]);

  if (!cohabitants.length) return null;

  const join = async (c: Cohabitant) => {
    if (busy) return;
    setBusy(true);
    try {
      const member = c.kind === 'companion' ? { kind: 'companion', id: c.id } : { kind: 'cast', name: c.name };
      const r = await fetch(withCompanionQuery('/api/presence', companionId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        setToast(presenceErrText(j?.code) || j?.error || '没能一起聊');
        return;
      }
      router.push(`/groups/${j.groupId}`);
    } catch (e) {
      setToast(`操作失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const first = cohabitants[0]!;
  const rest = cohabitants.slice(1);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border line accent-soft px-3 py-2 text-[11px]">
      <span className="ink-1">
        {cohabitants.map((c, i) => (
          <span key={`${c.kind}-${c.id ?? c.name}-${i}`} title={c.note || undefined}>
            {i > 0 ? '、' : ''}
            {c.role}
            {c.name}
          </span>
        ))}
        在旁边
      </span>
      <span className="flex-1" />
      <button
        className="btn !px-2.5 !py-1 text-[11px]"
        disabled={busy}
        onClick={() => join(first)}
        title={`和${first.role}${first.name}一起聊`}
      >
        一起聊
      </button>
      {rest.map((c, i) => (
        <button
          key={`${c.kind}-${c.id ?? c.name}-${i}`}
          className="btn-ghost !px-2 !py-1 text-[11px]"
          disabled={busy}
          onClick={() => join(c)}
          title={`和${c.role}${c.name}一起聊`}
        >
          {c.name}
        </button>
      ))}
      {busy ? <span className="animate-pulse-soft acc">进入群聊…</span> : null}
    </div>
  );
}
