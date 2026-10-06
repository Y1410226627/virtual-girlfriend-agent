// group_runs 生命周期与调度状态读写 + 独立于会话锁的「群锁」。
//
// 设计要点（对齐架构 §3.8「并发与一致性」）：
// - 群表（groups / group_members / group_messages / group_runs）是【全局表】，跨伴侣共享，
//   **不按 companion 隔离** → 一律用 dbAll/dbGet/dbRun，绝不套 cAll/cGet/cRun（会错位注入 companion_id）。
// - withGroupLock(groupId, fn)：一个独立于伴侣会话锁的全局 Map，key 前缀 'g:'，
//   与伴侣会话锁 key 空间隔离，避免"群聊串行锁与私聊串行锁互相污染"。
// - **叶子锁原则**：群聊运行【只持群锁】；它对某伴侣数据（关系/好感）的写入走可重入的数据库事务 tx()，
//   **绝不**去获取该伴侣的会话锁（否则与私聊请求互等 → 死锁）。
// - 调度状态（recent_speakers / spoke_counts / round / last_speaker_id）集中在此读写，供 group.ts 的
//   planSpeakers 与禁三连击判定使用。
import { dbAll, dbGet, dbRun } from './db';
import { nowIso, safeJson } from './utils';
import type { GroupRunRow } from './types';

/** 一次群聊 run 的轮数上限（默认值；可由创建时 max_rounds 覆盖）。 */
export const GROUP_MAX_ROUNDS = 12;

/** recent_speakers 数组的最大保留长度（轮转/禁三连击只需近期若干条）。 */
export const RECENT_SPEAKERS_CAP = 20;

/* ------------------------------------------------------------------ */
/* 群锁（独立于会话锁的全局 Promise 链）                                 */
/* ------------------------------------------------------------------ */
interface GroupLockStore {
  chains: Map<string, Promise<unknown>>;
}

declare global {
  var __gfGroupLocks: GroupLockStore | undefined;
}

function lockStore(): GroupLockStore {
  if (!globalThis.__gfGroupLocks) globalThis.__gfGroupLocks = { chains: new Map() };
  return globalThis.__gfGroupLocks;
}

/** 群锁 key：前缀 'g:' + groupId，与伴侣会话锁的纯数字 key 空间隔离。 */
export function groupLockKey(groupId: number): string {
  const n = Math.trunc(Number(groupId));
  return `g:${Number.isFinite(n) ? n : 0}`;
}

/**
 * 按 groupId 串行执行（同一群的请求排队依次执行，不是拒绝）。
 * 用 globalThis 保存 Promise 链，避免开发模式 HMR 重建模块时丢锁。
 * 前序任务成功或失败都会继续下一棒（锁只保证顺序，不传播上一棒的异常）。
 */
export function withGroupLock<T>(groupId: number, fn: () => Promise<T>): Promise<T> {
  const store = lockStore();
  const key = groupLockKey(groupId);
  const prev = store.chains.get(key) ?? Promise.resolve();
  const run = prev.then(
    () => fn(),
    () => fn()
  );
  // 链尾必须吞掉异常，否则后续 await 会被上一棒的失败中断
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  store.chains.set(key, tail);
  void tail.then(() => {
    // 只在仍是队尾时清理，避免误删后来者的链
    if (store.chains.get(key) === tail) store.chains.delete(key);
  });
  return run;
}

/** 该群当前是否有请求在运行或排队（诊断/测试用）。 */
export function groupBusy(groupId: number): boolean {
  return lockStore().chains.has(groupLockKey(groupId));
}

/* ------------------------------------------------------------------ */
/* run 读写                                                            */
/* ------------------------------------------------------------------ */
function asPositiveInt(v: unknown): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function getRunById(runId: number): GroupRunRow | null {
  const id = asPositiveInt(runId);
  if (!id) return null;
  return dbGet<GroupRunRow>('SELECT * FROM group_runs WHERE id = ?', id) ?? null;
}

/** 当前进行中的 run（status='running'，取最新一条） */
export function getCurrentRun(groupId: number): GroupRunRow | null {
  const gid = asPositiveInt(groupId);
  if (!gid) return null;
  return (
    dbGet<GroupRunRow>(
      "SELECT * FROM group_runs WHERE group_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1",
      gid
    ) ?? null
  );
}

/** 该群最近一条 run（不论状态），用于判断"上一轮是否已结束/已取消" */
export function getLastRun(groupId: number): GroupRunRow | null {
  const gid = asPositiveInt(groupId);
  if (!gid) return null;
  return dbGet<GroupRunRow>('SELECT * FROM group_runs WHERE group_id = ? ORDER BY id DESC LIMIT 1', gid) ?? null;
}

export interface CreateRunOptions {
  kind?: string;
  activityId?: number | null;
  maxRounds?: number;
  now?: string;
}

/** 新建一个 running 的 run（round=0、recent_speakers=[]、spoke_counts={}） */
export function createRun(groupId: number, opts: CreateRunOptions = {}): GroupRunRow {
  const gid = asPositiveInt(groupId);
  if (!gid) throw new Error('GROUP_NOT_FOUND');
  const maxRounds = asPositiveInt(opts.maxRounds) || GROUP_MAX_ROUNDS;
  const now = opts.now ?? nowIso();
  const res = dbRun(
    `INSERT INTO group_runs
       (group_id, kind, activity_id, status, round, max_rounds, last_speaker_id, recent_speakers, spoke_counts, started_at)
     VALUES (?, ?, ?, 'running', 0, ?, NULL, '[]', '{}', ?)`,
    gid,
    opts.kind ? String(opts.kind).slice(0, 24) : 'chat',
    opts.activityId == null ? null : asPositiveInt(opts.activityId),
    maxRounds,
    now
  );
  const row = getRunById(res.lastInsertRowid);
  if (!row) throw new Error('GROUP_RUN_CREATE_FAILED');
  return row;
}

/** 取当前 running 的 run，没有则新建 */
export function getOrCreateRun(groupId: number, opts: CreateRunOptions = {}): GroupRunRow {
  return getCurrentRun(groupId) ?? createRun(groupId, opts);
}

/* ------------------------------------------------------------------ */
/* 调度状态读写                                                        */
/* ------------------------------------------------------------------ */
/** 解析 recent_speakers（近 N 位发言者，最旧在前、最新在后） */
export function readRecentSpeakers(run: GroupRunRow | null): number[] {
  const arr = safeJson<unknown>(run?.recent_speakers ?? null, []);
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => Math.trunc(Number(x)))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(-RECENT_SPEAKERS_CAP);
}

/** 解析 spoke_counts（{ companionId: 本 run 发言次数 }） */
export function readSpokeCounts(run: GroupRunRow | null): Record<number, number> {
  const obj = safeJson<Record<string, unknown>>(run?.spoke_counts ?? null, {});
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    const id = Math.trunc(Number(k));
    const n = Number(v);
    if (Number.isFinite(id) && id > 0 && Number.isFinite(n) && n >= 0) out[id] = n;
  }
  return out;
}

/** 本 run 已产生的 AI 发言总数（= spoke_counts 求和），用于 run 级调用上限判定 */
export function totalSpokeCount(run: GroupRunRow | null): number {
  const counts = readSpokeCounts(run);
  return Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
}

export interface SchedulingPatch {
  round?: number;
  lastSpeakerId?: number | null;
  recentSpeakers?: number[];
  spokeCounts?: Record<number, number>;
}

/** 更新 run 的调度状态（只更新显式给出的字段） */
export function updateScheduling(runId: number, patch: SchedulingPatch): void {
  const id = asPositiveInt(runId);
  if (!id) return;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.round !== undefined) {
    sets.push('round = ?');
    params.push(Math.max(0, Math.trunc(Number(patch.round)) || 0));
  }
  if (patch.lastSpeakerId !== undefined) {
    sets.push('last_speaker_id = ?');
    params.push(patch.lastSpeakerId == null ? null : asPositiveInt(patch.lastSpeakerId) || null);
  }
  if (patch.recentSpeakers !== undefined) {
    const capped = patch.recentSpeakers
      .map((x) => Math.trunc(Number(x)))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(-RECENT_SPEAKERS_CAP);
    sets.push('recent_speakers = ?');
    params.push(JSON.stringify(capped));
  }
  if (patch.spokeCounts !== undefined) {
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(patch.spokeCounts)) {
      const key = Math.trunc(Number(k));
      const n = Number(v);
      if (Number.isFinite(key) && key > 0 && Number.isFinite(n) && n >= 0) clean[String(key)] = n;
    }
    sets.push('spoke_counts = ?');
    params.push(JSON.stringify(clean));
  }
  if (!sets.length) return;
  params.push(id);
  dbRun(`UPDATE group_runs SET ${sets.join(', ')} WHERE id = ?`, ...params);
}

/** 自然结束一个 run（轮数上限 / 命中收尾词 / 调用上限） */
export function endRun(runId: number, reason: string, now: string = nowIso()): void {
  const id = asPositiveInt(runId);
  if (!id) return;
  dbRun("UPDATE group_runs SET status = 'ended', ended_reason = ?, ended_at = ? WHERE id = ?", String(reason || 'ended').slice(0, 60), now, id);
}

/** 中止一个 run（用户点「停止」） */
export function cancelRun(runId: number, reason = 'cancelled', now: string = nowIso()): void {
  const id = asPositiveInt(runId);
  if (!id) return;
  dbRun(
    "UPDATE group_runs SET status = 'cancelled', ended_reason = ?, ended_at = ? WHERE id = ?",
    String(reason || 'cancelled').slice(0, 60),
    now,
    id
  );
}

/** 一次群聊历史 run（诊断/展示用） */
export function listRuns(groupId: number, limit = 20): GroupRunRow[] {
  const gid = asPositiveInt(groupId);
  if (!gid) return [];
  const n = Math.min(200, Math.max(1, Math.trunc(limit) || 20));
  return dbAll<GroupRunRow>('SELECT * FROM group_runs WHERE group_id = ? ORDER BY id DESC LIMIT ?', gid, n);
}
