// 操作账本（turn_operations）：记录每个真实状态变化的精确来源，供删除/重新生成时精确反向。
// 表结构见 db-migrations.ts v12。本模块由「分析管线」负责补全：
//   - recordOperation：写入一条操作记录（同步，无自己的事务；调用方需保证已在事务内或接受独立写入）
//   - rollbackOperationsForGeneration：按 generation 精确反向（分析代理实现）
import { dbAll, dbGet, dbRun, DEFAULT_USER_ID } from './db';
import { clamp, nowIso, round1 } from './utils';
import { attachmentStyleOf } from './types';

export interface OperationInput {
  turnId?: number | null;
  generationId?: number | null;
  operationType: string;
  targetTable: string;
  targetId?: number | null;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
}

export interface TurnOperationRow {
  id: number;
  user_id: number;
  turn_id: number | null;
  generation_id: number | null;
  operation_type: string;
  target_table: string;
  target_id: number | null;
  before_json: string | null;
  after_json: string | null;
  meta_json: string | null;
  created_at: string;
}

/**
 * P1-39/40：把一组 assistant 消息 id 映射到它们所属回合的 turn_id（归因用）。
 * 依赖 message_generations(assistant_message_id → turn_id)；message_id 为空 / 查不到对应回合的忽略。
 * 返回去重、升序的 turn_id 数组（可能为空 → 调用方落 NULL，保持"映射不到则 NULL"）。
 */
export function resolveSourceTurns(messageIds: Array<number | null | undefined>): number[] {
  const ids = [
    ...new Set(
      (messageIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
    ),
  ];
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const rows = dbAll<{ turn_id: number }>(
    `SELECT DISTINCT turn_id FROM message_generations WHERE user_id = ? AND assistant_message_id IN (${ph})`,
    DEFAULT_USER_ID,
    ...ids
  );
  return rows
    .map((r) => Number(r.turn_id))
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);
}

/**
 * P1-39/40：这次人格/依恋调整是否属于"多源累积"，因而不该随单条消息一起回滚。
 * - source_turns 为 NULL/空 → false（保持现有精确回滚行为）；
 * - 来源回合数 > 1，或唯一来源回合 ≠ 被删消息所属回合（op.turn_id）→ true。
 */
function isMultiSourceAttribution(sourceTurnsJson: string | null, opTurnId: number | null | undefined): boolean {
  const src = parseJson<number[]>(sourceTurnsJson);
  if (!Array.isArray(src) || src.length === 0) return false;
  if (src.length > 1) return true;
  const only = Number(src[0]);
  const opTurn = opTurnId === null || opTurnId === undefined ? null : Number(opTurnId);
  return opTurn === null || !Number.isFinite(opTurn) || only !== opTurn;
}

function toJson(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

/** 记录一条操作（返回行 id；写入失败返回 0，绝不抛出影响主流程） */
export function recordOperation(op: OperationInput): number {
  try {
    const { lastInsertRowid } = dbRun(
      `INSERT INTO turn_operations
         (user_id, turn_id, generation_id, operation_type, target_table, target_id, before_json, after_json, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      DEFAULT_USER_ID,
      op.turnId ?? null,
      op.generationId ?? null,
      String(op.operationType),
      String(op.targetTable),
      op.targetId ?? null,
      toJson(op.before),
      toJson(op.after),
      toJson(op.meta),
      nowIso()
    );
    return lastInsertRowid;
  } catch (e) {
    console.warn('[turnOps] 记录操作失败:', e instanceof Error ? e.message : String(e));
    return 0;
  }
}

/** 读取某次生成的全部操作（按 id 升序） */
export function listOperationsForGeneration(generationId: number): TurnOperationRow[] {
  if (!Number.isFinite(generationId) || generationId <= 0) return [];
  return dbAll<TurnOperationRow>(
    'SELECT * FROM turn_operations WHERE user_id = ? AND generation_id = ? ORDER BY id ASC',
    DEFAULT_USER_ID,
    generationId
  );
}

/** 读取某个回合的全部操作（按 id 升序） */
export function listOperationsForTurn(turnId: number): TurnOperationRow[] {
  if (!Number.isFinite(turnId) || turnId <= 0) return [];
  return dbAll<TurnOperationRow>(
    'SELECT * FROM turn_operations WHERE user_id = ? AND turn_id = ? ORDER BY id ASC',
    DEFAULT_USER_ID,
    turnId
  );
}

/**
 * 精确反向某次生成的全部操作（重新生成时撤销旧生成的已生效影响）。
 */
export function rollbackOperationsForGeneration(generationId: number): { rolledBack: number } {
  return rollbackOperations(listOperationsForGeneration(generationId));
}

/** 关系数值快照（账本 relationship.delta 的 before/after 结构） */
interface RelSnapshot {
  intimacy?: number;
  trust?: number;
  balance?: number;
  tension?: number;
  repair?: number;
  mood?: string;
  stage?: number;
}

/** shared_world 快照 */
interface SharedSnapshot {
  shared_places_json?: string | null;
  shared_plans_json?: string | null;
  shared_rituals_json?: string | null;
  shared_items_json?: string | null;
  cast_json?: string | null;
}

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** 反向单条操作；成功返回 true */
function undoOne(op: TurnOperationRow): boolean {
  const before = parseJson<Record<string, unknown>>(op.before_json);
  const after = parseJson<Record<string, unknown>>(op.after_json);
  const meta = parseJson<Record<string, unknown>>(op.meta_json);
  const targetId = Number(op.target_id || 0);

  switch (op.operation_type) {
    case 'memory.create': {
      if (!targetId) return false;
      dbRun('DELETE FROM memory_embeddings WHERE memory_id = ?', targetId);
      const r = dbRun('DELETE FROM memories WHERE id = ? AND user_id = ?', targetId, DEFAULT_USER_ID);
      return r.changes > 0;
    }

    case 'personality_log.create': {
      // P1-39/40：这次的 ±1 微调若来自"多个回合积累"的信号（source_turns 多元素，或唯一来源
      // 不属于本次被删消息所属回合），它不归这一条消息 → 不回退数值、也不删日志。
      // source_turns 为 NULL（老数据 / 映射不到）时保持原有精确回滚行为。
      const plog = targetId
        ? dbGet<{ source_turns: string | null }>(
            'SELECT source_turns FROM personality_logs WHERE id = ? AND user_id = ?',
            targetId,
            DEFAULT_USER_ID
          )
        : null;
      // 返回 false = 本次未做任何反向（不计入 rolledBack）。
      if (isMultiSourceAttribution(plog?.source_turns ?? null, op.turn_id)) return false;

      const dim = String(meta?.dimension || '');
      const oldV = Number(meta?.old_value);
      const newV = Number(meta?.new_value);
      if (targetId && dim) {
        // 只有"当前值仍等于这次调整后的值"才回退（否则说明之后又变过，保留后续成长）
        const cur = dbGet<{ value: number }>('SELECT value FROM personality_state WHERE user_id = ? AND dimension = ?', DEFAULT_USER_ID, dim);
        if (cur && round1(Number(cur.value)) === round1(newV)) {
          dbRun('UPDATE personality_state SET value = ?, updated_at = ? WHERE user_id = ? AND dimension = ?', oldV, nowIso(), DEFAULT_USER_ID, dim);
        }
        dbRun('DELETE FROM personality_logs WHERE id = ? AND user_id = ?', targetId, DEFAULT_USER_ID);
      }
      return true;
    }

    case 'attachment_log.create': {
      // P1-39/40：同上——依恋调整若来自跨回合累积（多源），不随单条消息回滚。
      const alog = targetId
        ? dbGet<{ source_turns: string | null }>(
            'SELECT source_turns FROM attachment_logs WHERE id = ? AND user_id = ?',
            targetId,
            DEFAULT_USER_ID
          )
        : null;
      // 返回 false = 本次未做任何反向（不计入 rolledBack）。
      if (isMultiSourceAttribution(alog?.source_turns ?? null, op.turn_id)) return false;

      const oa = Number(meta?.old_anxiety);
      const na = Number(meta?.new_anxiety);
      const ov = Number(meta?.old_avoidance);
      const nv = Number(meta?.new_avoidance);
      if (targetId) {
        const cur = dbGet<{ anxiety: number; avoidance: number }>('SELECT anxiety, avoidance FROM attachment_state WHERE user_id = ?', DEFAULT_USER_ID);
        if (cur && round1(Number(cur.anxiety)) === round1(na) && round1(Number(cur.avoidance)) === round1(nv)) {
          dbRun(
            'UPDATE attachment_state SET anxiety = ?, avoidance = ?, style = ?, updated_at = ? WHERE user_id = ?',
            oa,
            ov,
            attachmentStyleOf(oa, ov),
            nowIso(),
            DEFAULT_USER_ID
          );
        }
        dbRun('DELETE FROM attachment_logs WHERE id = ? AND user_id = ?', targetId, DEFAULT_USER_ID);
      }
      return true;
    }

    case 'emotional_bank.create': {
      if (!targetId) return false;
      const delta = Number((after as { delta?: number } | null)?.delta ?? 0);
      dbRun('DELETE FROM emotional_bank WHERE id = ? AND user_id = ?', targetId, DEFAULT_USER_ID);
      const rel = dbGet<{ emotional_balance: number }>('SELECT emotional_balance FROM relationship_state WHERE user_id = ?', DEFAULT_USER_ID);
      const nb = clamp(Number(rel?.emotional_balance || 0) - delta, -100, 100);
      dbRun('UPDATE relationship_state SET emotional_balance = ?, updated_at = ? WHERE user_id = ?', round1(nb), nowIso(), DEFAULT_USER_ID);
      return true;
    }

    case 'conflict.create': {
      if (!targetId) return false;
      const r = dbRun("DELETE FROM conflict_logs WHERE id = ? AND user_id = ? AND status = 'open'", targetId, DEFAULT_USER_ID);
      return r.changes > 0;
    }

    case 'conflict.repair': {
      if (!targetId) return false;
      const r = dbRun("UPDATE conflict_logs SET status = 'open', resolved_at = NULL, tension_after = NULL WHERE id = ? AND user_id = ?", targetId, DEFAULT_USER_ID);
      return r.changes > 0;
    }

    case 'shared_world.update': {
      if (!before) return false;
      const b = before as SharedSnapshot;
      dbRun(
        'UPDATE shared_world SET shared_places_json = ?, shared_plans_json = ?, shared_rituals_json = ?, shared_items_json = ?, cast_json = ?, updated_at = ? WHERE user_id = ?',
        b.shared_places_json ?? null,
        b.shared_plans_json ?? null,
        b.shared_rituals_json ?? null,
        b.shared_items_json ?? null,
        b.cast_json ?? null,
        nowIso(),
        DEFAULT_USER_ID
      );
      return true;
    }

    case 'agent_daily_events.create': {
      if (!targetId) return false;
      const r = dbRun('DELETE FROM agent_daily_events WHERE id = ? AND user_id = ?', targetId, DEFAULT_USER_ID);
      return r.changes > 0;
    }

    case 'relationship.delta': {
      if (!before) return false;
      const b = before as RelSnapshot;
      // "最新一轮"判定：本次操作所属 turn 是否为账本里最大的 turn_id。
      // 是 → 直接恢复 before；否 → 按记录差值扣回，保留之后轮次的成长。
      const latestTurn = Number(dbGet<{ t: number | null }>('SELECT MAX(turn_id) AS t FROM turn_operations WHERE user_id = ?', DEFAULT_USER_ID)?.t ?? 0);
      const isLatest = op.turn_id === null || op.turn_id === undefined ? true : Number(op.turn_id) >= latestTurn;
      if (isLatest) {
        const mood = typeof b.mood === 'string' && b.mood ? b.mood : null;
        const stage = Number.isFinite(Number(b.stage)) ? Number(b.stage) : null;
        dbRun(
          `UPDATE relationship_state SET
             intimacy = ?, trust = ?, unresolved_tension = ?, repair_credit = ?,
             mood = COALESCE(?, mood), stage = COALESCE(?, stage), updated_at = ?
           WHERE user_id = ?`,
          clamp(Number(b.intimacy), 0, 100),
          clamp(Number(b.trust), 0, 100),
          clamp(Number(b.tension), 0, 100),
          clamp(Number(b.repair), 0, 100),
          mood,
          stage,
          nowIso(),
          DEFAULT_USER_ID
        );
      } else {
        const a = after as RelSnapshot | null;
        if (!a) return false;
        const rel = dbGet<{ intimacy: number; trust: number; unresolved_tension: number; repair_credit: number }>(
          'SELECT intimacy, trust, unresolved_tension, repair_credit FROM relationship_state WHERE user_id = ?',
          DEFAULT_USER_ID
        );
        if (!rel) return false;
        dbRun(
          `UPDATE relationship_state SET intimacy = ?, trust = ?, unresolved_tension = ?, repair_credit = ?, updated_at = ? WHERE user_id = ?`,
          clamp(Number(rel.intimacy) - (Number(a.intimacy) - Number(b.intimacy)), 0, 100),
          clamp(Number(rel.trust) - (Number(a.trust) - Number(b.trust)), 0, 100),
          clamp(Number(rel.unresolved_tension) - (Number(a.tension) - Number(b.tension)), 0, 100),
          clamp(Number(rel.repair_credit) - (Number(a.repair) - Number(b.repair)), 0, 100),
          nowIso(),
          DEFAULT_USER_ID
        );
      }
      return true;
    }

    default:
      return false;
  }
}

/**
 * 反向一组操作（按 id 倒序：后发生的先撤销）。逐条 try/catch：
 * 单条失败不影响其余（消息删除的场景下宁可多撤几条，也不因一条坏账中断）。
 * 调用方需自行包事务（messageActions 已在 tx 内调用）。
 */
export function rollbackOperations(ops: TurnOperationRow[]): { rolledBack: number } {
  let rolledBack = 0;
  const ordered = [...ops].sort((x, y) => y.id - x.id);
  for (const op of ordered) {
    try {
      if (undoOne(op)) rolledBack++;
    } catch (e) {
      console.warn('[turnOps] 反向操作失败:', op.operation_type, e instanceof Error ? e.message : String(e));
    }
  }
  return { rolledBack };
}