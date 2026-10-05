// 「记忆」页各卡片共享的类型与小工具

export const TYPES = [
  { key: '', label: '全部' },
  { key: 'semantic', label: '事实' },
  { key: 'episodic', label: '事件' },
  { key: 'emotional', label: '情绪' },
  { key: 'relationship', label: '关系' },
  { key: 'attachment', label: '依恋' },
];

export interface ScatterPoint {
  id: number;
  content?: string;
  importance?: number | string;
  access_count?: number | string;
}

export interface AccessedMemory {
  id: number;
  content?: string;
  access_count?: number | string;
}

export interface ImportanceBucket {
  label: string;
  count: number | string;
}

export interface MemoryStats {
  scatter?: ScatterPoint[];
  topAccessed?: AccessedMemory[];
  importanceBuckets?: ImportanceBucket[];
  counts?: { active?: number; archived?: number; superseded?: number };
  total?: number;
  archived?: number;
  byType?: { type: string; label: string; count: number }[];
}

export interface MemoryItem {
  id: number;
  type: string;
  content: string;
  importance: number;
  emotion?: string | null;
  created_at: string;
  access_count?: number;
}

export interface DailySummary {
  id: number;
  date: string;
  summary: string;
  meta?: string | null;
}

export interface MemoriesData {
  memories?: MemoryItem[];
  summaries?: DailySummary[];
  stats?: MemoryStats;
}

export interface SummaryMeta {
  messages?: number;
}

/** 新增记忆的表单状态 */
export interface NewMem {
  type: string;
  content: string;
  importance: number;
  emotion: string;
}

/** 安全解析 meta（脏数据不让页面白屏） */
export function safeParseMeta(raw: string | null | undefined): SummaryMeta {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** 重要度钳制到 0~10 */
export function clampImportance(v: number): number {
  const n = Number(v);
  return Math.max(0, Math.min(10, Number.isFinite(n) ? n : 7));
}