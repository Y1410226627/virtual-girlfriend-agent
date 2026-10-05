/* 聊天主页（src/app/page.tsx）拆出的公共类型与纯小工具（原样搬移） */

export interface Msg {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  emotion?: string | null;
  is_proactive?: number;
  created_at: string;
  streaming?: boolean;
}

export interface OngoingEvent {
  // 服务端（/api/state、/api/life）在有进行中事件时总会带上 id，故这里收紧为必填，
  // 避免 id 可选导致的 undefined / null 语义混淆（无事件时整体为 null）。
  id: number;
  activity?: string;
  eventType?: string;
  startedAt?: string;
  expectedEnd?: string | null;
  mode?: string;
}

export interface LifeState {
  activity?: string;
  activityType?: string;
  location?: string;
  energy: number;
  hunger?: number;
  emotion?: string;
  illness?: string;
  atHome?: boolean;
  ongoingEvent?: OngoingEvent | null;
}

export interface RelationshipState {
  mood?: string;
  stageName?: string;
  intimacy?: number;
  scene?: string;
  sceneMode?: string;
  conflict_state?: string;
  pending_relationship_talk?: boolean;
  pending_stage_confirm?: boolean;
  sceneReason?: string;
}

export interface Sticker {
  id: string;
  emoji?: string;
  caption?: string;
  meaning?: string;
}

export interface AppState {
  life?: LifeState | null;
  persona?: { agent_name?: string } | null;
  relationship?: RelationshipState | null;
  intimacy?: { inAftercare?: boolean } | null;
  settings?: { user_name?: string } | null;
  stickers?: Sticker[];
  ttsEnabled?: boolean;
}

export interface ChatEvent {
  type?: string;
  text?: string;
  message?: string;
  userMessageId?: number;
  assistantMessageId?: number;
  // 接口冻结：done 事件新增字段（服务端落库后已自行入队分析）
  turnId?: number;
  generationId?: number;
  analysisJobId?: number;
  /** 分析入队时刻（epoch ms）：前端用它判断"本轮分析是否已结束" */
  analysisStartedAt?: number;
}

export interface ChatRequest {
  content?: string;
  regenerate?: boolean;
}

/* 当前事件剩余时间文案（原 page.tsx 内的局部小工具） */
export function remainText(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms)) return '';
  if (ms <= 0) return '即将结束';
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `还有约 ${m} 分钟`;
  return `还有约 ${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
}