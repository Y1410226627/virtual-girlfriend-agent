// 伴侣关系网（T03）：伴侣与伴侣之间的关系边（-100..100）+ 对用户好感的双向闭环。
//
// 设计要点（对齐架构 §3.5）：
// - value 存规范序 (a_id < b_id)；RELATION_ALLY=40 / RELATION_JEALOUS=-40。
// - 好感增量只经 applyRelationshipDelta() 这唯一写点写入（reason='伴侣关系变化'），
//   **绝不直接改 emotional_balance**（余额唯一记账点是 addBankEntry，避免双计）。
// - 一次事件若影响多方，全部在同一个 tx() 内完成（tx 可重入）。
// - toAffectionDelta(value, change) 是确定性纯函数，便于单测。
import { dbRun, dbGet, dbAll, tx, DEFAULT_USER_ID } from './db';
import { withCompanion } from './companion-context';
import { nowIso, clamp, round1 } from './utils';
import { applyRelationshipDelta } from './relationship';
import { logCompanionEvent } from './pursuit';
import type { CompanionRelationRow } from './types';

/** 联盟/友好阈值 */
export const RELATION_ALLY = 40;
/** 吃醋/竞争阈值 */
export const RELATION_JEALOUS = -40;
/** 好感微增量（每次关系事件对各自对用户好感的调整量级） */
export const AFFECTION_REASON = '伴侣关系变化';

/** 规范序：返回 [min, max]，保证 a_id < b_id */
export function normalizePair(a: number, b: number): [number, number] {
  const x = Math.trunc(Number(a));
  const y = Math.trunc(Number(b));
  return x <= y ? [x, y] : [y, x];
}

/** 由关系值得到状态（friendly|neutral|jealous|rival|ally） */
export function stateOfRelationship(value: number): string {
  const v = Number(value) || 0;
  if (v >= RELATION_ALLY) return 'ally';
  if (v > 0) return 'friendly';
  if (v === 0) return 'neutral';
  if (v > RELATION_JEALOUS) return 'rival';
  return 'jealous';
}

export const RELATION_STATE_LABEL: Record<string, string> = {
  ally: '盟友',
  friendly: '友好',
  neutral: '中立',
  rival: '竞争',
  jealous: '吃醋',
};

/**
 * 确定性纯函数：由关系值 + 本次变化量，得出对双方「用户好感(intimacy)」的微增量。
 * - 联盟/友好（value >= RELATION_ALLY）→ 两边好感小幅 +
 * - 吃醋/竞争（value <= RELATION_JEALOUS）→ 两边好感小幅 −
 * - 中性区（|value| 未触及阈值）→ 不做（0）
 * 说明：在缺少「谁更受偏爱」信息时，对关系变好/变差的双方取对称增量（可解释、可复现）。
 */
export function toAffectionDelta(value: number, change: number): { a: number; b: number } {
  const v = Number(value) || 0;
  const magnitude = round1(0.5 + clamp(Math.abs(Number(change) || 0), 0, 10) / 20); // 0.5..1.0
  if (v >= RELATION_ALLY) return { a: magnitude, b: magnitude };
  if (v <= RELATION_JEALOUS) return { a: -magnitude, b: -magnitude };
  return { a: 0, b: 0 };
}

/** 读一条关系边（规范序，纯 id 定位） */
export function getRelation(a: number, b: number): CompanionRelationRow | null {
  const [x, y] = normalizePair(a, b);
  return (
    dbGet<CompanionRelationRow>('SELECT * FROM companion_relations WHERE a_id = ? AND b_id = ?', x, y) ?? null
  );
}

export interface RelationEdge extends CompanionRelationRow {
  a_name: string | null;
  b_name: string | null;
}

/** 全部关系边（含双方显示名），供关系网视图 */
export function listRelations(): RelationEdge[] {
  return dbAll<RelationEdge>(
    `SELECT r.*, ca.name AS a_name, cb.name AS b_name
       FROM companion_relations r
       LEFT JOIN companions ca ON ca.id = r.a_id
       LEFT JOIN companions cb ON cb.id = r.b_id
      ORDER BY r.id DESC`
  );
}

/** 与某个伴侣相关的全部关系边 */
export function listRelationsFor(companionId: number): RelationEdge[] {
  const id = Math.trunc(Number(companionId));
  return dbAll<RelationEdge>(
    `SELECT r.*, ca.name AS a_name, cb.name AS b_name
       FROM companion_relations r
       LEFT JOIN companions ca ON ca.id = r.a_id
       LEFT JOIN companions cb ON cb.id = r.b_id
      WHERE r.a_id = ? OR r.b_id = ?
      ORDER BY r.id DESC`,
    id,
    id
  );
}

/**
 * 给某伴侣写一笔「对用户好感」的微增量。
 * 唯一写点：applyRelationshipDelta（reason='伴侣关系变化'）；不触碰 emotional_balance。
 */
function applyAffection(companionId: number, delta: number): void {
  const d = Number(delta) || 0;
  if (d === 0) return;
  withCompanion(companionId, () => {
    // 该伴侣的关系状态行必须存在（未初始化则跳过，避免抛错）
    const exists = dbGet<{ companion_id: number }>(
      'SELECT companion_id FROM relationship_state WHERE companion_id = ?',
      companionId
    );
    if (!exists) return;
    applyRelationshipDelta({ intimacy: d }, AFFECTION_REASON);
  });
}

export interface ApplyDeltaResult {
  a_id: number;
  b_id: number;
  value: number;
  state: string;
  change: number;
  affection: { a: number; b: number };
}

/**
 * 更新伴侣间关系值并触发「对用户好感」的闭环。
 * 全部写入（关系边 + 双方好感 + 事件日志）在同一个事务内完成。
 */
export function applyDelta(aId: number, bId: number, delta: number, reason: string): ApplyDeltaResult {
  const [x, y] = normalizePair(aId, bId);
  if (x === y) {
    // 自己与自己没有关系边（CHECK a_id < b_id 亦不允许）
    return { a_id: x, b_id: y, value: 0, state: 'neutral', change: 0, affection: { a: 0, b: 0 } };
  }
  const d = Number(delta) || 0;
  return tx(() => {
    const existing = dbGet<CompanionRelationRow>(
      'SELECT * FROM companion_relations WHERE a_id = ? AND b_id = ?',
      x,
      y
    );
    const before = Number(existing?.value ?? 0);
    const value = round1(clamp(before + d, -100, 100));
    const change = round1(value - before);
    const state = stateOfRelationship(value);
    const now = nowIso();
    if (existing) {
      dbRun(
        'UPDATE companion_relations SET value = ?, state = ?, last_event_at = ?, updated_at = ? WHERE a_id = ? AND b_id = ?',
        value,
        state,
        now,
        now,
        x,
        y
      );
    } else {
      dbRun(
        'INSERT INTO companion_relations (user_id, a_id, b_id, value, state, last_event_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        DEFAULT_USER_ID,
        x,
        y,
        value,
        state,
        now,
        now
      );
    }

    const affection = toAffectionDelta(value, change);
    applyAffection(x, affection.a);
    applyAffection(y, affection.b);

    logCompanionEvent(null, 'relation_change', `伴侣关系变化：${x} ↔ ${y} → ${RELATION_STATE_LABEL[state] ?? state}`, {
      oldValue: before,
      newValue: value,
      reason,
      meta: { a_id: x, b_id: y, affection },
    });

    return { a_id: x, b_id: y, value, state, change, affection };
  });
}
