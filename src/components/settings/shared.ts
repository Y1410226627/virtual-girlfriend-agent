// 设置页各卡片共享的类型与小工具

export interface ProfileView {
  id: number;
  label: string;
  base_url: string;
  api_key: string;
  chat_model: string;
  analysis_model: string | null;
  note: string | null;
  is_default: number;
}

export interface ProfileForm {
  label: string;
  base_url: string;
  api_key: string;
  chat_model: string;
  analysis_model: string | null;
  note: string | null;
}

export interface ProfileTestResult {
  pending?: boolean;
  ok?: boolean;
  ms?: number;
  reply?: string;
  error?: string;
}

/** /api/settings POST 的通用返回体（档案增删改查、重算向量等） */
export interface ProfilePostResult {
  ok?: boolean;
  error?: string;
  message: string;
  count?: number;
  result?: ProfileTestResult;
}

export interface CustomValues {
  intimacy: number | string;
  trust: number | string;
  emotional_balance: number | string;
  unresolved_tension: number | string;
  repair_credit: number | string;
  mood: number | string;
  stage: number | string;
  personality: Record<string, number | string>;
  anxiety: number | string;
  avoidance: number | string;
  libido: number | string;
  intimacy_need: number | string;
  sexual_satisfaction: number | string;
  sexual_stress: number | string;
}

export interface PingResult {
  database?: { ok?: boolean; error?: string };
  llm?: { ok?: boolean; ms?: number; reply?: string; error?: string };
  embedding?: { ok?: boolean; mode?: string; dim?: number; error?: string };
  state?: { ok?: boolean; stage?: number; messages?: number; scene?: string; sceneMode?: string; error?: string };
}

export interface UsageInfo {
  chat?: number;
  analysis?: number;
  embedding?: number;
  lastFallback?: { label: string; at: number } | null;
}

export interface HealthInfo {
  cooling: boolean;
  cooldownLeftSec: number;
}

export interface EffectiveInfo {
  baseUrl: string;
  model: string;
  analysisModel: string;
  embeddingModel: string;
  embeddingBaseUrl: string;
  hasKey: boolean;
  keyFromEnv: boolean;
  baseUrlFromEnv: boolean;
  embeddingMode: string;
  analysisThinking: string | boolean;
  activeProfile: string | null;
  lastUsed: { model: string; fallback?: boolean } | null;
  /** 已保存的聊天 Key 归属的 host（P0-13，用于"改了 URL 未重输 Key"提示） */
  keyHost?: string;
  /** 已保存的向量 Key 归属的 host */
  embeddingKeyHost?: string;
}

/** 显式"清除已保存的 Key、改用环境变量"的哨兵值（与后端 CLEAR_TOKEN 对齐） */
export const CLEAR_KEY_TOKEN = '__clear__';

export interface SettingsResponse {
  settings: Record<string, string>;
  persona?: { agent_name?: string | null; self_story?: string | null } | null;
  effective?: EffectiveInfo;
  profiles?: ProfileView[];
  usage?: UsageInfo;
  health?: Record<string, HealthInfo>;
}

/** 轻提示 setter */
export type SetToast = (text: string | null) => void;

/** 字段写入（page.tsx 的 set） */
export type SetFieldFn = (k: string, v: string) => void;

/** 保存表单字段（page.tsx 的 save）：返回是否成功；overrides 用于提交"目标值"而非 state 旧值 */
export type SaveFn = (
  keys: string[],
  msg?: string,
  overrides?: Record<string, string>
) => Promise<boolean>;

/**
 * 组装"自定义数值"提交体：空字符串 / 空白 = 未填写 → 不提交（避免后端 Number('')=0 归零）。
 * 只提交本次真正填写过的字段。
 */
export function buildCustomValues(cv: CustomValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const num = (x: number | string): number | undefined => {
    if (typeof x === 'number') return Number.isFinite(x) ? x : undefined;
    const s = String(x).trim();
    if (!s) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };
  const NUM_KEYS = [
    'intimacy',
    'trust',
    'emotional_balance',
    'unresolved_tension',
    'repair_credit',
    'stage',
    'anxiety',
    'avoidance',
    'libido',
    'intimacy_need',
    'sexual_satisfaction',
    'sexual_stress',
  ] as const;
  for (const k of NUM_KEYS) {
    const n = num(cv[k]);
    if (n !== undefined) out[k] = n;
  }
  if (typeof cv.mood === 'string' && cv.mood.trim()) out.mood = cv.mood.trim();
  const p: Record<string, number> = {};
  for (const [k, v] of Object.entries(cv.personality || {})) {
    const n = num(v);
    if (n !== undefined) p[k] = n;
  }
  if (Object.keys(p).length) out.personality = p;
  return out;
}