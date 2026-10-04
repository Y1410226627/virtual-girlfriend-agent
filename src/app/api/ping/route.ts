// 环境自检接口：模型连通性 / 数据库 / 向量模式
import { dbGet, dbRun, llmConfig, getSetting } from '@/lib/db';
import { chat, embeddingMode, embed, lastUsedTarget } from '@/lib/llm';
import { ensureScheduler } from '@/lib/scheduler';
import { messageCount } from '@/lib/engine';
import { getRelationshipState } from '@/lib/relationship';
import { listProfiles, activeProfile, isCooling } from '@/lib/profiles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  ensureScheduler();
  const checks: Record<string, any> = {};
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
  } catch (e: any) {
    checks.database = { ok: false, error: e?.message || String(e) };
  }

  try {
    const t0 = Date.now();
    const reply = await chat([{ role: 'user', content: '只回复两个字：在的' }], {
      maxTokens: 60,
      temperature: 0.3,
      thinking: false,
    });
    checks.llm = { ok: true, ms: Date.now() - t0, reply: reply.slice(0, 60), used: lastUsedTarget() };
  } catch (e: any) {
    checks.llm = { ok: false, error: e?.message || String(e) };
  }

  try {
    const vecs = await embed(['你好，今天过得怎么样']);
    checks.embedding = { ok: true, mode: embeddingMode(), dim: vecs[0]?.length || 0 };
  } catch (e: any) {
    checks.embedding = { ok: false, error: e?.message || String(e) };
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
  } catch (e: any) {
    checks.state = { ok: false, error: e?.message || String(e) };
  }

  try {
    checks.profiles = {
      active: activeProfile()?.label || null,
      all: listProfiles().map((p) => ({
        id: p.id,
        label: p.label,
        model: p.chat_model,
        isDefault: p.is_default === 1,
        cooling: isCooling(`${(p.base_url || '').replace(/\/+$/, '')}|${p.chat_model}|chat`),
      })),
      lastUsed: lastUsedTarget(),
    };
  } catch (e: any) {
    checks.profiles = { error: e?.message || String(e) };
  }

  return Response.json(checks);
}