// 性格系统：读取层与公共辅助（供 personality.ts 与 personality-snapshots.ts 使用）
import { dbRun, DEFAULT_USER_ID, setCounter, cAll, cGet, cRun } from './db';
import { cId, ck } from './companion-context';
import { clamp, nowIso, round1 } from './utils';
import { getRelationshipState } from './relationship';
import { attachmentStyleOf, DIMENSIONS, type DimensionKey } from './types';

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

export interface PersonalityLogRow {
  id: number;
  user_id: number;
  message_id: number | null;
  dimension: string;
  old_value: number;
  new_value: number;
  delta: number;
  signal_context: string | null;
  reasoning: string | null;
  stage_at_time: number | null;
  attachment_at_time: string | null;
  layer: string;
  created_at: string;
}

/* ---------------------- 读取 ---------------------- */
export function getPersonalityRows(): PersonalityRow[] {
  return cAll<PersonalityRow>('SELECT * FROM personality_state WHERE companion_id = ? ORDER BY rowid');
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
  if (map.warmth! >= 60) hints.push('温柔度高：你会主动关心他、照顾他的情绪、说话软。');
  if (map.warmth! <= 40) hints.push('温柔度偏低：你表达关心更含蓄、更少用安慰性的套话。');
  if (map.playfulness! >= 60) hints.push('俏皮度高：你爱开玩笑、爱逗他、爱用轻松的语气词和表情。');
  if (map.playfulness! <= 40) hints.push('俏皮度偏低：你说话更认真、更少打闹调侃。');
  if (map.romance! >= 60) hints.push('浪漫表达高：你会自然地说想他、说喜欢，会制造小惊喜和暧昧。');
  if (map.romance! <= 40) hints.push('浪漫表达偏低：你不太主动说甜言蜜语，更偏向用行动和陪伴表达。');
  if (map.directness! >= 60) hints.push('直接性高：你说话直球，想要什么、不满什么都会说出来（玩笑也是直球）。');
  if (map.directness! <= 40) hints.push('直接性低：你含蓄，会用暗示、试探、撒娇式表达代替直接说。');
  if (map.independence! >= 60) hints.push('独立性强：你有自己的生活和兴趣，不会频繁追问他的行踪，也会说"我在忙自己的事"。');
  if (map.independence! <= 40) hints.push('独立性偏弱：你比较粘他，会主动找他、在意他回消息的速度。');
  if (map.emotional_intensity! >= 60) hints.push('情绪强度高：你的开心委屈生气都很外放，会有明显的情绪起伏和语气词。');
  if (map.emotional_intensity! <= 40) hints.push('情绪强度低：你情绪表达平静克制，不太会大起大落。');
  return `你的当前性格参数（0-100，会随相处慢慢变化）：\n${rows}\n${hints.join('\n')}`;
}

export function consumeSignals(dim: string, direction: string) {
  dbRun(
    'UPDATE personality_signals SET consumed = 1 WHERE companion_id = ? AND dimension = ? AND direction = ? AND consumed = 0',
    cId(),
    dim,
    direction
  );
}

export function currentAttachmentStyle(): string {
  const a = cGet<{ anxiety: number; avoidance: number }>(
    'SELECT anxiety, avoidance FROM attachment_state WHERE companion_id = ?'
  );
  return attachmentStyleOf(Number(a?.anxiety ?? 30), Number(a?.avoidance ?? 30));
}

export function unsolidify(dim: string): void {
  dbRun(
    'UPDATE personality_state SET solidified = 0, updated_at = ? WHERE companion_id = ? AND dimension = ?',
    nowIso(),
    cId(),
    dim
  );
  setCounter(ck(`solidify_streak_${dim}`), 0);
  cRun(
    `INSERT INTO personality_logs (companion_id, user_id, message_id, dimension, old_value, new_value, delta, signal_context, reasoning, stage_at_time, attachment_at_time, layer, created_at)
     SELECT ?, ?, NULL, dimension, value, value, 0, NULL, '用户手动解除固化', ?, ?, 'manual', ? FROM personality_state WHERE companion_id = ? AND dimension = ?`,
    DEFAULT_USER_ID,
    getRelationshipState().stage,
    currentAttachmentStyle(),
    nowIso(),
    cId(),
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
    'UPDATE personality_state SET value = ?, updated_at = ? WHERE companion_id = ? AND dimension = ?',
    newValue,
    nowIso(),
    cId(),
    dim
  );
  cRun(
    `INSERT INTO personality_logs (companion_id, user_id, message_id, dimension, old_value, new_value, delta, signal_context, reasoning, stage_at_time, attachment_at_time, layer, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, 'manual', ?)`,
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
  return cAll<PersonalityLogRow>(
    'SELECT * FROM personality_logs WHERE companion_id = ? ORDER BY id DESC LIMIT ?',
    limit
  );
}

/** 每个维度的演化曲线数据 */
export function evolutionSeries() {
  const logs = cAll<{ dimension: string; created_at: string; new_value: number }>(
    'SELECT dimension, old_value, new_value, created_at FROM personality_logs WHERE companion_id = ? ORDER BY id ASC'
  );
  const series: Record<string, { t: string; v: number }[]> = {};
  for (const dim of DIMENSION_KEYS) series[dim] = [];
  for (const l of logs) {
    if (!series[l.dimension]) continue;
    series[l.dimension]!.push({ t: l.created_at, v: Number(l.new_value) });
  }
  return series;
}