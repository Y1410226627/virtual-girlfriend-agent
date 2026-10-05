// 「关系」页各卡片共享的类型与小工具

/** 会写回表单的 action，成功后允许服务器值回填 */
export const FORM_ACTIONS = ['set_nickname', 'set_anniversary', 'set_persona', 'set_user'];

export type Tab = 'bank' | 'conflicts' | 'logs' | 'events' | 'memories';

export interface Stage {
  id: number;
  name: string;
  en: string;
  min: number;
  max: number;
}

export interface RelationshipInfo {
  nickname?: string;
  anniversary?: string;
  stage?: number;
  stageName?: string;
  stageCore?: string;
  daysInStage?: number;
  stageMax: number;
  stageMin: number;
  intimacy: number;
  trust?: number;
  capSinceDays?: number | null;
  dwellDays?: number;
  pending_stage_confirm?: boolean;
  emotional_balance?: number;
  repair_credit?: number;
  unresolved_tension?: number;
  mood?: string;
}

export interface Persona {
  agent_name?: string;
  age?: string | number;
  occupation?: string;
  self_story?: string;
}

export interface UserInfo {
  name?: string;
  profile?: string;
}

export interface BankEntry {
  id: number;
  behavior: string;
  reason: string;
  delta: number;
  balance_after: number;
}

export interface Conflict {
  id: number;
  type: string;
  status: string;
  repair_quality?: string | null;
  started_at: string;
  description: string;
  tension_at_start: number;
  tension_after?: number | null;
}

export interface RelLog {
  id: number;
  summary: string;
  created_at: string;
  reason?: string;
}

export interface CalEvent {
  id: number;
  title: string;
  repeat_yearly?: boolean;
  event_date: string;
  kind: string;
}

export interface RelMemory {
  id: number;
  type: string;
  created_at: string;
  content: string;
}

export interface ReviewSummary {
  id: number;
  date: string;
  summary: string;
}

export interface RelationshipData {
  relationship?: RelationshipInfo;
  persona?: Persona;
  user?: UserInfo;
  stages?: Stage[];
  conflicts?: Conflict[];
  bank?: { stats?: { deposits?: number; withdrawals?: number }; recent?: BankEntry[] };
  logs?: RelLog[];
  events?: CalEvent[];
  memories?: RelMemory[];
  summaries?: ReviewSummary[];
}

export interface Edits {
  nickname?: string;
  anniversary?: string;
  agent_name?: string;
  age?: string | number;
  occupation?: string;
  self_story?: string;
  user_name?: string;
  user_profile?: string;
}

/** 新增纪念日 / 约会的表单状态 */
export interface NewEvent {
  title: string;
  event_date: string;
  kind: string;
  repeat_yearly: boolean;
}

export type PostBody = { action: string } & Record<string, unknown>;

/** 操作提交入口（page.tsx 的 post） */
export type PostFn = (body: PostBody, msg?: string) => Promise<void>;