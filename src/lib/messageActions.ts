// 单条消息删除：可选"同时撤销这条消息产生的影响"
// 影响范围：记忆 / 性格信号与调整 / 依恋信号与调整 / 情感银行流水与余额 / 关系数值 / 冲突记录 / 关系日志
import { dbAll, dbGet, dbRun, tx, DEFAULT_USER_ID } from './db';
import { clamp, nowIso, round1, errMsg } from './utils';
import { getRelationshipState, saveRelationshipState } from './relationship';
import { listOperationsForGeneration, listOperationsForTurn, rollbackOperations, type TurnOperationRow } from './turnOps';

interface TurnEffectRow {
  id: number;
  message_id: number | null;
  user_message_id: number | null;
  intimacy_delta: number;
  trust_delta: number;
  balance_delta: number;
  tension_delta: number;
  repair_delta: number;
  rel_log_from: number | null;
  rel_log_to: number | null;
  att_log_from: number | null;
  att_log_to: number | null;
  conflict_id: number | null;
  created_at: string;
  meta: string | null;
}

interface PersonalityLogRow {
  dimension: string;
  old_value: number;
  new_value: number;
}

interface AttachmentLogRow {
  old_anxiety: number;
  new_anxiety: number;
  old_avoidance: number;
  new_avoidance: number;
}

interface TurnSnapshot {
  intimacy?: number;
  trust?: number;
  balance?: number;
  tension?: number;
  repair?: number;
  mood?: string;
  stage?: number;
}

export interface DeleteReport {
  ok: boolean;
  error?: string;
  messageId: number;
  cascade: boolean;
  removed: {
    memories: number;
    personalitySignals: number;
    personalityLogs: number;
    attachmentSignals: number;
    bankEntries: number;
    relationshipLogs: number;
    conflicts: number;
    proactive: number;
  };
  /** 撤销后的关系数值（cascade 时返回） */
  state?: { intimacy: number; trust: number; balance: number; tension: number; repair: number; mood: string; stage: number };
  notes: string[];
}

const emptyRemoved = () => ({
  memories: 0,
  personalitySignals: 0,
  personalityLogs: 0,
  attachmentSignals: 0,
  bankEntries: 0,
  relationshipLogs: 0,
  conflicts: 0,
  proactive: 0,
});

/**
 * 拿这条消息对应的操作账本（P0-09）：
 *  - assistant 消息：它在 message_generations 里的那次 generation → 只反向该 generation 的操作；
 *  - user 消息：它在 conversation_turns 里的那个 turn → 反向该 turn 的全部 generation 的操作。
 * 没有账本（历史数据 / 老逻辑路径）时返回空数组，调用方回落到推断式回滚。
 */
function ledgerOpsForMessage(id: number): TurnOperationRow[] {
  const gen = dbGet<{ id: number }>(
    'SELECT id FROM message_generations WHERE user_id = ? AND assistant_message_id = ?',
    DEFAULT_USER_ID,
    id
  );
  if (gen) {
    const ops = listOperationsForGeneration(Number(gen.id));
    if (ops.length) return ops;
  }
  const turn = dbGet<{ id: number }>(
    'SELECT id FROM conversation_turns WHERE user_id = ? AND user_message_id = ?',
    DEFAULT_USER_ID,
    id
  );
  if (turn) {
    const ops = listOperationsForTurn(Number(turn.id));
    if (ops.length) return ops;
  }
  return [];
}

/** 删除一条消息；cascade=true 时同时撤销这一轮产生的影响 */
export function deleteMessageById(id: number, cascade: boolean): DeleteReport {
  const report: DeleteReport = {
    ok: false,
    messageId: id,
    cascade,
    removed: emptyRemoved(),
    notes: [],
  };

  const msg = dbGet<{ id: number }>('SELECT * FROM messages WHERE id = ? AND user_id = ?', id, DEFAULT_USER_ID);
  if (!msg) {
    report.error = '这条消息不存在';
    return report;
  }

  if (!cascade) {
    // 只删消息，保留它产生的记忆与影响
    dbRun('DELETE FROM messages WHERE id = ? AND user_id = ?', id, DEFAULT_USER_ID);
    report.ok = true;
    report.notes.push('只删除了消息本身，记忆与关系状态保持不变');
    return report;
  }

  // 首选：操作账本精确反向（P0-09）。命中则不再走推断式回滚，避免重复扣减。
  const ledgerOps = ledgerOpsForMessage(id);
  if (ledgerOps.length) {
    try {
      tx(() => {
        rollbackOperations(ledgerOps);
        // 账本未覆盖的"行级"清理：信号 / 消息本体 / 审计兜底（关系·银行·冲突·记忆·性格·依恋·共享世界已由账本处理）
        const eff = dbGet<TurnEffectRow>(
          'SELECT * FROM turn_effects WHERE user_id = ? AND (message_id = ? OR user_message_id = ?) ORDER BY id DESC LIMIT 1',
          DEFAULT_USER_ID,
          id,
          id
        );
        const ids = [id];
        if (eff?.message_id) ids.push(Number(eff.message_id));
        if (eff?.user_message_id) ids.push(Number(eff.user_message_id));
        const uniq = Array.from(new Set(ids.filter((x) => Number.isFinite(x) && x > 0)));
        const ph = uniq.map(() => '?').join(',');
        // 记忆：账本已删本轮新建的；这里兜底清掉"合并到旧记忆但来源是这条消息"的情况
        const memRows = dbAll<{ id: number }>(
          `SELECT id FROM memories WHERE user_id = ? AND source_message_id IN (${ph})`,
          DEFAULT_USER_ID,
          ...uniq
        );
        for (const m of memRows) dbRun('DELETE FROM memory_embeddings WHERE memory_id = ?', m.id);
        dbRun(`DELETE FROM memories WHERE user_id = ? AND source_message_id IN (${ph})`, DEFAULT_USER_ID, ...uniq);
        dbRun(`DELETE FROM personality_signals WHERE user_id = ? AND message_id IN (${ph})`, DEFAULT_USER_ID, ...uniq);
        dbRun(`DELETE FROM attachment_signals WHERE user_id = ? AND message_id IN (${ph})`, DEFAULT_USER_ID, ...uniq);
        dbRun(`DELETE FROM proactive_messages WHERE user_id = ? AND message_id IN (${ph})`, DEFAULT_USER_ID, ...uniq);
        dbRun('DELETE FROM messages WHERE id = ? AND user_id = ?', id, DEFAULT_USER_ID);
      });
      report.ok = true;
      report.notes.push('已按操作账本精确撤销这一轮生成的影响；消息本体与信号已清理（turn_effects 记录保留作兜底）');
      const s = getRelationshipState();
      report.state = {
        intimacy: round1(s.intimacy),
        trust: round1(s.trust),
        balance: round1(s.emotional_balance),
        tension: round1(s.unresolved_tension),
        repair: round1(s.repair_credit),
        mood: s.mood,
        stage: s.stage,
      };
      return report;
    } catch (e) {
      report.error = errMsg(e);
      return report;
    }
  }

  try {
    tx(() => {
      // 找到这一轮的影响记录（用户消息或她的回复都能定位）
      const eff = dbGet<TurnEffectRow>(
        'SELECT * FROM turn_effects WHERE user_id = ? AND (message_id = ? OR user_message_id = ?) ORDER BY id DESC LIMIT 1',
        DEFAULT_USER_ID,
        id,
        id
      );
      const ids = [id];
      if (eff?.message_id) ids.push(Number(eff.message_id));
      if (eff?.user_message_id) ids.push(Number(eff.user_message_id));
      const uniq = Array.from(new Set(ids.filter((x) => Number.isFinite(x) && x > 0)));
      const ph = uniq.map(() => '?').join(',');

      /* 1) 记忆（含向量） */
      const memRows = dbAll<{ id: number }>(
        `SELECT id FROM memories WHERE user_id = ? AND source_message_id IN (${ph})`,
        DEFAULT_USER_ID,
        ...uniq
      );
      for (const m of memRows) dbRun('DELETE FROM memory_embeddings WHERE memory_id = ?', m.id);
      const delMem = dbRun(
        `DELETE FROM memories WHERE user_id = ? AND source_message_id IN (${ph})`,
        DEFAULT_USER_ID,
        ...uniq
      );
      report.removed.memories = delMem.changes;

      /* 2) 性格信号 + 性格调整日志（若当前值仍等于调整后的值，则回退） */
      const sigDel = dbRun(
        `DELETE FROM personality_signals WHERE user_id = ? AND message_id IN (${ph})`,
        DEFAULT_USER_ID,
        ...uniq
      );
      report.removed.personalitySignals = sigDel.changes;

      const pLogs = dbAll<PersonalityLogRow>(
        `SELECT * FROM personality_logs WHERE user_id = ? AND message_id IN (${ph})`,
        DEFAULT_USER_ID,
        ...uniq
      );
      for (const l of pLogs) {
        const cur = dbGet<{ value: number }>(
          'SELECT value FROM personality_state WHERE user_id = ? AND dimension = ?',
          DEFAULT_USER_ID,
          l.dimension
        );
        if (cur && round1(Number(cur.value)) === round1(Number(l.new_value))) {
          dbRun(
            'UPDATE personality_state SET value = ?, updated_at = ? WHERE user_id = ? AND dimension = ?',
            Number(l.old_value),
            nowIso(),
            DEFAULT_USER_ID,
            l.dimension
          );
        }
      }
      const pLogDel = dbRun(
        `DELETE FROM personality_logs WHERE user_id = ? AND message_id IN (${ph})`,
        DEFAULT_USER_ID,
        ...uniq
      );
      report.removed.personalityLogs = pLogDel.changes;

      /* 3) 依恋信号 + 依恋日志（按 id 区间回退两轴） */
      const attSigDel = dbRun(
        `DELETE FROM attachment_signals WHERE user_id = ? AND message_id IN (${ph})`,
        DEFAULT_USER_ID,
        ...uniq
      );
      report.removed.attachmentSignals = attSigDel.changes;

      if (eff?.att_log_from && eff?.att_log_to && Number(eff.att_log_to) > Number(eff.att_log_from)) {
        const attLogs = dbAll<AttachmentLogRow>(
          'SELECT * FROM attachment_logs WHERE user_id = ? AND id > ? AND id <= ? ORDER BY id DESC',
          DEFAULT_USER_ID,
          Number(eff.att_log_from),
          Number(eff.att_log_to)
        );
        for (const l of attLogs) {
          const cur = dbGet<{ anxiety: number; avoidance: number; style: string }>(
            'SELECT anxiety, avoidance, style FROM attachment_state WHERE user_id = ?',
            DEFAULT_USER_ID
          );
          if (
            cur &&
            round1(Number(cur.anxiety)) === round1(Number(l.new_anxiety)) &&
            round1(Number(cur.avoidance)) === round1(Number(l.new_avoidance))
          ) {
            dbRun(
              'UPDATE attachment_state SET anxiety = ?, avoidance = ?, style = ?, updated_at = ? WHERE user_id = ?',
              Number(l.old_anxiety),
              Number(l.old_avoidance),
              l.old_anxiety >= 40 ? (l.old_avoidance >= 40 ? 'fearful' : 'anxious') : l.old_avoidance >= 40 ? 'avoidant' : 'secure',
              nowIso(),
              DEFAULT_USER_ID
            );
          }
        }
        dbRun(
          'DELETE FROM attachment_logs WHERE user_id = ? AND id > ? AND id <= ?',
          DEFAULT_USER_ID,
          Number(eff.att_log_from),
          Number(eff.att_log_to)
        );
      }

      /* 4) 情感银行：撤销这一轮的流水，并把余额调回去 */
      const bankRows = dbAll<{ id: number; delta: number }>(
        `SELECT id, delta FROM emotional_bank WHERE user_id = ? AND message_id IN (${ph})`,
        DEFAULT_USER_ID,
        ...uniq
      );
      if (bankRows.length) {
        const sum = bankRows.reduce((s, r) => s + Number(r.delta), 0);
        // 优先用这一轮"实际生效"的余额增量：银行流水是申请值，触及 ±100 边界时两者会不一致
        const applied = eff && Number.isFinite(Number(eff.balance_delta)) ? Number(eff.balance_delta) : sum;
        const s = getRelationshipState();
        s.emotional_balance = clamp(s.emotional_balance - applied, -100, 100);
        saveRelationshipState(s);
        const bankDel = dbRun(
          `DELETE FROM emotional_bank WHERE user_id = ? AND message_id IN (${ph})`,
          DEFAULT_USER_ID,
          ...uniq
        );
        report.removed.bankEntries = bankDel.changes;
      }

      /* 5) 关系数值：最新一轮直接还原，较早的轮次按增量扣回（保留之后的成长） */
      if (eff) {
        const latest = dbGet<{ id: number }>(
          'SELECT MAX(id) AS id FROM turn_effects WHERE user_id = ?',
          DEFAULT_USER_ID
        );
        const isLatest = Number(latest?.id || 0) === Number(eff.id);
        const s = getRelationshipState();
        if (isLatest) {
          let before: TurnSnapshot | null = null;
          try {
            before = (JSON.parse(eff.meta || '{}') as { before?: TurnSnapshot | null }).before || null;
          } catch {
            before = null;
          }
          if (before) {
            s.intimacy = clamp(Number(before.intimacy), 0, 100);
            s.trust = clamp(Number(before.trust), 0, 100);
            s.emotional_balance = clamp(Number(before.balance), -100, 100);
            s.unresolved_tension = clamp(Number(before.tension), 0, 100);
            s.repair_credit = clamp(Number(before.repair), 0, 100);
            if (before.mood) s.mood = String(before.mood);
            if (Number.isFinite(Number(before.stage))) s.stage = Number(before.stage);
            report.notes.push('这一轮是最新一轮，关系数值已精确还原到聊天前');
          } else {
            report.notes.push('缺少还原快照，已按增量扣回');
          }
        }
        // 增量扣回（仅非最新轮：按实际增量往回扣，保留之后的成长）
        if (!isLatest) {
          s.intimacy = clamp(s.intimacy - Number(eff.intimacy_delta || 0), 0, 100);
          s.trust = clamp(s.trust - Number(eff.trust_delta || 0), 0, 100);
          s.unresolved_tension = clamp(s.unresolved_tension - Number(eff.tension_delta || 0), 0, 100);
          s.repair_credit = clamp(s.repair_credit - Number(eff.repair_delta || 0), 0, 100);
          report.notes.push('这一轮不是最新一轮，已按增量扣回（保留之后的成长）');
        }
        saveRelationshipState(s);
        report.state = {
          intimacy: round1(s.intimacy),
          trust: round1(s.trust),
          balance: round1(s.emotional_balance),
          tension: round1(s.unresolved_tension),
          repair: round1(s.repair_credit),
          mood: s.mood,
          stage: s.stage,
        };

        /* 6) 关系日志：删掉这一轮产生的日志 */
        if (eff.rel_log_from && eff.rel_log_to && Number(eff.rel_log_to) > Number(eff.rel_log_from)) {
          const logDel = dbRun(
            'DELETE FROM relationship_logs WHERE user_id = ? AND id > ? AND id <= ?',
            DEFAULT_USER_ID,
            Number(eff.rel_log_from),
            Number(eff.rel_log_to)
          );
          report.removed.relationshipLogs = logDel.changes;
        }

        /* 7) 冲突：这一轮新建且仍未修复的冲突 → 删除；这一轮修复掉的 → 重新打开 */
        if (eff.conflict_id) {
          const c = dbGet<{ id: number; status: string }>('SELECT * FROM conflict_logs WHERE id = ? AND user_id = ?', Number(eff.conflict_id), DEFAULT_USER_ID);
          if (c && c.status === 'open') {
            dbRun('DELETE FROM conflict_logs WHERE id = ? AND user_id = ?', c.id, DEFAULT_USER_ID);
            report.removed.conflicts += 1;
          }
        }
        const startAt = (() => {
          const um = eff.user_message_id
            ? dbGet<{ created_at: string }>('SELECT created_at FROM messages WHERE id = ?', Number(eff.user_message_id))
            : null;
          return um?.created_at || eff.created_at;
        })();
        const { changes: reopened } = dbRun(
          "UPDATE conflict_logs SET status = 'open', resolved_at = NULL WHERE user_id = ? AND status = 'repaired' AND resolved_at >= ? AND resolved_at <= ?",
          DEFAULT_USER_ID,
          startAt,
          eff.created_at
        );
        if (reopened > 0) report.notes.push(`这一轮修复的 ${reopened} 个冲突已重新标记为未修复`);

        /* 8) 删除影响记录本身 */
        dbRun('DELETE FROM turn_effects WHERE id = ?', Number(eff.id));
      } else {
        report.notes.push('这一轮没有找到影响记录（可能是主动消息或很早之前的对话），只删除了消息');
      }

      /* 9) 主动消息记录 */
      const pDel = dbRun(
        `DELETE FROM proactive_messages WHERE user_id = ? AND message_id IN (${ph})`,
        DEFAULT_USER_ID,
        ...uniq
      );
      report.removed.proactive = pDel.changes;

      /* 10) 最后删除消息本身 */
      dbRun('DELETE FROM messages WHERE id = ? AND user_id = ?', id, DEFAULT_USER_ID);
    });

    report.ok = true;
    return report;
  } catch (e) {
    report.error = errMsg(e);
    return report;
  }
}

/**
 * 清空该用户全部聊天记录（设置页"清空聊天记录"用）
 * 一个事务内完成：清掉消息派生的内部审计数据（turn_effects / proactive_messages）、
 * 把其余业务表中指向消息的列置 NULL（记忆/流水等业务数据保留，用户可另行"清空记忆"），
 * 最后删除消息本身并重置自增序列——否则新消息会复用旧 id，让撤销/删除命中陈旧记录。
 */
export function wipeAllMessages(): void {
  tx(() => {
    // 1) 消息派生的内部审计数据：直接删除
    dbRun('DELETE FROM turn_effects WHERE user_id = ?', DEFAULT_USER_ID);
    dbRun('DELETE FROM proactive_messages WHERE user_id = ?', DEFAULT_USER_ID);

    // 2) 指向消息的列：置 NULL（保留业务数据本体）
    dbRun('UPDATE memories SET source_message_id = NULL WHERE user_id = ?', DEFAULT_USER_ID);
    dbRun('UPDATE personality_signals SET message_id = NULL WHERE user_id = ?', DEFAULT_USER_ID);
    dbRun('UPDATE personality_logs SET message_id = NULL WHERE user_id = ?', DEFAULT_USER_ID);
    dbRun('UPDATE attachment_signals SET message_id = NULL WHERE user_id = ?', DEFAULT_USER_ID);
    dbRun('UPDATE emotional_bank SET message_id = NULL WHERE user_id = ?', DEFAULT_USER_ID);
    dbRun('UPDATE relationship_logs SET message_id = NULL WHERE user_id = ?', DEFAULT_USER_ID);

    // 3) 删除消息本身
    dbRun('DELETE FROM messages WHERE user_id = ?', DEFAULT_USER_ID);

    // 4) 重置自增序列：sqlite_sequence 只在存在自增表时才有，缺表则忽略
    try {
      dbRun("DELETE FROM sqlite_sequence WHERE name = 'messages'");
    } catch {
      /* sqlite_sequence 不存在：忽略 */
    }
  });
}