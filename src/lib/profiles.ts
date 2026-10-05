// 模型档案：用过的模型都留着，随时切换；按顺序组成"自动备用链"
import { dbAll, dbGet, dbRun, tx, DEFAULT_USER_ID, getSetting, setSetting, bumpCounter } from './db';
import { nowIso } from './utils';

export interface ModelProfile {
  id: number;
  user_id: number;
  label: string;
  base_url: string;
  api_key: string;
  chat_model: string;
  analysis_model: string | null;
  embedding_base_url: string | null;
  embedding_api_key: string | null;
  embedding_model: string | null;
  note: string | null;
  is_default: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export function listProfiles(): ModelProfile[] {
  return dbAll<ModelProfile>(
    'SELECT * FROM model_profiles WHERE user_id = ? ORDER BY is_default DESC, sort_order ASC, id ASC',
    DEFAULT_USER_ID
  );
}

export function getProfile(id: number): ModelProfile | undefined {
  return dbGet<ModelProfile>('SELECT * FROM model_profiles WHERE id = ? AND user_id = ?', id, DEFAULT_USER_ID);
}

/** 首次使用：把当前配置 + 常用模型存成档案，方便随时切换 */
export function seedProfilesIfEmpty(): void {
  const row = dbGet<{ c: number }>(
    'SELECT COUNT(*) AS c FROM model_profiles WHERE user_id = ?',
    DEFAULT_USER_ID
  );
  if (Number(row?.c || 0) > 0) return;

  const now = nowIso();
  const chatBase = (getSetting('llm_base_url') || process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const chatKey = getSetting('llm_api_key') || process.env.LLM_API_KEY || '';
  const chatModel = getSetting('llm_model') || process.env.LLM_MODEL || '';
  const analysisModel = getSetting('llm_analysis_model') || process.env.LLM_ANALYSIS_MODEL || chatModel;
  const embModel = getSetting('embedding_model') || process.env.EMBEDDING_MODEL || '';
  const embBase = (getSetting('embedding_base_url') || chatBase).replace(/\/+$/, '');
  const embKey = getSetting('embedding_api_key') || chatKey;

  // 已经配好接口（.env.local 或设置里）时：不改动任何设置，只把当前配置收录成第一个档案
  const hasConfigured = !!(chatBase || chatKey || chatModel);
  const seeds: Array<Partial<ModelProfile> & { label: string; base_url: string; api_key: string; chat_model: string }> = [];

  if (hasConfigured) {
    seeds.push({
      label: '当前配置',
      base_url: chatBase,
      api_key: chatKey,
      chat_model: chatModel || 'qwen3.8-27b',
      analysis_model: analysisModel,
      embedding_base_url: embBase,
      embedding_api_key: embKey,
      embedding_model: embModel,
      note: '来自 .env.local / 当前设置（首次启动自动收录）',
    });
  }
  // 智谱 GLM-4.7-Flash（免费 flash，可作为备用）
  seeds.push({
    label: '智谱 GLM-4.7-Flash',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key: '',
    chat_model: 'glm-4.7-flash',
    analysis_model: 'glm-4.5-air',
    embedding_base_url: embBase || '',
    embedding_api_key: embKey || '',
    embedding_model: embModel,
    note: '智谱开放平台。免费 flash 模型，高峰期可能限流，会自动切到备用模型',
  });
  // 智谱 GLM-4.5-Air（实测最快）
  seeds.push({
    label: '智谱 GLM-4.5-Air',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key: '',
    chat_model: 'glm-4.5-air',
    analysis_model: 'glm-4.5-air',
    embedding_base_url: embBase || '',
    embedding_api_key: embKey || '',
    embedding_model: embModel,
    note: '同平台更轻快的模型，实测响应最快',
  });

  tx(() => {
    seeds.forEach((s, i) => {
      dbRun(
        `INSERT INTO model_profiles (user_id, label, base_url, api_key, chat_model, analysis_model,
           embedding_base_url, embedding_api_key, embedding_model, note, is_default, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        DEFAULT_USER_ID,
        s.label,
        s.base_url,
        s.api_key,
        s.chat_model,
        s.analysis_model || s.chat_model,
        s.embedding_base_url || '',
        s.embedding_api_key || '',
        s.embedding_model || '',
        s.note || null,
        i === 0 ? 1 : 0,
        i,
        now,
        now
      );
    });
  });

  // 完全没有配置过接口时，才把第一个档案（智谱 flash）写进设置当默认；
  // 已经配过（.env.local / 设置）则不动设置，避免覆盖用户自己的接口
  if (!hasConfigured) {
    const first = listProfiles()[0];
    if (first) applyProfile(first.id, true);
  }
}

/** 切换当前使用的模型档案（立即生效：设置写入后每次请求都会重新读取） */
export function applyProfile(id: number, silent = false): boolean {
  const p = getProfile(id);
  if (!p) return false;
  tx(() => {
    dbRun('UPDATE model_profiles SET is_default = 0 WHERE user_id = ?', DEFAULT_USER_ID);
    dbRun('UPDATE model_profiles SET is_default = 1, updated_at = ? WHERE id = ?', nowIso(), id);
    setSetting('llm_base_url', p.base_url);
    setSetting('llm_api_key', p.api_key);
    setSetting('llm_model', p.chat_model);
    setSetting('llm_analysis_model', p.analysis_model || p.chat_model);
    if (p.embedding_model !== null) setSetting('embedding_model', p.embedding_model || '');
    if (p.embedding_base_url !== null) setSetting('embedding_base_url', p.embedding_base_url || '');
    if (p.embedding_api_key !== null) setSetting('embedding_api_key', p.embedding_api_key || '');
  });
  // 让向量缓存等按新配置重建
  bumpCounter('config_version', 1);
  if (!silent) console.log(`[模型] 已切换到「${p.label}」（${p.chat_model}）`);
  return true;
}

/** 前端回传的掩码值（••••xxxx）不能当成真实 Key：保留旧值 */
function keepSecretValue(incoming: unknown, cur: string | null | undefined): string {
  if (incoming === undefined || incoming === null) return String(cur || '');
  const s = String(incoming);
  return s.includes('•') ? String(cur || '') : s;
}

export function upsertProfile(data: Partial<ModelProfile> & { label: string; base_url: string; chat_model: string }): number {
  const now = nowIso();
  if (data.id) {
    const cur = getProfile(Number(data.id));
    if (!cur) return 0;
    dbRun(
      `UPDATE model_profiles SET label = ?, base_url = ?, api_key = ?, chat_model = ?, analysis_model = ?,
         embedding_base_url = ?, embedding_api_key = ?, embedding_model = ?, note = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      data.label,
      data.base_url,
      keepSecretValue(data.api_key, cur.api_key),
      data.chat_model,
      data.analysis_model ?? cur.analysis_model,
      data.embedding_base_url ?? cur.embedding_base_url,
      keepSecretValue(data.embedding_api_key, cur.embedding_api_key),
      data.embedding_model ?? cur.embedding_model,
      data.note ?? cur.note,
      now,
      Number(data.id),
      DEFAULT_USER_ID
    );
    if (cur.is_default === 1) applyProfile(Number(data.id), true);
    return Number(data.id);
  }
  const maxOrder = Number(
    Object.values(
      dbGet<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM model_profiles WHERE user_id = ?', DEFAULT_USER_ID) || {}
    )[0] || 0
  );
  const { lastInsertRowid } = dbRun(
    `INSERT INTO model_profiles (user_id, label, base_url, api_key, chat_model, analysis_model,
       embedding_base_url, embedding_api_key, embedding_model, note, is_default, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    DEFAULT_USER_ID,
    data.label,
    data.base_url,
    keepSecretValue(data.api_key, ''),
    data.chat_model,
    data.analysis_model || data.chat_model,
    data.embedding_base_url || '',
    keepSecretValue(data.embedding_api_key, ''),
    data.embedding_model || '',
    data.note || null,
    maxOrder + 1,
    now,
    now
  );
  return lastInsertRowid;
}

/** 把当前设置里正在用的配置存成一个新档案 */
export function saveCurrentAsProfile(label: string, note?: string): number {
  return upsertProfile({
    label,
    base_url: (getSetting('llm_base_url') || process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
    api_key: getSetting('llm_api_key') || process.env.LLM_API_KEY || '',
    chat_model: getSetting('llm_model') || process.env.LLM_MODEL || '',
    analysis_model: getSetting('llm_analysis_model') || process.env.LLM_ANALYSIS_MODEL || '',
    embedding_base_url: getSetting('embedding_base_url') || '',
    embedding_api_key: getSetting('embedding_api_key') || '',
    embedding_model: getSetting('embedding_model') || '',
    note: note || '从当前设置保存',
  });
}

export function deleteProfile(id: number): boolean {
  const p = getProfile(id);
  if (!p) return false;
  dbRun('DELETE FROM model_profiles WHERE id = ? AND user_id = ?', id, DEFAULT_USER_ID);
  // 删掉的如果是当前默认，自动切到下一个
  if (p.is_default === 1) {
    const next = listProfiles()[0];
    if (next) applyProfile(next.id, true);
  }
  return true;
}

/** 调整备用顺序（dir = -1 上移 / 1 下移） */
export function moveProfile(id: number, dir: -1 | 1): void {
  const list = listProfiles().filter((p) => p.is_default === 0);
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return;
  const swap = idx + dir;
  if (swap < 0 || swap >= list.length) return;
  tx(() => {
    dbRun('UPDATE model_profiles SET sort_order = ? WHERE id = ?', list[swap]!.sort_order, list[idx]!.id);
    dbRun('UPDATE model_profiles SET sort_order = ? WHERE id = ?', list[idx]!.sort_order, list[swap]!.id);
  });
}

export function activeProfile(): ModelProfile | null {
  const row = dbGet<ModelProfile>(
    'SELECT * FROM model_profiles WHERE user_id = ? AND is_default = 1 LIMIT 1',
    DEFAULT_USER_ID
  );
  return row || null;
}

/* ------------------------------------------------------------------ */
/* 测试目标解析（纯函数，设置页"测试连接"用）                            */
/* ------------------------------------------------------------------ */
export interface TestTargetSpec {
  baseUrl: string;
  apiKey: string;
  model: string;
  label: string;
}

/**
 * 校验并组装"测试连接"的目标（不发请求，便于单测）。
 * 安全要点：
 *  - 地址必须是合法的 http(s) URL，否则返回错误；
 *  - 当调用方提供了自定 baseUrl 却没有提供 apiKey 时，**绝不**回落服务端保存的 Key
 *    （否则可被构造请求把真实 Key 发往任意地址）；只有未提供 baseUrl（= 测试当前配置）
 *    时才允许回落。
 * 说明：不封禁私有网段——用户自己的内网 GPU 服务器就是合法测试目标。
 */
export function resolveTestTarget(
  input: { baseUrl?: unknown; apiKey?: unknown; model?: unknown; label?: unknown },
  fallback: { baseUrl: string; apiKey: string; model: string }
): { ok: true; target: TestTargetSpec } | { ok: false; error: string } {
  const ownBase = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const hasOwnBase = ownBase !== '';
  const baseUrl = (hasOwnBase ? ownBase : String(fallback.baseUrl || '')).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, error: '接口地址必须以 http:// 或 https:// 开头' };
  }
  try {
    new URL(baseUrl);
  } catch {
    return { ok: false, error: '接口地址格式不合法' };
  }
  const providedKey = typeof input.apiKey === 'string' ? input.apiKey : '';
  const apiKey = hasOwnBase ? providedKey : providedKey || String(fallback.apiKey || '');
  const ownModel = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : '';
  const model = ownModel || String(fallback.model || '');
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim() : '当前配置';
  return { ok: true, target: { baseUrl, apiKey, model, label } };
}

/* ------------------------------------------------------------------ */
/* 备用链健康度：某个模型失败后进冷却，自动切下一个                      */
/* ------------------------------------------------------------------ */
interface Health {
  fails: number;
  cooldownUntil: number;
  lastError: string | null;
  lastFailAt: string | null;
  lastOkAt: string | null;
  lastMs: number;
}

declare global {
   
  var __gfModelHealth: Map<string, Health> | undefined;
}

function healthMap(): Map<string, Health> {
  if (!globalThis.__gfModelHealth) globalThis.__gfModelHealth = new Map();
  return globalThis.__gfModelHealth;
}

export function healthOf(key: string): Health {
  const map = healthMap();
  if (!map.has(key)) {
    map.set(key, { fails: 0, cooldownUntil: 0, lastError: null, lastFailAt: null, lastOkAt: null, lastMs: 0 });
  }
  return map.get(key)!;
}

export function markModelFailure(key: string, err: string, ms: number): void {
  const h = healthOf(key);
  h.fails += 1;
  h.lastError = err.slice(0, 200);
  h.lastFailAt = nowIso();
  h.lastMs = ms;
  const cooldown = Math.min(600, 45 * Math.pow(2, Math.min(h.fails - 1, 4))); // 45s → 最长 10 分钟
  h.cooldownUntil = Date.now() + cooldown * 1000;
}

export function markModelSuccess(key: string, ms: number): void {
  const h = healthOf(key);
  h.fails = 0;
  h.cooldownUntil = 0;
  h.lastError = null;
  h.lastOkAt = nowIso();
  h.lastMs = ms;
}

export function isCooling(key: string): boolean {
  return healthOf(key).cooldownUntil > Date.now();
}

export function healthSnapshot(): Record<string, Health & { cooling: boolean; cooldownLeftSec: number }> {
  const out: Record<string, Health & { cooling: boolean; cooldownLeftSec: number }> = {};
  for (const [k, v] of healthMap()) {
    out[k] = { ...v, cooling: v.cooldownUntil > Date.now(), cooldownLeftSec: Math.max(0, Math.round((v.cooldownUntil - Date.now()) / 1000)) };
  }
  return out;
}