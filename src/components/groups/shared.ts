// 「群聊」共享类型与小工具

export interface GroupSummary {
  id: number;
  name: string;
  topic: string | null;
  status: string;
  last_message_at: string | null;
  created_at: string;
  memberIds: number[];
  memberNames: string[];
  lastMessageId: number;
}

export interface GroupMemberLite {
  id: number;
  name: string;
  avatar_url: string | null;
  identity: string | null;
  age: number;
  /** 关系状态（认识以上即可入群；缺省不显示状态标签） */
  status?: string;
}

export interface GroupMessage {
  id: number;
  group_id: number;
  companion_id: number | null;
  speaker_type: string; // user | companion | system | reaction
  speaker_name: string | null;
  content: string;
  reaction: string | null;
  round: number;
  meta: string | null;
  created_at: string;
}

export interface GroupRunView {
  id: number;
  group_id: number;
  status: string; // running | ended | cancelled
  round: number;
  max_rounds: number;
  last_speaker_id: number | null;
  ended_reason: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface GroupDetailData {
  ok?: boolean;
  group: {
    id: number;
    name: string;
    topic: string | null;
    status: string;
    last_message_at: string | null;
    created_at: string;
    /** 群的来历：'manual' | 'presence'（线下共处，可结束并写共处记忆）| 'activity'；旧数据可能没有 */
    origin?: string | null;
  };
  memberIds: number[];
  members: GroupMemberLite[];
  messages: GroupMessage[];
  run: GroupRunView | null;
}

/** 每位角色的「专属色」：按 companion id 稳定映射到调色板 */
const PALETTE = ['#F65C8A', '#FF8F6B', '#7BA7FF', '#5FBF9F', '#B58CFF', '#E8A93E', '#4FB3D9', '#E06C9F'];

export function colorOf(id: number | null | undefined): string {
  const n = Math.abs(Math.trunc(Number(id) || 0));
  return PALETTE[n % PALETTE.length] ?? PALETTE[0]!;
}

/** 状态标签 */
export const RUN_STATUS_LABEL: Record<string, string> = {
  running: '进行中',
  ended: '已结束',
  cancelled: '已停止',
};

export function runStatusLabel(status: string | null | undefined): string {
  return (status && RUN_STATUS_LABEL[status]) || '—';
}
