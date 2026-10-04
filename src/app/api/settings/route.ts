// 设置：模型档案（随时切换 + 自动备用链）/ 主动频率 / 场景 / 隐私
import { getAllSettings, setSetting, llmConfig, wipeAllData, dbAll, dbRun, bumpCounter, DEFAULT_USER_ID, SECRET_SETTING_KEYS, looksLikeMask, maskSecret, maskSettingsForClient } from '@/lib/db';
import { setPersonaField, setUserName, getPersona, getRelationshipState, saveRelationshipState, logRelationship } from '@/lib/relationship';
import { clamp } from '@/lib/utils';
import { STAGES } from '@/lib/stages';
import { embeddingMode, lastUsedTarget, testTarget } from '@/lib/llm';
import {
  listProfiles,
  applyProfile,
  upsertProfile,
  deleteProfile,
  moveProfile,
  saveCurrentAsProfile,
  activeProfile,
  seedProfilesIfEmpty,
  healthSnapshot,
} from '@/lib/profiles';
import { getPersonalityRows, manualAdjust } from '@/lib/personality';
import { getAttachmentState, setAttachmentAxes } from '@/lib/attachment';
import { getIntimacy } from '@/lib/intimacy';
import { backfillEmbeddings } from '@/lib/memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EDITABLE = new Set([
  'agent_name',
  'user_name',
  'user_profile',
  'agent_story',
  'personality_openness',
  'proactive_frequency',
  'quiet_start',
  'quiet_end',
  'dnd',
  'stage_dwell_days',
  'context_size',
  'memory_top_k',
  'scene_mode',
  'custom_mode',
  'life_enabled',
  'cycle_enabled',
  'life_share_chance',
  'llm_base_url',
  'llm_api_key',
  'llm_model',
  'llm_analysis_model',
  'embedding_model',
  'embedding_base_url',
  'embedding_api_key',
  'analysis_thinking',
]);

export async function GET() {
  seedProfilesIfEmpty();
  const settings = getAllSettings();
  const cfg = llmConfig();
  const persona = getPersona();
  return Response.json({
    settings: maskSettingsForClient(settings),
    persona,
    effective: {
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      analysisModel: cfg.analysisModel,
      embeddingModel: cfg.embeddingModel,
      embeddingBaseUrl: cfg.embeddingBaseUrl,
      hasKey: !!cfg.apiKey,
      keyFromEnv: !settings.llm_api_key && !!process.env.LLM_API_KEY,
      baseUrlFromEnv: !settings.llm_base_url && !!process.env.LLM_BASE_URL,
      embeddingMode: embeddingMode(),
      analysisThinking: cfg.analysisThinking,
      activeProfile: activeProfile()?.label || null,
      lastUsed: lastUsedTarget(),
    },
    profiles: listProfiles().map((p) => ({
      ...p,
      api_key: maskSecret(p.api_key),
      embedding_api_key: maskSecret(p.embedding_api_key),
    })),
    health: healthSnapshot(),
  });
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => ({}));
  const incoming = body?.settings && typeof body.settings === 'object' ? body.settings : body;
  const changed: string[] = [];
  for (const [k, v] of Object.entries(incoming || {})) {
    if (!EDITABLE.has(k)) continue;
    // 前端回传的掩码值不算修改（避免把"••••1234"当成新 Key 存进去）
    if (SECRET_SETTING_KEYS.includes(k) && looksLikeMask(v)) continue;
    setSetting(k, typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v ?? ''));
    changed.push(k);
  }
  if ('agent_name' in (incoming || {})) setPersonaField('agent_name', String(incoming.agent_name || ''));
  if ('agent_story' in (incoming || {})) setPersonaField('self_story', String(incoming.agent_story || ''));
  if ('user_name' in (incoming || {})) setUserName(String(incoming.user_name || ''));

  // 改模型 / 向量相关设置后，让缓存按新配置重建，确保立即生效
  if (changed.some((k) => k.startsWith('llm_') || k.startsWith('embedding_') || k === 'analysis_thinking')) {
    bumpCounter('config_version', 1);
  }
  if ('cycle_enabled' in (incoming || {})) {
    dbRun('UPDATE agent_health SET cycle_enabled = ? WHERE user_id = ?', String(incoming.cycle_enabled) === 'true' ? 1 : 0, DEFAULT_USER_ID);
  }
  return Response.json({ ok: true, changed, settings: maskSettingsForClient(getAllSettings()), profiles: listProfiles().map((p) => ({ ...p, api_key: maskSecret(p.api_key), embedding_api_key: maskSecret(p.embedding_api_key) })) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || '');
  seedProfilesIfEmpty();

  if (action === 'apply_profile') {
    const id = Number(body.id);
    const ok = applyProfile(id);
    return Response.json({
      ok,
      message: ok ? `已切换到「${activeProfile()?.label}」，立即生效` : '档案不存在',
      profiles: listProfiles(),
      effective: {
        baseUrl: llmConfig().baseUrl,
        model: llmConfig().model,
        analysisModel: llmConfig().analysisModel,
        embeddingMode: embeddingMode(),
      },
    });
  }

  if (action === 'save_profile' || action === 'update_profile') {
    const label = String(body.label || '').trim();
    const baseUrl = String(body.base_url || '').trim();
    const chatModel = String(body.chat_model || '').trim();
    if (!label || !baseUrl || !chatModel) return Response.json({ error: '名称、接口地址、模型名都不能为空' }, { status: 400 });
    const id = upsertProfile({
      id: body.id ? Number(body.id) : undefined,
      label,
      base_url: baseUrl.replace(/\/+$/, ''),
      api_key: String(body.api_key || ''),
      chat_model: chatModel,
      analysis_model: String(body.analysis_model || chatModel),
      embedding_base_url: body.embedding_base_url !== undefined ? String(body.embedding_base_url) : undefined,
      embedding_api_key: body.embedding_api_key !== undefined ? String(body.embedding_api_key) : undefined,
      embedding_model: body.embedding_model !== undefined ? String(body.embedding_model) : undefined,
      note: body.note !== undefined ? String(body.note) : undefined,
    });
    return Response.json({ ok: true, id, profiles: listProfiles() });
  }

  if (action === 'save_current') {
    const label = String(body.label || '').trim() || `当前配置 ${new Date().toLocaleDateString('zh-CN')}`;
    const id = saveCurrentAsProfile(label, body.note ? String(body.note) : undefined);
    return Response.json({ ok: true, id, profiles: listProfiles() });
  }

  if (action === 'delete_profile') {
    const ok = deleteProfile(Number(body.id));
    return Response.json({ ok, profiles: listProfiles(), activeProfile: activeProfile()?.label || null });
  }

  if (action === 'move_profile') {
    moveProfile(Number(body.id), Number(body.dir) < 0 ? -1 : 1);
    return Response.json({ ok: true, profiles: listProfiles() });
  }

  if (action === 'test_profile') {
    const p = body.id ? listProfiles().find((x) => x.id === Number(body.id)) : null;
    const target = p
      ? { baseUrl: p.base_url, apiKey: p.api_key, model: p.chat_model, label: p.label }
      : {
          baseUrl: String(body.base_url || llmConfig().baseUrl),
          apiKey: String(body.api_key || llmConfig().apiKey),
          model: String(body.chat_model || llmConfig().model),
          label: String(body.label || '当前配置'),
        };
    const r = await testTarget(target, { timeoutMs: Number(body.timeoutMs) || 30000 });
    return Response.json({ ok: r.ok, result: r });
  }

  if (action === 'rebuild_embeddings') {
    // 换向量模型/接口后，把全部记忆向量按当前模型重算（也补齐缺失的）
    const limit = Math.min(2000, Math.max(50, Number(body.limit) || 400));
    let total = 0;
    for (let i = 0; i < 40; i++) {
      const n = await backfillEmbeddings(50);
      total += n;
      if (n < 50 || total >= limit) break;
    }
    return Response.json({ ok: true, count: total, limit });
  }

  if (action === 'custom_values') {
    // 自定义模式：数值直控（全部钳制到合法范围；不改动任何开关与配置）
    const v = (body.values && typeof body.values === 'object' ? body.values : {}) as Record<string, any>;
    const numOr = (x: any, d: number) => {
      const n = Number(x);
      return isFinite(n) ? n : d;
    };
    const rel = getRelationshipState();
    if (v.intimacy !== undefined) rel.intimacy = clamp(numOr(v.intimacy, Number(rel.intimacy)), 0, 100);
    if (v.trust !== undefined) rel.trust = clamp(numOr(v.trust, Number(rel.trust)), 0, 100);
    if (v.emotional_balance !== undefined) rel.emotional_balance = clamp(numOr(v.emotional_balance, Number(rel.emotional_balance)), -100, 100);
    if (v.unresolved_tension !== undefined) rel.unresolved_tension = clamp(numOr(v.unresolved_tension, Number(rel.unresolved_tension)), 0, 100);
    if (v.repair_credit !== undefined) rel.repair_credit = clamp(numOr(v.repair_credit, Number(rel.repair_credit)), 0, 100);
    if (v.mood !== undefined && String(v.mood).trim()) rel.mood = String(v.mood).trim().slice(0, 12);
    if (v.stage !== undefined) {
      const st = clamp(Math.round(numOr(v.stage, Number(rel.stage))), 0, STAGES.length - 1);
      if (st !== Number(rel.stage)) {
        rel.stage = st;
        rel.stage_entered_at = new Date().toISOString();
        rel.stage_cap_since = null;
        rel.pending_stage_confirm = 0;
        rel.pending_relationship_talk = 0;
      }
    }
    saveRelationshipState(rel);

    const pv = (v.personality && typeof v.personality === 'object' ? v.personality : {}) as Record<string, any>;
    for (const dim of ['warmth', 'playfulness', 'romance', 'directness', 'independence', 'emotional_intensity']) {
      if (pv[dim] !== undefined) manualAdjust(dim, numOr(pv[dim], 50), '自定义模式：数值直控');
    }

    if (v.anxiety !== undefined || v.avoidance !== undefined) {
      const cur = getAttachmentState();
      setAttachmentAxes(
        numOr(v.anxiety, Number(cur.anxiety)),
        numOr(v.avoidance, Number(cur.avoidance)),
        '自定义模式：数值直控',
        '用户在设置页手动设定'
      );
    }

    if (v.libido !== undefined || v.intimacy_need !== undefined || v.sexual_satisfaction !== undefined || v.sexual_stress !== undefined) {
      const s = getIntimacy();
      const set01 = (x: any, d: number) => clamp(numOr(x, d), 0, 100);
      dbRun(
        'UPDATE intimacy_state SET libido = ?, intimacy_need = ?, sexual_satisfaction = ?, sexual_stress = ?, updated_at = ? WHERE user_id = ?',
        set01(v.libido, Number(s.libido)),
        set01(v.intimacy_need, Number(s.intimacy_need)),
        set01(v.sexual_satisfaction, Number(s.sexual_satisfaction)),
        set01(v.sexual_stress, Number(s.sexual_stress)),
        new Date().toISOString(),
        DEFAULT_USER_ID
      );
    }

    logRelationship('milestone', '自定义模式：数值已按设定更新', null, null, '用户在设置页直控');
    return Response.json({ ok: true });
  }

  if (action === 'reset') {
    const keepSettings = body.keepSettings !== false;
    wipeAllData(keepSettings);
    return Response.json({ ok: true, message: keepSettings ? '已清空记忆、性格、依恋、关系与聊天记录（设置保留）' : '已恢复初始状态（包含设置）' });
  }

  if (action === 'export') {
    const data: Record<string, any> = {
      schema_version: 1,
      exported_at: new Date().toISOString(),
      persona: getPersona(),
      user: { name: getAllSettings().user_name },
      relationship_state: getRelationshipState(),
      attachment_state: getAttachmentState(),
      personality_state: getPersonalityRows(),
      // 导出的文件可能被分享：Key 同样只给掩码
      settings: maskSettingsForClient(getAllSettings()),
      model_profiles: listProfiles().map((p) => ({
        ...p,
        api_key: maskSecret(p.api_key),
        embedding_api_key: maskSecret(p.embedding_api_key),
      })),
    };
    for (const t of [
      'messages',
      'memories',
      'relationship_logs',
      'emotional_bank',
      'daily_summaries',
      'events',
      'personality_logs',
      'personality_signals',
      'personality_snapshots',
      'attachment_logs',
      'attachment_signals',
      'conflict_logs',
      'proactive_messages',
    ]) {
      data[t] = dbAll(`SELECT * FROM ${t} WHERE user_id = ?`, DEFAULT_USER_ID);
    }
    return Response.json({ ok: true, data });
  }

  return Response.json({ error: '未知操作' }, { status: 400 });
}