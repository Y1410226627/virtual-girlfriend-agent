// 动态性格系统：累积层 → 确认层 → 固化层 三层机制
// 关键原则：绝不在每轮对话里直接改性格。
// 读取层与周快照已拆至 personality-core.ts / personality-snapshots.ts，本文件保留原有导出面。
import { dbRun, DEFAULT_USER_ID, getCounter, setCounter, numSetting, customModeOn, tx, cAll, cRun } from './db';
import { cId } from './companion-context';
import { clamp, nowIso, round1 } from './utils';
import { stageOf } from './stages';
import { getRelationshipState, logRelationship } from './relationship';
import { DIMENSION_ALIASES, type PersonalitySignal } from './types';
import { DIMENSION_KEYS, dimensionLabel, getPersonalityRows, consumeSignals, currentAttachmentStyle, unsolidify } from './personality-core';
import { saveWeeklySnapshot } from './personality-snapshots';
import { resolveSourceTurns } from './turnOps';

// 原 personality.ts 的导出面（读取层 + 快照，行为不变）
export {
  DIMENSION_KEYS,
  dimensionLabel,
  getPersonalityRows,
  personalityMap,
  personalityPromptBlock,
  unsolidify,
  manualAdjust,
  listPersonalityLogs,
  evolutionSeries,
} from './personality-core';
export type { PersonalityRow, PersonalityLogRow } from './personality-core';
export { saveWeeklySnapshot, listSnapshots, rollbackToSnapshot } from './personality-snapshots';
export type { PersonalitySnapshotRow } from './personality-snapshots';

/** personality_signals 里做统计 / 归因用到的列 */
interface SignalRow {
  id: number;
  /** 产生该信号的 assistant 消息 id（P1-39/40 归因来源回合用） */
  message_id: number | null;
  strength: number | null;
  weight: number | null;
  context: string | null;
}

/* ---------------------- 第一层：累积 ---------------------- */
/** 只记录信号，不直接改性格 */
export function addSignals(signals: PersonalitySignal[], messageId?: number | null): number {
  if (!signals || !signals.length) return 0;
  let n = 0;
  for (const sig of signals) {
    const dim = DIMENSION_ALIASES[String(sig.dimension || '').trim()] || DIMENSION_ALIASES[String(sig.dimension || '').trim().toLowerCase()];
    if (!dim) continue;
    const direction = String(sig.direction || '+').startsWith('-') ? '-' : '+';
    const strength = clamp(Number(sig.strength) || 0.5, 0, 1);
    // 用户明确反馈（"我喜欢你这样"/"别这样"）权重 3
    const weight = sig.is_direct_feedback ? 3 : 1;
    cRun(
      `INSERT INTO personality_signals (companion_id, user_id, message_id, dimension, direction, strength, weight, context, reasoning, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      DEFAULT_USER_ID,
      messageId ?? null,
      dim,
      direction,
      strength,
      weight,
      String(sig.context || '未知情境').slice(0, 120),
      sig.reasoning ? String(sig.reasoning).slice(0, 300) : null,
      nowIso()
    );
    n++;
  }
  return n;
}

export interface SignalProgress {
  dimension: string;
  label: string;
  direction: '+' | '-';
  weightedCount: number;
  contexts: number;
  avgStrength: number;
  thresholdCount: number;
  thresholdContexts: number;
  ready: boolean;
  /** 冷却中还要等几轮才能真正调整（0 = 不冷却） */
  cooldownTurns: number;
}

function confirmThresholds() {
  const openness = clamp(numSetting('personality_openness', 1), 0, 2);
  const count = openness <= 0 ? 999 : Math.max(2, Math.round(5 / openness));
  return { count, contexts: 3, minStrength: 0.5, openness };
}

/** 展示累积层的当前进度（前端"性格页"用） */
export function signalProgress(): SignalProgress[] {
  const th = confirmThresholds();
  const turn = getCounter('turn_count');
  const stage = stageOf(getRelationshipState().stage);
  const rows0 = getPersonalityRows();
  // 循环外读一次建 Map，避免每个维度都全表扫一遍
  const rowMap = new Map(rows0.map((r) => [r.dimension, r]));
  const out: SignalProgress[] = [];
  for (const dim of DIMENSION_KEYS) {
    const row = rowMap.get(dim);
    const rateTurns = row?.solidified ? 30 : stage.changeRateTurns;
    const cooldownTurns = row ? Math.max(0, rateTurns - (turn - Number(row.last_adjusted_turn || 0))) : 0;
    for (const direction of ['+', '-'] as const) {
      const rows = cAll<SignalRow>(
        `SELECT strength, weight, context FROM personality_signals
         WHERE companion_id = ? AND dimension = ? AND direction = ? AND consumed = 0`,
        dim,
        direction
      );
      const weighted = rows.reduce((s, r) => s + Number(r.weight || 1), 0);
      const contexts = new Set(rows.map((r) => String(r.context || ''))).size;
      const avg = rows.length ? rows.reduce((s, r) => s + Number(r.strength || 0), 0) / rows.length : 0;
      const meetThreshold = weighted >= th.count && contexts >= th.contexts && avg >= th.minStrength;
      out.push({
        dimension: dim,
        label: dimensionLabel(dim),
        direction,
        weightedCount: round1(weighted),
        contexts,
        avgStrength: round1(avg * 100) / 100,
        thresholdCount: th.count,
        thresholdContexts: th.contexts,
        // 阈值 + 冷却都过了才算"下一轮会调整"（原来看不到冷却，前端会误报）
        ready: meetThreshold && cooldownTurns <= 0,
        cooldownTurns,
      });
    }
  }
  return out;
}

/* ---------------------- 第二层：确认 ---------------------- */
/**
 * 同一方向的信号在"不同情境"下累积达到阈值（默认 5 次）才触发微调（±1）。
 * 必须：情境多样 + 方向一致 + 强度足够。
 */
export function runConfirmLayer(messageId?: number | null): void {
  // 自定义模式：性格由用户直控，不做自动微调
  if (customModeOn()) return;
  const th = confirmThresholds();
  if (th.openness <= 0) return;

  const stage = stageOf(getRelationshipState().stage);
  const turn = getCounter('turn_count');
  // 循环外读一次建 Map，避免每个维度都全表扫一遍
  const rowMap = new Map(getPersonalityRows().map((r) => [r.dimension, r]));

  for (const dim of DIMENSION_KEYS) {
    const row = rowMap.get(dim);
    if (!row) continue;

    const rateTurns = row.solidified ? 30 : stage.changeRateTurns;
    if (turn - Number(row.last_adjusted_turn || 0) < rateTurns) continue; // 变化速率限制

    // 固化不是"长死"：反向信号攒到 1.5 倍阈值时自动解除固化，让长期陪伴下性格还能回退
    if (row.solidified) {
      const oppDir = Number(row.value) >= 50 ? '-' : '+';
      const oppRows = cAll<SignalRow>(
        `SELECT * FROM personality_signals WHERE companion_id = ? AND dimension = ? AND direction = ? AND consumed = 0`,
        dim,
        oppDir
      );
      const oppW = oppRows.reduce((s, r) => s + Number(r.weight || 1), 0);
      const oppCtx = new Set(oppRows.map((r) => String(r.context || ''))).size;
      if (oppW >= th.count * 1.5 && oppCtx >= th.contexts) {
        unsolidify(dim);
        logRelationship('milestone', `「${dimensionLabel(dim)}」的反向信号持续累积，解除半固化`, null, dim, '性格自动回归');
      }
    }

    const pos = cAll<SignalRow>(
      `SELECT * FROM personality_signals WHERE companion_id = ? AND dimension = ? AND direction = '+' AND consumed = 0`,
      dim
    );
    const neg = cAll<SignalRow>(
      `SELECT * FROM personality_signals WHERE companion_id = ? AND dimension = ? AND direction = '-' AND consumed = 0`,
      dim
    );

    const stat = (rows: SignalRow[]) => ({
      weighted: rows.reduce((s, r) => s + Number(r.weight || 1), 0),
      contexts: new Set(rows.map((r) => String(r.context || ''))).size,
      avg: rows.length ? rows.reduce((s, r) => s + Number(r.strength || 0), 0) / rows.length : 0,
    });
    const p = stat(pos);
    const n = stat(neg);

    const pass = (x: typeof p) => x.weighted >= th.count && x.contexts >= th.contexts && x.avg >= th.minStrength;

    // 混合信号：清掉净强度较弱的一侧，然后继续按多数派判定
    // （原实现消解后直接 continue，多数派达标也不调整；两侧相等时两边都不清 → 永久死锁）
    if (p.weighted > 0 && n.weighted > 0) {
      const pPower = p.weighted * p.avg;
      const nPower = n.weighted * n.avg;
      if (pPower >= nPower) consumeSignals(dim, '-');
      else consumeSignals(dim, '+');
      // 消解后重新取信号再判定
      pos.length = 0;
      pos.push(
        ...cAll<SignalRow>(
          `SELECT * FROM personality_signals WHERE companion_id = ? AND dimension = ? AND direction = '+' AND consumed = 0`,
          dim
        )
      );
      neg.length = 0;
      neg.push(
        ...cAll<SignalRow>(
          `SELECT * FROM personality_signals WHERE companion_id = ? AND dimension = ? AND direction = '-' AND consumed = 0`,
          dim
        )
      );
      Object.assign(p, stat(pos));
      Object.assign(n, stat(neg));
    }

    const direction: '+' | '-' | null = pass(p) && p.weighted > 0 ? '+' : pass(n) && n.weighted > 0 ? '-' : null;
    if (!direction) continue;

    const delta = direction === '+' ? 1 : -1;
    const oldValue = Number(row.value);
    const newValue = clamp(oldValue + delta, 0, 100);
    if (newValue === oldValue) {
      consumeSignals(dim, direction);
      continue;
    }

    const ctxSamples = cAll<{ context: string | null }>(
      `SELECT context FROM personality_signals WHERE companion_id = ? AND dimension = ? AND direction = ? AND consumed = 0 LIMIT 3`,
      dim,
      direction
    )
      .map((r) => r.context)
      .join('；');

    // P1-39/40：记录这次微调实际来自哪些回合 / 哪些信号。
    // 被消费信号的 message_id → assistant 消息 → message_generations.turn_id（映射不到则 NULL）；
    // 供 turnOps 回滚时判断"多源累积"，避免删除单条消息就误回滚跨回合的变化。
    const consumedGroup = direction === '+' ? pos : neg;
    const sourceTurns = resolveSourceTurns(consumedGroup.map((r) => r.message_id));
    const contributingSignalIds = consumedGroup.map((r) => Number(r.id)).filter((x) => x > 0);
    const sourceTurnsJson = sourceTurns.length ? JSON.stringify(sourceTurns) : null;
    const contributingJson = contributingSignalIds.length ? JSON.stringify(contributingSignalIds) : null;

    tx(() => {
      dbRun(
        'UPDATE personality_state SET value = ?, last_adjusted_turn = ?, updated_at = ? WHERE companion_id = ? AND dimension = ?',
        newValue,
        turn,
        nowIso(),
        cId(),
        dim
      );
      cRun(
        `INSERT INTO personality_logs (companion_id, user_id, message_id, dimension, old_value, new_value, delta, signal_context, reasoning, stage_at_time, attachment_at_time, layer, source_turns, contributing_signal_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirm', ?, ?, ?)`,
        DEFAULT_USER_ID,
        messageId ?? null,
        dim,
        oldValue,
        newValue,
        delta,
        ctxSamples,
        `${th.count} 个不同情境下的同向信号累积达到阈值（加权 ${round1(
          direction === '+' ? p.weighted : n.weighted
        )}，情境 ${direction === '+' ? p.contexts : n.contexts} 个），触发 ±1 微调`,
        getRelationshipState().stage,
        currentAttachmentStyle(),
        sourceTurnsJson,
        contributingJson,
        nowIso()
      );
      consumeSignals(dim, direction);
    });

    bumpSolidifyStreak(dim, direction);
    saveWeeklySnapshot();
  }
}

/* ---------------------- 第三层：固化 ---------------------- */
/** 连续 15 次同方向确认 → 半固化，变化速率降到每 30 轮 ±1 */
function bumpSolidifyStreak(dim: string, direction: '+' | '-') {
  const key = `solidify_streak_${dim}`;
  const prev = getCounter(key); // 带符号：正数代表连续 "+" 次数
  const sameDir = (prev > 0 && direction === '+') || (prev < 0 && direction === '-');
  const next = sameDir ? prev + (direction === '+' ? 1 : -1) : direction === '+' ? 1 : -1;
  setCounter(key, next);

  if (Math.abs(next) >= 15) {
    const row = getPersonalityRows().find((r) => r.dimension === dim);
    if (row && !row.solidified) {
      dbRun(
        'UPDATE personality_state SET solidified = 1, updated_at = ? WHERE companion_id = ? AND dimension = ?',
        nowIso(),
        cId(),
        dim
      );
      cRun(
        `INSERT INTO personality_logs (companion_id, user_id, message_id, dimension, old_value, new_value, delta, signal_context, reasoning, stage_at_time, attachment_at_time, layer, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, 0, NULL, ?, ?, ?, 'solidify', ?)`,
        DEFAULT_USER_ID,
        dim,
        row.value,
        row.value,
        `连续 15 次同方向确认（${direction === '+' ? '增强' : '减弱'}），「${dimensionLabel(dim)}」进入半固化：之后每 30 轮最多变化 ±1`,
        getRelationshipState().stage,
        currentAttachmentStyle(),
        nowIso()
      );
    }
  }
}