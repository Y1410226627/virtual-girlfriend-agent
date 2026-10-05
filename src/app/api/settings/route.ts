// 设置：模型档案（随时切换 + 自动备用链）/ 主动频率 / 场景 / 隐私
import { getAllSettings, getSetting, setSetting, llmConfig, wipeAllData, dbAll, bumpCounter, DEFAULT_USER_ID, SECRET_SETTING_KEYS, looksLikeMask, maskSecret, maskSettingsForClient, customModeOn } from '@/lib/db';
import { setPersonaField, setUserName, getPersona, getRelationshipState, saveRelationshipState, logRelationship } from '@/lib/relationship';
import { clamp } from '@/lib/utils';
import { STAGES } from '@/lib/stages';
import { embeddingMode, lastUsedTarget, testTarget, usageToday } from '@/lib/llm';
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
  resolveTestTarget,
  syncActiveProfileFields,
  recordKeyHost,
  keyHostFor,
} from '@/lib/profiles';
import { getPersonalityRows, manualAdjust } from '@/lib/personality';
import { getAttachmentState, setAttachmentAxes } from '@/lib/attachment';
import { setIntimacyState } from '@/lib/intimacy';
import { backfillEmbeddings } from '@/lib/memory';
import { setCycleEnabled } from '@/lib/life';

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
  // 语音（TTS）
  'tts_enabled',
  'tts_base_url',
  'tts_api_key',
  'tts_model',
  'tts_voice',
  // 她的照片（图片生成）
  'img_enabled',
  'img_base_url',
  'img_api_key',
  'img_model',
]);

// 需要"掩码值不回写"保护的敏感键（db 里只登记了模型的，这里补上语音/图片的）
const SECRET_KEYS = [...SECRET_SETTING_KEYS, 'tts_api_key', 'img_api_key'];

// 显式"清除已保存 Key"的哨兵值：把某个 Key 传成它（或放进 body.clear_keys）即表示
// "删除已保存的 Key、回退到环境变量"。单独的空串仍然表示"保持不变"（防误清空丢失明文）。
const CLEAR_TOKEN = '__clear__';

// 对外返回设置：模型 Key 走 db 的掩码，语音/图片 Key 在这里补打码
const maskedSettings = (settings: Record<string, string>) => {
  const out = maskSettingsForClient(settings);
  for (const k of ['tts_api_key', 'img_api_key']) {
    if (out[k]) out[k] = maskSecret(out[k]);
  }
  return out;
};

// 对外返回的模型档案一律打码，避免明文 Key 泄露
const maskedProfiles = () =>
  listProfiles().map((p) => ({
    ...p,
    api_key: maskSecret(p.api_key),
    embedding_api_key: maskSecret(p.embedding_api_key),
  }));

export async function GET() {
  seedProfilesIfEmpty();
  const settings = getAllSettings();
  const cfg = llmConfig();
  const persona = getPersona();
  return Response.json({
    settings: maskedSettings(settings),
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
      // Key 归属 host（P0-13）：前端据此在"改了 URL 但没重输 Key"时给出提示
      keyHost: keyHostFor('llm'),
      embeddingKeyHost: keyHostFor('embedding'),
    },
    profiles: listProfiles().map((p) => ({
      ...p,
      api_key: maskSecret(p.api_key),
      embedding_api_key: maskSecret(p.embedding_api_key),
    })),
    usage: usageToday(),
    health: healthSnapshot(),
  });
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => ({}));
  const incoming = body?.settings && typeof body.settings === 'object' ? body.settings : body;
  const changed: string[] = [];
  const cleared: string[] = [];
  // 显式"清除已保存 Key"：body.clear_keys = ['llm_api_key']，或对某个 Key 传 CLEAR_TOKEN。
  const clearSet = new Set<string>();
  const rawClear: unknown = body?.clear_keys;
  if (Array.isArray(rawClear)) {
    for (const k of rawClear) if (typeof k === 'string' && SECRET_KEYS.includes(k)) clearSet.add(k);
  }
  const RANGE: Record<string, [number, number]> = {
    context_size: [2, 60],
    memory_top_k: [3, 30],
    stage_dwell_days: [0, 30],
    personality_openness: [0, 2],
  };
  for (const [k, v] of Object.entries(incoming || {})) {
    if (!EDITABLE.has(k)) continue;
    // 敏感键三态：清除（CLEAR_TOKEN / clear_keys）→ 保持（空串、掩码值）→ 保存明文。
    // "空 = 保持不变"是为了避免用户清空输入框时把已保存的真实 Key 覆盖成空 → 明文永久丢失；
    // 真正想"改用环境变量"时请显式传 CLEAR_TOKEN 或 clear_keys。
    if (SECRET_KEYS.includes(k)) {
      if (clearSet.has(k) || String(v) === CLEAR_TOKEN) {
        setSetting(k, ''); // 空值 → 回退环境变量（llmConfig 的"空→env"语义）
        changed.push(k);
        cleared.push(k);
        continue;
      }
      if (looksLikeMask(v) || String(v ?? '') === '') continue;
    }
    let value: string;
    if (k in RANGE) {
      // 数值型键：越界钳制，非数字跳过
      const n = Number(v);
      if (!isFinite(n)) continue;
      value = String(clamp(n, RANGE[k]![0], RANGE[k]![1]));
    } else if (k === 'quiet_start' || k === 'quiet_end') {
      const s = String(v ?? '');
      if (!/^\d{1,2}:\d{2}$/.test(s)) continue;
      value = s;
    } else if (k === 'llm_base_url') {
      const s = String(v ?? '').trim();
      if (!/^https?:\/\//.test(s)) continue;
      value = s;
    } else if (k === 'tts_base_url' || k === 'img_base_url') {
      // 语音/图片接口地址：允许留空（= 关闭该功能，走优雅降级），填了才校验协议
      const s = String(v ?? '').trim();
      if (s && !/^https?:\/\//.test(s)) continue;
      value = s;
    } else {
      value = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v ?? '');
    }
    setSetting(k, value);
    changed.push(k);
  }
  // 只出现在 clear_keys 里、未出现在 incoming 的键也要清
  for (const k of clearSet) {
    if (cleared.includes(k)) continue;
    setSetting(k, '');
    changed.push(k);
    cleared.push(k);
  }
  if ('agent_name' in (incoming || {})) setPersonaField('agent_name', String(incoming.agent_name || ''));
  if ('agent_story' in (incoming || {})) setPersonaField('self_story', String(incoming.agent_story || ''));
  if ('user_name' in (incoming || {})) setUserName(String(incoming.user_name || ''));

  // P0-13：保存/清除 Key 时记录它的归属 host（URL 与凭据绑定）。
  // 同一次请求同时提交 URL 与 Key 时，"当前 base_url"就是新 URL → 视为用户意图、更新绑定。
  const effLlmBase = getSetting('llm_base_url') || process.env.LLM_BASE_URL || '';
  const effEmbBase = getSetting('embedding_base_url') || effLlmBase;
  if (changed.includes('llm_api_key')) {
    recordKeyHost('llm', cleared.includes('llm_api_key') ? '' : effLlmBase);
  }
  if (changed.includes('embedding_api_key')) {
    recordKeyHost('embedding', cleared.includes('embedding_api_key') ? '' : effEmbBase);
  }

  // 改模型 / 向量相关设置后，让缓存按新配置重建，确保立即生效
  if (changed.some((k) => k.startsWith('llm_') || k.startsWith('embedding_') || k === 'analysis_thinking')) {
    bumpCounter('config_version', 1);
  }
  if ('cycle_enabled' in (incoming || {})) {
    setCycleEnabled(String(incoming.cycle_enabled) === 'true');
  }

  // P1-42 双事实源归一：保存了高级设置（llm_* / embedding_*）且存在激活档案时，
  // 同步写穿到该档案，保证"高级设置"与"当前档案"两边一致（否则 targetsFor 会调用档案里的旧值）。
  const llmTouched = changed.some((k) => k.startsWith('llm_') || k.startsWith('embedding_'));
  const syncedProfile = llmTouched ? syncActiveProfileFields(changed) : null;

  return Response.json({
    ok: true,
    changed,
    cleared,
    syncedProfile,
    settings: maskedSettings(getAllSettings()),
    profiles: maskedProfiles(),
  });
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
      profiles: maskedProfiles(),
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
    return Response.json({ ok: true, id, profiles: maskedProfiles() });
  }

  if (action === 'save_current') {
    const label = String(body.label || '').trim() || `当前配置 ${new Date().toLocaleDateString('zh-CN')}`;
    const id = saveCurrentAsProfile(label, body.note ? String(body.note) : undefined);
    return Response.json({ ok: true, id, profiles: maskedProfiles() });
  }

  if (action === 'delete_profile') {
    const ok = deleteProfile(Number(body.id));
    return Response.json({ ok, profiles: maskedProfiles(), activeProfile: activeProfile()?.label || null });
  }

  if (action === 'move_profile') {
    moveProfile(Number(body.id), Number(body.dir) < 0 ? -1 : 1);
    return Response.json({ ok: true, profiles: maskedProfiles() });
  }

  if (action === 'test_profile') {
    // P1-58：传了 id 但找不到档案 → 404，绝不退化成"测试当前配置"（否则用户以为测的是该档案）
    let src: { baseUrl: unknown; apiKey: unknown; model: unknown; label: unknown };
    if (body.id) {
      const p = listProfiles().find((x) => x.id === Number(body.id));
      if (!p) return Response.json({ error: '档案不存在' }, { status: 404 });
      src = { baseUrl: p.base_url, apiKey: p.api_key, model: p.chat_model, label: p.label };
    } else {
      src = { baseUrl: body.base_url, apiKey: body.api_key, model: body.chat_model, label: body.label };
    }
    // 统一走纯函数校验：地址必须是合法的 http(s) URL；
    // 自定地址且未带 Key 时不回落服务端保存的 Key（防止真实 Key 被发往任意地址）
    const resolved = resolveTestTarget(src, {
      baseUrl: llmConfig().baseUrl,
      apiKey: llmConfig().apiKey,
      model: llmConfig().model,
    });
    if (!resolved.ok) return Response.json({ ok: false, error: resolved.error }, { status: 400 });
    const r = await testTarget(resolved.target, { timeoutMs: Number(body.timeoutMs) || 30000 });
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
    // 只有开启自定义模式才允许数值直控
    if (!customModeOn()) return Response.json({ error: '先打开自定义模式' }, { status: 400 });
    // 自定义模式：数值直控（全部钳制到合法范围；不改动任何开关与配置）
    const v = (body.values && typeof body.values === 'object' ? body.values : {}) as Record<string, unknown>;
    const numOr = (x: unknown, d: number) => {
      // 空 = 保持原值：Number('') === 0，若不先拦下会把数值静默归零
      if (x === '' || x === null || x === undefined) return d;
      if (typeof x === 'string' && x.trim() === '') return d;
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
      // 阶段与亲密度区间保持一致：把亲密度钳制到目标阶段 [min,max]
      rel.intimacy = clamp(Number(rel.intimacy), STAGES[st]!.min, STAGES[st]!.max);
    }
    saveRelationshipState(rel);

    const pv = (v.personality && typeof v.personality === 'object' ? v.personality : {}) as Record<string, unknown>;
    const personalityRows = getPersonalityRows();
    for (const dim of ['warmth', 'playfulness', 'romance', 'directness', 'independence', 'emotional_intensity']) {
      if (pv[dim] === undefined) continue;
      // 空值保持"当前值"（而非硬编码 50），与"空 = 不修改"的语义一致
      const cur = Number(personalityRows.find((r) => r.dimension === dim)?.value ?? 50);
      manualAdjust(dim, numOr(pv[dim], cur), '自定义模式：数值直控');
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
      // setIntimacyState 内部的 Number('')===0 会把清空的框归零：这里先剔除空值，只提交真正填写过的字段
      const iv: Parameters<typeof setIntimacyState>[0] = {};
      for (const k of ['libido', 'intimacy_need', 'sexual_satisfaction', 'sexual_stress'] as const) {
        const raw = v[k];
        if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) continue;
        const n = Number(raw);
        if (isFinite(n)) iv[k] = n;
      }
      if (Object.keys(iv).length) setIntimacyState(iv);
    }

    logRelationship('milestone', '自定义模式：数值已按设定更新', null, null, '用户在设置页直控');
    return Response.json({ ok: true });
  }

  if (action === 'reset') {
    if (body.confirm !== 'RESET') return Response.json({ error: '缺少确认（confirm=RESET）' }, { status: 400 });
    const keepSettings = body.keepSettings !== false;
    wipeAllData(keepSettings);
    return Response.json({ ok: true, message: keepSettings ? '已清空记忆、性格、依恋、关系与聊天记录（设置保留）' : '已恢复初始状态（包含设置）' });
  }

  if (action === 'export') {
    const data: Record<string, unknown> = {
      schema_version: 1,
      exported_at: new Date().toISOString(),
      persona: getPersona(),
      user: { name: getAllSettings().user_name },
      relationship_state: getRelationshipState(),
      attachment_state: getAttachmentState(),
      personality_state: getPersonalityRows(),
      // 导出的文件可能被分享：Key 同样只给掩码
      settings: maskedSettings(getAllSettings()),
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