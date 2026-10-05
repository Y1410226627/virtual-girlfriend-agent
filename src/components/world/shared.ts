// 「她的世界」页各卡片共享的类型与小工具

export const emoMap: Record<string, string> = {
  开心: '😊', 平静: '🙂', 低落: '😔', 烦躁: '😤', 想他: '🥺', 难受: '🤒', 疲惫: '😪', '': '🙂',
};

const ATTACHMENT_LABELS: Record<string, string> = {
  secure: '安全型', anxious: '焦虑型', avoidant: '回避型', fearful: '混乱型',
};

/** 时间线来源字段 → 展示前缀 */
const TIMELINE_PREFIX: Record<string, string> = {
  illness: '身体：', activity: '活动：', event: '事件：', manual: '手动：',
};

export interface HealthState {
  energy: number;
  sleepQuality: number;
  hunger: number;
  exercise: number;
  cycleEnabled?: boolean;
  cycleDay: number;
  illness: string;
  illnessDay?: number;
}

export interface PsychologyState {
  baseEmotion: string;
  stress: number;
  loneliness: number;
  missingUser: number;
  security: number;
  selfWorth: number;
  mentalEnergy: number;
}

export interface CastMember {
  name?: string;
  role?: string;
  note?: string;
}

export interface TimelineRow {
  field?: string;
  new_value?: unknown;
  old_value?: unknown;
  reason?: string;
  created_at?: string;
}

export interface LifeEvent {
  id: number;
  event_type: string;
  content: string;
  created_at: string;
}

export interface WeeklySnapshot {
  week: string;
  state_json: string;
}

export interface ProfileField {
  field: string;
  label: string;
  value?: string;
  revealed?: boolean;
}

export interface SharedEntry {
  content?: string;
  title?: string;
  status?: string;
  created_at?: string;
}

export interface LifeData {
  health: HealthState;
  psychology: PsychologyState;
  location: { name: string };
  activity: { name: string; expectedEnd?: string };
  recently?: string[];
  lifeArc?: { title: string; description?: string; day: number; plannedDays?: number };
  cast?: CastMember[];
  timeline?: TimelineRow[];
  events?: LifeEvent[];
  weeklySnapshots?: WeeklySnapshot[];
  profile: { revealedCount: number; fields: ProfileField[] };
  shared: { plans?: SharedEntry[]; rituals?: SharedEntry[]; places?: SharedEntry[]; items?: SharedEntry[] };
}

/** 操作提交入口（page.tsx 的 post） */
export type PostFn = (body: Record<string, unknown>, msg?: string) => Promise<unknown>;

export function timelineText(l: TimelineRow): string {
  if (l.field === 'daily_event') return String(l.new_value ?? '');
  if (l.field === 'profile_reveal') return `揭开：${l.old_value || l.new_value || ''}`;
  const prefix = l.field ? TIMELINE_PREFIX[l.field] : undefined;
  return prefix ? `${prefix}${l.new_value ?? ''}` : String(l.new_value ?? '');
}

export function weeklySnapshotSummary(raw: string): string {
  try {
    const state = JSON.parse(raw);
    const stage = ['初识', '试探', '加深', '融合', '承诺'][Number(state.relationship?.stage) || 0] || '初识';
    const energy = Math.round(Number(state.health?.energy) || 0);
    const place = state.location?.current_location || '位置未知';
    const style = state.attachment?.style;
    const attachment = style ? (ATTACHMENT_LABELS[style] || style) : '未记录';
    return `${stage}期 · 精力 ${energy} · ${place} · ${attachment}依恋`;
  } catch {
    return '状态快照';
  }
}