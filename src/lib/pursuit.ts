// 攻略状态机（T03）：stranger → acquaintance → ambiguous → pursuing → girlfriend，
// 旁支 cold / rejected / closed。严格照架构 §3.2 实现，**不新建平行数值系统**：
//   - 好感=intimacy、信任=trust、冲突=conflict_state，全部复用既有 relationship_state；
//   - attraction（吸引力）只存 companions 表，不进 relationship_state。
//
// 节奏：每 PURSUIT_CHECK_EVERY（=5）个回合触发一次 checkAdvance（由 response-hints 调度）。
// 被拒 → cooldown_until = now + 24h、reject_count++；累计 MAX_REJECTS（=3）→ status='closed'。
import { dbGet, dbRun, getCounter, setCounter, DEFAULT_USER_ID } from './db';
import { ck, withCompanion, PRIMARY_COMPANION_ID } from './companion-context';
import { nowIso, clamp } from './utils';
import { getRelationshipState } from './relationship';
import type { CompanionRow, RelationshipState } from './types';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */
/** 每 N 个回合做一次攻略推进检查（对齐 Artemis「每 5 条检查」） */
export const PURSUIT_CHECK_EVERY = 5;
/** 表白被拒后的冷却时长（小时） */
export const REJECT_COOLDOWN_HOURS = 24;
/** 累计被拒次数上限（达到即永久关闭） */
export const MAX_REJECTS = 3;

/** 晋升为女友的阈值（pursuing → girlfriend） */
export const PROMOTE_INTIMACY = 60;
export const PROMOTE_TRUST = 50;
export const PROMOTE_ATTRACTION = 50;

/** cold 判定：连续 N 次检查无好感正向进展 → 冷淡 */
export const COLD_STREAK = 5;

/** 状态枚举（存英文 key，UI 映射中文） */
export const COMPANION_STATUS = {
  stranger: 'stranger',
  acquaintance: 'acquaintance',
  ambiguous: 'ambiguous',
  pursuing: 'pursuing',
  girlfriend: 'girlfriend',
  cold: 'cold',
  rejected: 'rejected',
  closed: 'closed',
} as const;
export type CompanionStatus = (typeof COMPANION_STATUS)[keyof typeof COMPANION_STATUS];

export const COMPANION_STATUS_LABEL: Record<string, string> = {
  stranger: '陌生人',
  acquaintance: '认识',
  ambiguous: '暧昧',
  pursuing: '追求中',
  girlfriend: '女友',
  cold: '冷淡',
  rejected: '被拒',
  closed: '已关闭',
};

/** 主攻略主线顺序（不含旁支） */
export const PURSUIT_ORDER: CompanionStatus[] = ['stranger', 'acquaintance', 'ambiguous', 'pursuing', 'girlfriend'];

/** 下一状态（主线的下一格；旁支返回 null） */
const NEXT_STATUS: Record<string, CompanionStatus | null> = {
  stranger: 'acquaintance',
  acquaintance: 'ambiguous',
  ambiguous: 'pursuing',
  pursuing: 'girlfriend',
  girlfriend: null,
  cold: 'acquaintance',
  rejected: 'acquaintance',
  closed: null,
};

export function statusLabel(status: string): string {
  return COMPANION_STATUS_LABEL[status] ?? status;
}

/** 该状态是否属于「攻略中/可攻略」，需要跑每 5 回合检查 */
const PURSUIT_ACTIVE_STATES = new Set<string>(['stranger', 'acquaintance', 'ambiguous', 'pursuing', 'cold', 'rejected']);

export function isPursuitActive(status: string): boolean {
  return PURSUIT_ACTIVE_STATES.has(status);
}

function normalizeId(id: number): number {
  const n = Math.trunc(Number(id));
  return Number.isFinite(n) && n > 0 ? n : PRIMARY_COMPANION_ID;
}

/* ------------------------------------------------------------------ */
/* 读写                                                                */
/* ------------------------------------------------------------------ */
export function getCompanionRow(id: number): CompanionRow | null {
  return dbGet<CompanionRow>('SELECT * FROM companions WHERE id = ?', normalizeId(id)) ?? null;
}

export function statusOf(id: number): string | null {
  const row = dbGet<{ status: string }>('SELECT status FROM companions WHERE id = ?', normalizeId(id));
  return row?.status ?? null;
}

/** 读取某伴侣关系状态（按 id 作用域）；行缺失时返回 null（未初始化） */
function readRelationship(id: number): RelationshipState | null {
  return withCompanion(id, () => {
    try {
      return getRelationshipState();
    } catch {
      return null;
    }
  });
}

/** 更新 companions 的 status 及若干可选字段（纯 id 定位语句，走 dbRun） */
function setCompanionStatus(
  id: number,
  status: string,
  patch: Partial<
    Pick<
      CompanionRow,
      | 'cooldown_until'
      | 'closed_at'
      | 'established_at'
      | 'attraction'
      | 'reject_count'
      | 'pursue_opt_in'
      | 'pending'
      | 'is_discovered'
      | 'last_active_at'
    >
  > = {}
): void {
  const cols: string[] = ['status = ?', 'updated_at = ?'];
  const params: unknown[] = [status, nowIso()];
  for (const key of [
    'cooldown_until',
    'closed_at',
    'established_at',
    'attraction',
    'reject_count',
    'pursue_opt_in',
    'pending',
    'is_discovered',
    'last_active_at',
  ] as const) {
    if (key in patch) {
      cols.push(`${key} = ?`);
      params.push(patch[key] ?? null);
    }
  }
  params.push(normalizeId(id));
  dbRun(`UPDATE companions SET ${cols.join(', ')} WHERE id = ?`, ...params);
}

/** 记录一条伴侣事件（companion_events，全局表；companion_id 显式传入） */
export function logCompanionEvent(
  companionId: number | null,
  kind: string,
  summary: string,
  opts: { oldValue?: unknown; newValue?: unknown; reason?: string; meta?: unknown } = {}
): void {
  dbRun(
    `INSERT INTO companion_events (user_id, companion_id, kind, summary, old_value, new_value, reason, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    DEFAULT_USER_ID,
    companionId == null ? null : normalizeId(companionId),
    kind,
    summary,
    opts.oldValue === undefined ? null : typeof opts.oldValue === 'string' ? opts.oldValue : JSON.stringify(opts.oldValue),
    opts.newValue === undefined ? null : typeof opts.newValue === 'string' ? opts.newValue : JSON.stringify(opts.newValue),
    opts.reason ?? null,
    opts.meta === undefined ? null : JSON.stringify(opts.meta),
    nowIso()
  );
}

export function setAttraction(id: number, value: number): void {
  dbRun('UPDATE companions SET attraction = ?, updated_at = ? WHERE id = ?', clamp(Number(value) || 0, 0, 100), nowIso(), normalizeId(id));
}

/* ------------------------------------------------------------------ */
/* 冷却                                                                */
/* ------------------------------------------------------------------ */
/** 冷却是否已过（无 cooldown_until 视为已过） */
export function recooldownElapsed(id: number): boolean {
  const row = dbGet<{ cooldown_until: string | null }>('SELECT cooldown_until FROM companions WHERE id = ?', normalizeId(id));
  const until = row?.cooldown_until;
  if (!until) return true;
  const t = new Date(until).getTime();
  return !Number.isFinite(t) || t <= Date.now();
}

/** 是否处于被拒冷却中（rejected 且未到点） */
export function inCooldown(id: number): boolean {
  const row = dbGet<{ status: string; cooldown_until: string | null }>(
    'SELECT status, cooldown_until FROM companions WHERE id = ?',
    normalizeId(id)
  );
  if (!row || row.status !== 'rejected') return false;
  return !!row.cooldown_until && new Date(row.cooldown_until).getTime() > Date.now();
}

/** 是否允许表白（需已选「攻略」；冷却期屏蔽；已晋升/已关闭也屏蔽） */
export function canConfess(id: number): boolean {
  const row = getCompanionRow(id);
  if (!row) return false;
  if (Number(row.pursue_opt_in) !== 1) return false; // 未攻略 / 已「暂不」不具备表白资格
  if (row.status === 'girlfriend' || row.status === 'closed') return false;
  if (inCooldown(Number(row.id))) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* 状态迁移                                                            */
/* ------------------------------------------------------------------ */
export interface AdvanceResult {
  status: string;
  from: string;
  changed: boolean;
}

/**
 * 每 PURSUIT_CHECK_EVERY 回合调用一次：按 §3.2 的迁移条件推进状态机。
 * - 冷却结束后 rejected → acquaintance（可再接触）；
 * - cold 判定（连续无正向进展）与回暖；
 * - stranger→acquaintance→ambiguous→pursuing（pursuing→girlfriend 需用户确认，不在此自动发生）。
 */
export function checkAdvance(companionId: number, turn: number): AdvanceResult | null {
  const id = normalizeId(companionId);
  return withCompanion(id, () => {
    const row = getCompanionRow(id);
    if (!row) return null;
    const from = row.status;
    let status = row.status;
    const rel = readRelationship(id);
    const intimacy = Number(rel?.intimacy ?? 0);
    const conflict = String(rel?.conflict_state ?? 'none');
    const balance = Number(rel?.emotional_balance ?? 0);
    const attraction = Number(row.attraction ?? 0);
    const pendingTalk = Number(rel?.pending_relationship_talk ?? 0);

    // rejected 冷却结束 → 可再接触
    if (status === 'rejected' && recooldownElapsed(id)) {
      status = 'acquaintance';
    }

    // cold：连续无好感正向进展则冷淡；回暖则回到认识
    const lastKey = ck('pursuit_last_intimacy');
    const streakKey = ck('pursuit_cold_streak');
    const lastIntimacy = getCounter(lastKey); // 存 intimacy×10 的整数
    const curIntimacy = Math.round(intimacy * 10);
    let streak = getCounter(streakKey);
    if (curIntimacy > lastIntimacy) streak = 0;
    else streak += 1;
    setCounter(lastKey, curIntimacy);
    setCounter(streakKey, streak);

    if (status === 'cold') {
      if (curIntimacy > lastIntimacy || balance > 0) status = 'acquaintance';
    } else if ((status === 'acquaintance' || status === 'ambiguous' || status === 'pursuing') && streak >= COLD_STREAK) {
      status = 'cold';
    }

    // 主线推进（复用既有字段，不新建数值）
    if (status === 'stranger' && turn >= 1 && intimacy >= 5) status = 'acquaintance';
    if (status === 'acquaintance' && intimacy >= 20 && conflict === 'none') status = 'ambiguous';
    if (
      status === 'ambiguous' &&
      intimacy >= 40 &&
      (pendingTalk === 1 || Number(row.pursue_opt_in) === 1) &&
      attraction >= 30
    ) {
      status = 'pursuing';
    }

    if (status !== from) {
      setCompanionStatus(id, status, { last_active_at: nowIso() });
      logCompanionEvent(id, 'progress', `攻略状态：${statusLabel(from)} → ${statusLabel(status)}`, {
        oldValue: from,
        newValue: status,
      });
    } else {
      setCompanionStatus(id, status); // 仅刷新 updated_at
    }
    return { status, from, changed: status !== from };
  });
}

/** 被拒：进入冷却 / 累计 3 次永久关闭 */
export function reject(
  companionId: number,
  reason = '表白未达标'
): { status: string; reject_count: number; closed: boolean; cooldown_until: string | null } {
  const id = normalizeId(companionId);
  return withCompanion(id, () => {
    const row = getCompanionRow(id);
    if (!row) throw new Error('COMPANION_NOT_FOUND');
    const reject_count = Number(row.reject_count || 0) + 1;
    const closed = reject_count >= MAX_REJECTS;
    const cooldown = closed ? row.cooldown_until : new Date(Date.now() + REJECT_COOLDOWN_HOURS * 3600000).toISOString();
    const status = closed ? 'closed' : 'rejected';
    setCompanionStatus(id, status, {
      reject_count,
      cooldown_until: closed ? row.cooldown_until : cooldown,
      closed_at: closed ? nowIso() : row.closed_at,
    });
    logCompanionEvent(
      id,
      closed ? 'closed' : 'rejected',
      closed ? `累计被拒 ${reject_count} 次，已永久关闭（移出主列表）` : `表白被拒，进入 ${REJECT_COOLDOWN_HOURS} 小时冷却`,
      { oldValue: row.status, newValue: status, reason }
    );
    return { status, reject_count, closed, cooldown_until: cooldown };
  });
}

/** 用户确认「在一起」且达标 → 晋升为女友（状态写入；面板初始化由 companion.promote 负责） */
export function markGirlfriend(companionId: number): void {
  const id = normalizeId(companionId);
  const row = getCompanionRow(id);
  setCompanionStatus(id, 'girlfriend', { established_at: nowIso() });
  logCompanionEvent(id, 'promote', '确立关系，晋升为女友', {
    oldValue: row?.status ?? 'pursuing',
    newValue: 'girlfriend',
  });
}

export interface ConfessionResult {
  accepted: boolean;
  status: string;
  code?: string;
  reject_count?: number;
  cooldown_until?: string | null;
}

/**
 * 解析一次表白：达标 → 晋升；未达标 → 被拒（冷却 / 永久关闭）。
 * 冷却期内直接返回 PURSUIT_REJECTED_COOLDOWN（屏蔽表白）。
 */
export function resolveConfession(companionId: number): ConfessionResult {
  const id = normalizeId(companionId);
  const row = getCompanionRow(id);
  if (!row) return { accepted: false, status: 'closed', code: 'COMPANION_NOT_FOUND' };
  if (row.status === 'closed') return { accepted: false, status: 'closed', code: 'COMPANION_CLOSED' };
  if (row.status === 'girlfriend') return { accepted: true, status: 'girlfriend', code: 'ALREADY_GIRLFRIEND' };
  if (inCooldown(id)) return { accepted: false, status: row.status, code: 'PURSUIT_REJECTED_COOLDOWN' };

  const rel = readRelationship(id);
  const intimacy = Number(rel?.intimacy ?? 0);
  const trust = Number(rel?.trust ?? 0);
  const conflict = String(rel?.conflict_state ?? 'none');
  const attraction = Number(row.attraction ?? 0);
  const ok =
    intimacy >= PROMOTE_INTIMACY && trust >= PROMOTE_TRUST && attraction >= PROMOTE_ATTRACTION && conflict === 'none';
  if (ok) {
    markGirlfriend(id);
    return { accepted: true, status: 'girlfriend' };
  }
  const r = reject(id, '表白时条件未达标');
  return { accepted: false, status: r.status, reject_count: r.reject_count, cooldown_until: r.cooldown_until };
}

/* ------------------------------------------------------------------ */
/* 进度视图                                                            */
/* ------------------------------------------------------------------ */
export interface PursuitRequirement {
  key: string;
  label: string;
  current: number;
  target: number;
  met: boolean;
}

export interface PursuitProgress {
  status: string;
  label: string;
  next: CompanionStatus | null;
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

export function progressOf(companionId: number): PursuitProgress {
  const id = normalizeId(companionId);
  return withCompanion(id, () => {
    const row = getCompanionRow(id);
    const rel = readRelationship(id);
    const status = row?.status ?? 'stranger';
    const intimacy = Number(rel?.intimacy ?? 0);
    const trust = Number(rel?.trust ?? 0);
    const conflict = String(rel?.conflict_state ?? 'none');
    const attraction = Number(row?.attraction ?? 0);
    const next = NEXT_STATUS[status] ?? null;
    const requirements: PursuitRequirement[] =
      next === 'ambiguous'
        ? [
            { key: 'intimacy', label: '好感', current: intimacy, target: 20, met: intimacy >= 20 },
            { key: 'conflict', label: '无未解冲突', current: conflict === 'none' ? 1 : 0, target: 1, met: conflict === 'none' },
          ]
        : next === 'pursuing'
          ? [
              { key: 'intimacy', label: '好感', current: intimacy, target: 40, met: intimacy >= 40 },
              { key: 'attraction', label: '吸引力', current: attraction, target: 30, met: attraction >= 30 },
              {
                key: 'pursue_opt_in',
                label: '已选择攻略',
                current: Number(row?.pursue_opt_in) === 1 ? 1 : 0,
                target: 1,
                met: Number(row?.pursue_opt_in) === 1,
              },
            ]
          : next === 'girlfriend'
            ? [
                { key: 'intimacy', label: '好感', current: intimacy, target: PROMOTE_INTIMACY, met: intimacy >= PROMOTE_INTIMACY },
                { key: 'trust', label: '信任', current: trust, target: PROMOTE_TRUST, met: trust >= PROMOTE_TRUST },
                {
                  key: 'attraction',
                  label: '吸引力',
                  current: attraction,
                  target: PROMOTE_ATTRACTION,
                  met: attraction >= PROMOTE_ATTRACTION,
                },
                { key: 'conflict', label: '无未解冲突', current: conflict === 'none' ? 1 : 0, target: 1, met: conflict === 'none' },
              ]
            : [];
    return {
      status,
      label: statusLabel(status),
      next,
      attraction,
      intimacy,
      trust,
      conflict_state: conflict,
      cooldown_until: row?.cooldown_until ?? null,
      in_cooldown: !!row && inCooldown(id),
      reject_count: Number(row?.reject_count ?? 0),
      pursue_opt_in: Number(row?.pursue_opt_in ?? 0),
      requirements,
    };
  });
}
