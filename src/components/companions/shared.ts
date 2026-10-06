// 「通讯录 / 资料页」共享类型与小工具

export interface RosterEntry {
  id: number;
  name: string;
  displayName: string;
  age: number;
  gender: string;
  identity: string | null;
  personality_tags: string[];
  portrait_desc: string | null;
  avatar_url: string | null;
  intro: string | null;
  status: string;
  statusLabel: string;
  attraction: number;
  is_primary: number;
  is_discovered: number;
  pending: number;
  pursue_opt_in: number;
  reject_count: number;
  cooldown_until: string | null;
  established_at: string | null;
  closed_at: string | null;
  last_active_at: string | null;
  updated_at: string;
  unread: number;
  isPendingCandidate: boolean;
}

export interface RosterView {
  primary: RosterEntry | null;
  girlfriends: RosterEntry[];
  pursuing: RosterEntry[];
  acquaintances: RosterEntry[];
  pending: RosterEntry[];
  closed: RosterEntry[];
}

export interface PursuitRequirement {
  key: string;
  label: string;
  current: number;
  target: number;
  met: boolean;
}

export interface PursuitProgressData {
  status: string;
  label: string;
  next: string | null;
  attraction: number;
  intimacy: number;
  trust: number;
  conflict_state: string;
  cooldown_until: string | null;
  in_cooldown: boolean;
  reject_count: number;
  pursue_opt_in: number;
  requirements: PursuitRequirement[];
}

export interface CompanionProfileData {
  /** 原始 companions 行（服务端聚合返回；展示统一走 roster） */
  companion: Record<string, unknown> | null;
  roster: RosterEntry | null;
  persona: { agent_name: string | null; age: string | null; occupation: string | null; self_story: string | null } | null;
  relationship: {
    intimacy: number;
    trust: number;
    mood: string;
    stage: number;
    stageName: string;
    conflict_state: string;
    emotional_balance: number;
    last_interaction_at: string | null;
  } | null;
  pursuit: PursuitProgressData | null;
  events: Array<{ id: number; kind: string; summary: string; created_at: string }>;
  relations: RelationEdge[];
}

export interface RelationEdge {
  id: number;
  a_id: number;
  b_id: number;
  value: number;
  state: string;
  last_event_at: string | null;
  updated_at: string;
  a_name: string | null;
  b_name: string | null;
}

/** 状态 → 中文标签（兜底用；服务端已给 statusLabel） */
export const STATUS_LABEL: Record<string, string> = {
  stranger: '陌生人',
  acquaintance: '认识',
  ambiguous: '暧昧',
  pursuing: '追求中',
  girlfriend: '女友',
  cold: '冷淡',
  rejected: '被拒',
  closed: '已关闭',
};

export function statusLabelOf(status: string, fallback?: string): string {
  return fallback || STATUS_LABEL[status] || status;
}

/** 状态 → 主题色 tone（用于 Chip） */
export const STATUS_TONE: Record<string, string> = {
  girlfriend: 'rose',
  pursuing: 'peach',
  ambiguous: 'peach',
  acquaintance: 'plain',
  stranger: 'plain',
  cold: 'plain',
  rejected: 'plain',
  closed: 'plain',
};

export function relationStateLabel(state: string): string {
  return (
    { ally: '盟友', friendly: '友好', neutral: '中立', rival: '竞争', jealous: '吃醋' }[state] ?? state
  );
}
