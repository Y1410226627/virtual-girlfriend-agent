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
}

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

/** 保存表单字段（page.tsx 的 save） */
export type SaveFn = (keys?: string[], msg?: string) => Promise<void>;