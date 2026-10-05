'use client';

import { Card, Chip } from '@/components/ui';
import type { EffectiveInfo, PingResult, ProfilePostResult, SaveFn, SetFieldFn, SetToast } from './shared';

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
  return (
    <Card title="高级：手动填写接口参数">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="label">接口地址 Base URL</label>
          <input className="input" value={form.llm_base_url ?? ''} onChange={(e) => set('llm_base_url', e.target.value)} placeholder="https://api.example.com/v1" />
        </div>
        <div>
          <label className="label">API Key</label>
          <input className="input" type="password" value={form.llm_api_key ?? ''} onChange={(e) => set('llm_api_key', e.target.value)} placeholder="留空则使用 .env.local" />
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
        </div>
        <div>
          <label className="label">后台分析深度思考（更准但更慢）</label>
          <select className="input" value={form.analysis_thinking ?? 'false'} onChange={(e) => set('analysis_thinking', e.target.value)}>
            <option value="false">关闭（推荐，快）</option>
            <option value="true">开启（慢，可能更细致）</option>
          </select>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn" onClick={() => save(['llm_base_url', 'llm_api_key', 'llm_model', 'llm_analysis_model', 'embedding_model', 'embedding_base_url', 'embedding_api_key', 'analysis_thinking'], '模型设置已保存，立即生效')} disabled={saving}>
          保存并立即生效
        </button>
        <Chip tone="plain">当前生效：{eff.model} @ {eff.baseUrl}</Chip>
        <Chip tone="plain">向量：{eff.embeddingMode}</Chip>
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