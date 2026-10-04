// 动态性格系统：累积层 → 确认层 → 固化层 三层机制
// 关键原则：绝不在每轮对话里直接改性格。
import { dbAll, dbRun, dbGet, DEFAULT_USER_ID, getCounter, setCounter, bumpCounter, numSetting, tx, customModeOn } from './db';
import { clamp, nowIso, round1, localDateStr } from './utils';
import { stageOf } from './stages';
import { getRelationshipState, logRelationship } from './relationship';
import { attachmentStyleOf, DIMENSIONS, DIMENSION_ALIASES, type DimensionKey, type PersonalitySignal } from './types';

export const DIMENSION_KEYS: DimensionKey[] = DIMENSIONS.map((d) => d.key) as DimensionKey[];

export function dimensionLabel(key: string): string {
  return DIMENSIONS.find((d) => d.key === key)?.label || key;
}

export interface PersonalityRow {
  user_id: number;
  dimension: string;
  value: number;
  solidified: number;
  last_adjusted_turn: number;
  updated_at: string;
}

/* ---------------------- 读取 ---------------------- */
export function getPersonalityRows(): PersonalityRow[] {
  return dbAll<PersonalityRow>('SELECT * FROM personality_state WHERE user_id = ? ORDER BY rowid', DEFAULT_USER_ID);
}

export function personalityMap(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of DIMENSION_KEYS) out[key] = 50;
  for (const r of getPersonalityRows()) out[r.dimension] = round1(r.value);
  return out;
}

export function personalityPromptBlock(): string {
  const map = personalityMap();
  const rows = DIMENSION_KEYS.map((k) => `- ${dimensionLabel(k)}：${map[k]}`).join('\n');
  const hints: string[] = [];
  if (map.warmth >= 60) hints.push('温柔度高：你会主动关心他、照顾他的情绪、说话软。');
  if (map.warmth <= 40) hints.push('温柔度偏低：你表达关心更含蓄、更少用安慰性的套话。');
  if (map.playfulness >= 60) hints.push('俏皮度高：你爱开玩笑、爱逗他、爱用轻松的语气词和表情。');
  if (map.playfulness <= 40) hints.push('俏皮度偏低：你说话更认真、更少打闹调侃。');
  if (map.romance >= 60) hints.push('浪漫表达高：你会自然地说想他、说喜欢，会制造小惊喜和暧昧。');
  if (map.romance <= 40) hints.push('浪漫表达偏低：你不太主动说甜言蜜语，更偏向用行动和陪伴表达。');
  if (map.directness >= 60) hints.push('直接性高：你说话直球，想要什么、不满什么都会说出来（玩笑也是直球）。');
  if (map.directness <= 40) hints.push('直接性低：你含蓄，会用暗示、试探、撒娇式表达代替直接说。');
  if (map.independence >= 60) hints.push('独立性强：你有自己的生活和兴趣，不会频繁追问他的行踪，也会说"我在忙自己的事"。');
  if (map.independence <= 40) hints.push('独立性偏弱：你比较粘他，会主动找他、在意他回消息的速度。');
  if (map.emotional_intensity >= 60) hints.push('情绪强度高：你的开心委屈生气都很外放，会有明显的情绪起伏和语气词。');
  if (map.emotional_intensity <= 40) hints.push('情绪强度低：你情绪表达平静克制，不太会大起大落。');
  return `你的当前性格参数（0-100，会随相处慢慢变化）：\n${rows}\n${hints.join('\n')}`;
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
    dbRun(
      `INSERT INTO personality_signals (user_id, message_id, dimension, direction, strength, weight, context, reasoning, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      const rows = dbAll<any>(
        `SELECT strength, weight, context FROM personality_signals
         WHERE user_id = ? AND dimension = ? AND direction = ? AND consumed = 0`,
        DEFAULT_USER_ID,
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
      const oppRows = dbAll<any>(
        `SELECT * FROM personality_signals WHERE user_id = ? AND dimension = ? AND direction = ? AND consumed = 0`,
        DEFAULT_USER_ID,
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

    const pos = dbAll<any>(
      `SELECT * FROM personality_signals WHERE user_id = ? AND dimension = ? AND direction = '+' AND consumed = 0`,
      DEFAULT_USER_ID,
      dim
    );
    const neg = dbAll<any>(
      `SELECT * FROM personality_signals WHERE user_id = ? AND dimension = ? AND direction = '-' AND consumed = 0`,
      DEFAULT_USER_ID,
      dim
    );

    const stat = (rows: any[]) => ({
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
        ...dbAll<any>(
          `SELECT * FROM personality_signals WHERE user_id = ? AND dimension = ? AND direction = '+' AND consumed = 0`,
          DEFAULT_USER_ID,
          dim
        )
      );
      neg.length = 0;
      neg.push(
        ...dbAll<any>(
          `SELECT * FROM personality_signals WHERE user_id = ? AND dimension = ? AND direction = '-' AND consumed = 0`,
          DEFAULT_USER_ID,
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

    const ctxSamples = dbAll<any>(
      `SELECT context FROM personality_signals WHERE user_id = ? AND dimension = ? AND direction = ? AND consumed = 0 LIMIT 3`,
      DEFAULT_USER_ID,
      dim,
      direction
    )
      .map((r) => r.context)
      .join('；');

    tx(() => {
      dbRun(
        'UPDATE personality_state SET value = ?, last_adjusted_turn = ?, updated_at = ? WHERE user_id = ? AND dimension = ?',
        newValue,
        turn,
        nowIso(),
        DEFAULT_USER_ID,
        dim
      );
      dbRun(
        `INSERT INTO personality_logs (user_id, message_id, dimension, old_value, new_value, delta, signal_context, reasoning, stage_at_time, attachment_at_time, layer, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirm', ?)`,
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
        nowIso()
      );
      consumeSignals(dim, direction);
    });

    bumpSolidifyStreak(dim, direction);
    saveWeeklySnapshot();
  }
}

function consumeSignals(dim: string, direction: string) {
  dbRun(
    'UPDATE personality_signals SET consumed = 1 WHERE user_id = ? AND dimension = ? AND direction = ? AND consumed = 0',
    DEFAULT_USER_ID,
    dim,
    direction
  );
}

function currentAttachmentStyle(): string {
  const a = dbGet<{ anxiety: number; avoidance: number }>(
    'SELECT anxiety, avoidance FROM attachment_state WHERE user_id = ?',
    DEFAULT_USER_ID
  );
  return attachmentStyleOf(Number(a?.anxiety ?? 30), Number(a?.avoidance ?? 30));
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
        'UPDATE personality_state SET solidified = 1, updated_at = ? WHERE user_id = ? AND dimension = ?',
        nowIso(),
        DEFAULT_USER_ID,
        dim
      );
      dbRun(
        `INSERT INTO personality_logs (user_id, message_id, dimension, old_value, new_value, delta, signal_context, reasoning, stage_at_time, attachment_at_time, layer, created_at)
         VALUES (?, NULL, ?, ?, ?, 0, NULL, ?, ?, ?, 'solidify', ?)`,
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

export function unsolidify(dim: string): void {
  dbRun(
    'UPDATE personality_state SET solidified = 0, updated_at = ? WHERE user_id = ? AND dimension = ?',
    nowIso(),
    DEFAULT_USER_ID,
    dim
  );
  setCounter(`solidify_streak_${dim}`, 0);
  dbRun(
    `INSERT INTO personality_logs (user_id, message_id, dimension, old_value, new_value, delta, signal_context, reasoning, stage_at_time, attachment_at_time, layer, created_at)
     SELECT ?, NULL, dimension, value, value, 0, NULL, '用户手动解除固化', ?, ?, 'manual', ? FROM personality_state WHERE user_id = ? AND dimension = ?`,
    DEFAULT_USER_ID,
    getRelationshipState().stage,
    currentAttachmentStyle(),
    nowIso(),
    DEFAULT_USER_ID,
    dim
  );
}

/* ---------------------- 手动微调 / 回滚 ---------------------- */
export function manualAdjust(dim: string, value: number, reason = '用户手动微调'): void {
  const row = getPersonalityRows().find((r) => r.dimension === dim);
  if (!row) return;
  const oldValue = Number(row.value);
  const newValue = clamp(value, 0, 100);
  dbRun(
    'UPDATE personality_state SET value = ?, updated_at = ? WHERE user_id = ? AND dimension = ?',
    newValue,
    nowIso(),
    DEFAULT_USER_ID,
    dim
  );
  dbRun(
    `INSERT INTO personality_logs (user_id, message_id, dimension, old_value, new_value, delta, signal_context, reasoning, stage_at_time, attachment_at_time, layer, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, 'manual', ?)`,
    DEFAULT_USER_ID,
    dim,
    oldValue,
    newValue,
    round1(newValue - oldValue),
    reason,
    getRelationshipState().stage,
    currentAttachmentStyle(),
    nowIso()
  );
}

export function listPersonalityLogs(limit = 100) {
  return dbAll<any>(
    'SELECT * FROM personality_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    DEFAULT_USER_ID,
    limit
  );
}

/** 每个维度的演化曲线数据 */
export function evolutionSeries() {
  const logs = dbAll<any>(
    'SELECT dimension, old_value, new_value, created_at FROM personality_logs WHERE user_id = ? ORDER BY id ASC',
    DEFAULT_USER_ID
  );
  const series: Record<string, { t: string; v: number }[]> = {};
  for (const dim of DIMENSION_KEYS) series[dim] = [];
  for (const l of logs) {
    if (!series[l.dimension]) continue;
    series[l.dimension].push({ t: l.created_at, v: Number(l.new_value) });
  }
  return series;
}

/* ---------------------- 周快照 ---------------------- */
function weekKey(d = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function saveWeeklySnapshot(): void {
  const week = weekKey();
  // 同一周存在则更新（UPSERT），保证周内多次调整后快照反映最新状态
  dbRun(
    `INSERT INTO personality_snapshots (user_id, week, values_json, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, week) DO UPDATE SET values_json = excluded.values_json`,
    DEFAULT_USER_ID,
    week,
    JSON.stringify(personalityMap()),
    nowIso()
  );
}

export function listSnapshots(limit = 30) {
  return dbAll<any>(
    'SELECT * FROM personality_snapshots WHERE user_id = ? ORDER BY week DESC LIMIT ?',
    DEFAULT_USER_ID,
    limit
  );
}

export function rollbackToSnapshot(snapshotId: number): boolean {
  const snap = dbGet<any>('SELECT * FROM personality_snapshots WHERE id = ? AND user_id = ?', snapshotId, DEFAULT_USER_ID);
  if (!snap) return false;
  const values = JSON.parse(snap.values_json) as Record<string, number>;
  for (const [dim, v] of Object.entries(values)) {
    manualAdjust(dim, Number(v), `回滚到 ${snap.week} 的性格快照`);
    // 回滚同时重置固化状态与变化速率计时，否则旧值上仍挂着"半固化"
    dbRun(
      'UPDATE personality_state SET solidified = 0, last_adjusted_turn = 0, updated_at = ? WHERE user_id = ? AND dimension = ?',
      nowIso(),
      DEFAULT_USER_ID,
      dim
    );
    setCounter(`solidify_streak_${dim}`, 0);
  }
  return true;
}