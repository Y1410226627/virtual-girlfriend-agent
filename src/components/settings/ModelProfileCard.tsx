'use client';

import { Card, Chip, fmtTime } from '@/components/ui';
import type { ProfileForm, ProfilePostResult, ProfileTestResult, SettingsResponse, SetToast } from './shared';

export function ModelProfileCard({
  data,
  pinging,
  onRunPing,
  testResults,
  testing,
  profilePost,
  testProfile,
  editingId,
  setEditingId,
  pf,
  setPf,
  setToast,
}: {
  data: SettingsResponse | null;
  pinging: boolean;
  onRunPing: () => void;
  testResults: Record<number, ProfileTestResult>;
  testing: number | null;
  profilePost: (body: Record<string, unknown>) => Promise<ProfilePostResult>;
  testProfile: (id: number) => Promise<void>;
  editingId: number | null;
  setEditingId: React.Dispatch<React.SetStateAction<number | null>>;
  pf: ProfileForm;
  setPf: React.Dispatch<React.SetStateAction<ProfileForm>>;
  setToast: SetToast;
}) {
  return (
    <Card
      title="模型档案（随时切换，立即生效）"
      right={
        <button className="btn-ghost" onClick={onRunPing} disabled={pinging}>
          {pinging ? '自检中…' : '连接自检'}
        </button>
      }
    >
      <div className="space-y-2">
        {/* 成本透明：今天的调用次数 + 备用链降级提示 */}
        {data?.usage ? (
          <p className="dim">
            今日调用：聊天 {data.usage.chat || 0} · 分析 {data.usage.analysis || 0} · 向量 {data.usage.embedding || 0}
            {data.usage.lastFallback?.label
              ? ` ｜ 最近降级到「${data.usage.lastFallback.label}」（${fmtTime(new Date(data.usage.lastFallback.at).toISOString()).slice(-5)}）——说明首选模型当时不可用，检查一下网络或额度`
              : ''}
          </p>
        ) : null}
        {(data?.profiles || []).map((p) => {
          const h = data?.health?.[`chat|${(p.base_url || '').replace(/\/+$/, '')}|${p.chat_model}`];
          const tr = testResults[p.id];
          return (
            <div
              key={p.id}
              className={`rounded-2xl border px-3.5 py-3 ${
                p.is_default ? 'border-rose-300 accent-soft' : 'line surf'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium ink-1">{p.label}</span>
                {p.is_default ? <Chip>当前使用</Chip> : null}
                {h?.cooling ? <Chip tone="plain">冷却中 {h.cooldownLeftSec}s</Chip> : null}
                <span className="text-[11px] ink-3">
                  {p.chat_model} · {p.base_url}
                </span>
              </div>
              {p.note ? <div className="dim mt-1">{p.note}</div> : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {!p.is_default ? (
                  <button
                    className="btn !py-1.5 text-xs"
                    onClick={async () => setToast((await profilePost({ action: 'apply_profile', id: p.id })).message)}
                  >
                    设为当前
                  </button>
                ) : null}
                <button className="btn-ghost !py-1.5 text-xs" onClick={() => testProfile(p.id)} disabled={testing === p.id}>
                  {testing === p.id ? '测试中…' : '测试'}
                </button>
                <button
                  className="btn-ghost !py-1.5 text-xs"
                  onClick={() => {
                    setEditingId(p.id);
                    setPf({ ...p });
                  }}
                >
                  编辑
                </button>
                {!p.is_default ? (
                  <>
                    <button className="btn-ghost !px-2 !py-1.5 text-xs" title="备用顺序上移" onClick={() => profilePost({ action: 'move_profile', id: p.id, dir: -1 })}>
                      ↑
                    </button>
                    <button className="btn-ghost !px-2 !py-1.5 text-xs" title="备用顺序下移" onClick={() => profilePost({ action: 'move_profile', id: p.id, dir: 1 })}>
                      ↓
                    </button>
                  </>
                ) : null}
                <button
                  className="btn-ghost !py-1.5 text-xs"
                  onClick={async () => {
                    if (!confirm(`删除档案「${p.label}」？`)) return;
                    const j = await profilePost({ action: 'delete_profile', id: p.id });
                    setToast(j.ok ? '已删除' : '删除失败');
                  }}
                >
                  删除
                </button>
                {tr ? (
                  <span className="text-[11px]">
                    {tr.pending ? (
                      '…'
                    ) : tr.ok ? (
                      <span className="acc">✅ {tr.ms}ms「{tr.reply}」</span>
                    ) : (
                      <span className="text-sky-600">❌ {String(tr.error).slice(0, 60)}</span>
                    )}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-2xl border line surf p-3.5">
        <div className="mb-2 text-xs font-medium ink-2">{editingId ? '编辑档案' : '新增档案'}</div>
        <div className="grid gap-2.5 md:grid-cols-2">
          <input id="pf_label" aria-label="档案名称" className="input" placeholder="档案名称（如 智谱 GLM-4.7-Flash）" value={pf.label || ''} onChange={(e) => setPf({ ...pf, label: e.target.value })} />
          <input id="pf_base_url" aria-label="接口地址 Base URL" className="input" placeholder="接口地址 Base URL" value={pf.base_url || ''} onChange={(e) => setPf({ ...pf, base_url: e.target.value })} />
          <input id="pf_api_key" aria-label="API Key" className="input" placeholder="API Key" value={pf.api_key || ''} onChange={(e) => setPf({ ...pf, api_key: e.target.value })} />
          <input id="pf_chat_model" aria-label="聊天模型名" className="input" placeholder="聊天模型名" value={pf.chat_model || ''} onChange={(e) => setPf({ ...pf, chat_model: e.target.value })} />
          <input id="pf_analysis_model" aria-label="分析模型名" className="input" placeholder="分析模型名（留空同聊天模型）" value={pf.analysis_model || ''} onChange={(e) => setPf({ ...pf, analysis_model: e.target.value })} />
          <input id="pf_note" aria-label="备注" className="input" placeholder="备注（可选）" value={pf.note || ''} onChange={(e) => setPf({ ...pf, note: e.target.value })} />
        </div>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <button
            className="btn"
            onClick={async () => {
              const j = await profilePost({ action: editingId ? 'update_profile' : 'save_profile', id: editingId, ...pf });
              if (j.error) {
                setToast(j.error);
                return;
              }
              setToast(editingId ? '已保存' : '已新增档案');
              setEditingId(null);
              setPf({ label: '', base_url: '', api_key: '', chat_model: '', analysis_model: '', note: '' });
            }}
          >
            {editingId ? '保存修改' : '新增'}
          </button>
          <button
            className="btn-ghost"
            onClick={async () => {
              const j = await profilePost({ action: 'save_current', label: `当前配置 ${new Date().toLocaleDateString('zh-CN')}` });
              setToast(j.error ? j.error : '已把当前设置存成新档案');
            }}
          >
            把当前设置存为新档案
          </button>
          {editingId ? (
            <button
              className="btn-ghost"
              onClick={() => {
                setEditingId(null);
                setPf({ label: '', base_url: '', api_key: '', chat_model: '', analysis_model: '', note: '' });
              }}
            >
              取消编辑
            </button>
          ) : null}
        </div>
        <p className="dim mt-2 leading-relaxed">
          当前模型报错 / 限流 / 超时（首字 12 秒无响应）时，会自动按备用顺序切到下一个模型，聊天不会中断；失败的模型进冷却后自动恢复。点 ↑↓ 调整备用顺序。
        </p>
      </div>
    </Card>
  );
}