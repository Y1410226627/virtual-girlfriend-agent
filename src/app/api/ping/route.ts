// 环境自检接口：模型连通性 / 数据库 / 向量模式
import { dbGet, llmConfig, getSetting } from '@/lib/db';
import { chat, embeddingMode, embed, lastUsedTarget, routePreview } from '@/lib/llm';
import { errMsg } from '@/lib/utils';
import { messageCount } from '@/lib/engine';
import { getRelationshipState } from '@/lib/relationship';
import { listProfiles, activeProfile, isCooling } from '@/lib/profiles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, unknown> = {};
  const cfg = llmConfig();

  checks.config = {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    analysisModel: cfg.analysisModel,
    embeddingModel: cfg.embeddingModel || '(未配置，使用本地向量)',
    analysisThinking: cfg.analysisThinking,
  };

  try {
    checks.database = {
      ok: true,
      defaults: dbGet('SELECT 1 AS ok'),
      counters: dbGet('SELECT value FROM counters ORDER BY rowid LIMIT 1'),
    };
  } catch (e) {
    checks.database = { ok: false, error: errMsg(e) };
  }

  try {
    const t0 = Date.now();
    const reply = await chat([{ role: 'user', content: '只回复两个字：在的' }], {
      maxTokens: 60,
      temperature: 0.3,
      thinking: false,
      timeoutMs: 15000,
    });
    checks.llm = { ok: true, ms: Date.now() - t0, reply: reply.slice(0, 60), used: lastUsedTarget() };
  } catch (e) {
    checks.llm = { ok: false, error: errMsg(e) };
  }

  try {
    const vecs = await embed(['你好，今天过得怎么样']);
    // 向量维度与库里已有记录不一致 → 旧记忆会检索不到，需要"重算全部向量"
    let dimMismatch: number | null = null;
    try {
      const existing = dbGet<{ dim: number }>(
        `SELECT dim FROM memory_embeddings WHERE dim > 0 GROUP BY dim ORDER BY COUNT(*) DESC LIMIT 1`
      );
      const other = dbGet<{ c: number }>(
        'SELECT COUNT(*) AS c FROM memory_embeddings WHERE dim > 0 AND dim != ?',
        vecs[0]?.length || 0
      );
      if (existing && Number(existing.dim) !== (vecs[0]?.length || 0) && Number(other?.c || 0) > 0) {
        dimMismatch = Number(existing.dim);
      }
    } catch {
      /* 没有记忆时忽略 */
    }
    checks.embedding = {
      ok: true,
      mode: embeddingMode(),
      dim: vecs[0]?.length || 0,
      dimMismatch,
      hint: dimMismatch
        ? `当前向量维度 ${vecs[0]?.length || 0} 与已有记忆的维度 ${dimMismatch} 不一致：请在设置页点"重算全部记忆向量"，否则旧记忆检索不到`
        : undefined,
    };
  } catch (e) {
    checks.embedding = { ok: false, error: errMsg(e) };
  }

  try {
    const rel = getRelationshipState();
    checks.state = {
      ok: true,
      stage: rel.stage,
      messages: messageCount(),
      intimacy: rel.intimacy,
      scene: rel.scene || 'online',
      sceneMode: getSetting('scene_mode') || 'auto',
    };
  } catch (e) {
    checks.state = { ok: false, error: errMsg(e) };
  }

  try {
    checks.profiles = {
      active: activeProfile()?.label || null,
      all: listProfiles().map((p) => ({
        id: p.id,
        label: p.label,
        model: p.chat_model,
        analysisModel: p.analysis_model,
        isDefault: p.is_default === 1,
        cooling: isCooling(`chat|${p.id}|${(p.base_url || '').replace(/\/+$/, '')}|${p.chat_model}`),
      })),
      lastUsed: lastUsedTarget(),
    };
  } catch (e) {
    checks.profiles = { error: errMsg(e) };
  }

  // 实际路由：验证"分析模型"配置有没有真的接上
  try {
    const routes = routePreview();
    checks.routing = {
      chat: routes.chat,
      analysis: routes.analysis,
      analysisModelEffective: routes.analysis[0] || null,
      configuredAnalysisModel: cfg.analysisModel || null,
      analysisModelWired: !!cfg.analysisModel && (routes.analysis[0] || '').includes(cfg.analysisModel),
    };
  } catch (e) {
    checks.routing = { error: errMsg(e) };
  }

  return Response.json(checks);
}