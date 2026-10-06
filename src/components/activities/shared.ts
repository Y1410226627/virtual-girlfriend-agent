// 「活动（线上 / 线下）」共享类型与展示小工具。
//
// 重要：本文件是【纯前端】模块——绝不能 import 任何含 db / node:sqlite 的服务端模块，
// 否则会把活动引擎（间接依赖数据库）打进浏览器包。因此这里的枚举/标签一律就地定义。
import type { GroupMessage } from '@/components/groups/shared';

export type { GroupMessage };

/** activities 行（服务端原样返回；UI 只读展示） */
export interface ActivityRowView {
  id: number;
  user_id: number;
  group_id: number | null;
  /** online | offline */
  kind: string;
  template_key: string | null;
  title: string;
  scene: string;
  scheduled_at: string | null;
  location: string | null;
  /** planned | ongoing | ended | cancelled */
  status: string;
  focus_companion_id: number | null;
  summary: string | null;
  meta_json: string | null;
  created_at: string;
  updated_at: string;
}

/** 活动列表项（GET /api/activities） */
export interface ActivitySummaryView {
  id: number;
  group_id: number | null;
  kind: string;
  template_key: string | null;
  title: string;
  scene: string;
  status: string;
  scheduled_at: string | null;
  location: string | null;
  focus_companion_id: number | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  participantIds: number[];
  participantNames: string[];
  scheduleCount: number;
}

/** activity_schedule_items 行（线下约会日程） */
export interface ActivityScheduleItem {
  id: number;
  activity_id: number;
  seq: number;
  title: string;
  /** pending | current | done */
  status: string;
  note: string | null;
  created_at: string;
}

export interface ActivityParticipantLite {
  id: number;
  name: string;
  identity: string | null;
  age: number;
}

/** GET /api/activities/[id] 响应 */
export interface ActivityDetailData {
  ok?: boolean;
  activity: ActivityRowView;
  participantIds: number[];
  participants: ActivityParticipantLite[];
  schedule: ActivityScheduleItem[];
  groupId: number | null;
  messages: GroupMessage[];
}

export const ACTIVITY_STATUS_LABEL: Record<string, string> = {
  planned: '待开始',
  ongoing: '进行中',
  ended: '已结束',
  cancelled: '已取消',
};

export function activityStatusLabel(status: string | null | undefined): string {
  return (status && ACTIVITY_STATUS_LABEL[status]) || status || '—';
}

export const ACTIVITY_KIND_LABEL: Record<string, string> = { online: '线上', offline: '线下' };

export const ACTIVITY_KIND_ICON: Record<string, string> = { online: '💻', offline: '🌿' };

/** 线上活动模板（与 src/lib/activity.ts 的 ACTIVITY_TEMPLATES 保持一致的展示名） */
export const ACTIVITY_TEMPLATE_LABELS: Record<string, string> = {
  movie: '一起看电影',
  game: '一起打游戏',
  nighttalk: '深夜卧谈',
  co_listen: '一起听歌',
};

export function templateLabel(key: string | null | undefined): string {
  return (key && ACTIVITY_TEMPLATE_LABELS[key]) || '';
}

export const SCHEDULE_STATUS_LABEL: Record<string, string> = {
  pending: '待办',
  current: '进行中',
  done: '已完成',
};
