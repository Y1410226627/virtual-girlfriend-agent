'use client';

import { Card, Chip } from '@/components/ui';
import { CLEAR_KEY_TOKEN, type EffectiveInfo, type PingResult, type ProfilePostResult, type SaveFn, type SetFieldFn, type SetToast } from './shared';

/** 取 URL 的 host（小写）；非法 URL 返回空串 */
function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

export function AdvancedApiCard({
  form,
  set,
  save,
  saving,
  eff,
  profilePost,
  ping,
  setToast,
}: {
  form: Record<string, string>;
  set: SetFieldFn;
  save: SaveFn;
  saving: boolean;
  eff: Partial<EffectiveInfo>;
  profilePost: (body: Record<string, unknown>) => Promise<ProfilePostResult>;
  ping: PingResult | null;
  setToast: SetToast;
}) {
  // P0-13：URL 改了、但没重新输入 Key → 提醒旧 Key 不会发往新地址
  const llmHost = hostOf(form.llm_base_url ?? '');
  const embHost = hostOf(form.embedding_base_url ?? '');
  const keyHost = (eff.keyHost || '').toLowerCase();
  const embKeyHost = (eff.embeddingKeyHost || '').toLowerCase();
  const llmHostMismatch = !eff.keyFromEnv && !!eff.hasKey && !!llmHost && !!keyHost && llmHost !== keyHost;
  const embHostMismatch = !!embKeyHost && !!embHost && embHost !== embKeyHost;

  return (
    <Card title="高级：手动填写接口参数">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="label">接口地址 Base URL</label>
          <input className="input" value={form.llm_base_url ?? ''} onChange={(e) => set('llm_base_url', e.target.value)} placeholder="https://api.example.com/v1" />
        </div>
        <div>
          <label className="label">API Key</label>
          <input className="input" type="password" value={form.llm_api_key ?? ''} onChange={(e) => set('llm_api_key', e.target.value)} placeholder="粘贴新 Key 才会覆盖；留空 = 保持已保存的 Key" />
          <p className="dim mt-1 leading-relaxed">
            留空不会删除已保存的 Key（防止误清空丢失明文）。想改用环境变量里的 Key，点下方「清除已保存的 Key」。
          </p>
          <button
            className="btn-ghost mt-1 !py-1 text-xs"
            disabled={saving}
            onClick={() => save(['llm_api_key'], '已清除保存的 Key，改用环境变量', { llm_api_key: CLEAR_KEY_TOKEN })}
          >
            清除已保存的 Key（改用环境变量）
          </button>
        </div>
        <div>
          <label className="label">聊天模型</label>
          <input className="input" value={form.llm_model ?? ''} onChange={(e) => set('llm_model', e.target.value)} placeholder="qwen3.8-27b" />
        </div>
        <div>
          <label className="label">分析模型（记忆抽取用，通常同上）</label>
          <input className="input" value={form.llm_analysis_model ?? ''} onChange={(e) => set('llm_analysis_model', e.target.value)} />
        </div>
        <div>
          <label className="label">向量模型（记忆语义检索）</label>
          <input className="input" value={form.embedding_model ?? ''} onChange={(e) => set('embedding_model', e.target.value)} placeholder="qwen3-vl-embedding-8b" />
        </div>
        <div>
          <label className="label">向量接口地址（留空 = 跟聊天接口相同）</label>
          <input className="input" value={form.embedding_base_url ?? ''} onChange={(e) => set('embedding_base_url', e.target.value)} placeholder="https://api.example.com/v1" />
        </div>
        <div>
          <label className="label">向量接口 Key（留空 = 跟聊天 Key 相同）</label>
          <input className="input" type="password" value={form.embedding_api_key ?? ''} onChange={(e) => set('embedding_api_key', e.target.value)} />
          <button
            className="btn-ghost mt-1 !py-1 text-xs"
            disabled={saving}
            onClick={() => save(['embedding_api_key'], '已清除保存的向量 Key，改用环境变量/聊天 Key', { embedding_api_key: CLEAR_KEY_TOKEN })}
          >
            清除已保存的向量 Key
          </button>
        </div>
        <div>
          <label className="label">后台分析深度思考（更准但更慢）</label>
          <select className="input" value={form.analysis_thinking ?? 'false'} onChange={(e) => set('analysis_thinking', e.target.value)}>
            <option value="false">关闭（推荐，快）</option>
            <option value="true">开启（慢，可能更细致）</option>
          </select>
        </div>
      </div>
      {llmHostMismatch || embHostMismatch ? (
        <p className="mt-3 rounded-2xl border line accent-soft px-3.5 py-2 text-xs acc">
          {llmHostMismatch ? `接口地址的域（${llmHost}）和已保存 Key 的域（${keyHost}）不一致：为安全起见，旧 Key 不会被发往新地址。` : ''}
          {embHostMismatch ? ` 向量接口地址的域（${embHost}）和已保存向量 Key 的域（${embKeyHost}）不一致：旧向量 Key 不会被发往新地址。` : ''}
          如果这里就是你要用的新地址，请在同一张卡片里把对应的 Key 一起重新填写后再保存。
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn" onClick={() => save(['llm_base_url', 'llm_api_key', 'llm_model', 'llm_analysis_model', 'embedding_model', 'embedding_base_url', 'embedding_api_key', 'analysis_thinking'], '模型设置已保存，立即生效')} disabled={saving}>
          保存并立即生效
        </button>
        <Chip tone="plain">当前生效：{eff.model} @ {eff.baseUrl}</Chip>
        <Chip tone="plain">向量：{eff.embeddingMode}</Chip>
        {eff.activeProfile ? <Chip tone="plain">保存会同步到当前档案「{eff.activeProfile}」</Chip> : null}
        {eff.lastUsed ? (
          <Chip tone="plain">
            实际服务：{eff.lastUsed.model}{eff.lastUsed.fallback ? '（自动降级）' : ''}
          </Chip>
        ) : null}
        {eff.baseUrlFromEnv || eff.keyFromEnv ? <Chip tone="plain">部分配置来自 .env.local</Chip> : null}
        <button
          className="btn-ghost"
          onClick={async () => {
            const j = await profilePost({ action: 'rebuild_embeddings' });
            setToast(j.ok ? `已重算 ${j.count} 条记忆向量` : '重算失败');
          }}
        >
          重算全部记忆向量
        </button>
      </div>

      {ping ? (
        <div className="mt-4 space-y-1.5 rounded-2xl accent-soft px-4 py-3 text-xs">
          <div>数据库：{ping.database?.ok ? '✅ 正常' : `❌ ${ping.database?.error}`}</div>
          <div>聊天模型：{ping.llm?.ok ? `✅ ${ping.llm.ms}ms · ${ping.llm.reply}` : `❌ ${ping.llm?.error}`}</div>
          <div>向量模型：{ping.embedding?.ok ? `✅ ${ping.embedding.mode} · ${ping.embedding.dim} 维` : `❌ ${ping.embedding?.error}`}</div>
          <div>关系状态：{ping.state?.ok ? `✅ 阶段 ${ping.state.stage} · ${ping.state.messages} 条消息 · 场景 ${ping.state.scene === 'offline' ? '线下' : '线上'}（${ping.state.sceneMode}）` : `❌ ${ping.state?.error}`}</div>
          <div>向量连接（可单独配置）：{form.embedding_base_url || eff.baseUrl}</div>
        </div>
      ) : null}
    </Card>
  );
}