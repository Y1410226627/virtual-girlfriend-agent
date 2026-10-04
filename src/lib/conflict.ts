// 冲突-修复机制：真实恋爱必然有冲突，不能只甜不吵
import { dbAll, dbRun, dbGet, DEFAULT_USER_ID } from './db';
import { clamp, nowIso, round1 } from './utils';
import { getRelationshipState, saveRelationshipState, logRelationship } from './relationship';
import { addBankEntry, tensionEffectGuide } from './emotionalBank';
import { attachmentStyleOf } from './types';

export type ConflictType = 'none' | 'minor' | 'major' | 'boundary';
export type RepairQuality = 'sincere' | 'sweet' | 'avoidant' | 'none';

export interface ConflictRow {
  id: number;
  user_id: number;
  type: string;
  status: string;
  description: string | null;
  tension_at_start: number | null;
  tension_after: number | null;
  repair_quality: string | null;
  started_at: string;
  resolved_at: string | null;
}

/** 冲突发生时：张力上升 + 记录冲突（未修复则持续挂起） */
export function registerConflict(type: ConflictType, description: string): void {
  const s = getRelationshipState();
  const tensionDelta = type === 'boundary' ? 15 : type === 'major' ? 12 : type === 'minor' ? 6 : 0;
  if (tensionDelta === 0 && type === 'none') return;

  s.unresolved_tension = clamp(s.unresolved_tension + tensionDelta, 0, 100);
  s.conflict_state = s.unresolved_tension > 80 ? 'cold_war' : 'tense';
  s.last_conflict_at = nowIso();
  if (s.unresolved_tension > 50) s.mood = '生气';
  else s.mood = '委屈';
  saveRelationshipState(s);

  dbRun(
    `INSERT INTO conflict_logs (user_id, type, status, description, tension_at_start, started_at)
     VALUES (?, ?, 'open', ?, ?, ?)`,
    DEFAULT_USER_ID,
    type,
    description,
    round1(s.unresolved_tension),
    nowIso()
  );

  // 冲突本身也是一次取款（问题的产生往往来自双方的忽视或越界）
  addBankEntry(-(type === 'boundary' ? 5 : type === 'major' ? 4 : 2), '冲突', description);
  logRelationship('conflict', `发生${type === 'boundary' ? '越界' : type === 'major' ? '严重' : '轻微'}冲突：${description}`, null, round1(s.unresolved_tension), '冲突检测');
}

/** 修复行为：张力下降 50-80%、修复信用 +5~10、情感余额 +5 */
export function registerRepair(quality: RepairQuality, description: string): void {
  const s = getRelationshipState();
  const before = s.unresolved_tension;

  const dropRatio = quality === 'sincere' ? 0.8 : quality === 'sweet' ? 0.65 : quality === 'avoidant' ? 0.5 : 0.3;
  const creditGain = quality === 'sincere' ? 10 : quality === 'sweet' ? 7 : quality === 'avoidant' ? 5 : 2;

  s.unresolved_tension = clamp(s.unresolved_tension * (1 - dropRatio), 0, 100);
  s.repair_credit = clamp(s.repair_credit + creditGain, 0, 100);
  if (s.unresolved_tension < 15) s.conflict_state = 'none';
  s.mood = '和好';
  saveRelationshipState(s);

  addBankEntry(5, '修复关系', description);
  logRelationship(
    'repair',
    `修复成功（质量：${quality === 'sincere' ? '真诚道歉' : quality === 'sweet' ? '撒娇蒙混' : quality === 'avoidant' ? '各自冷静后回归' : '勉强修复'}）：张力 ${round1(before)} → ${round1(s.unresolved_tension)}`,
    before,
    s.unresolved_tension,
    description
  );

  // 关闭最近的 open 冲突
  const open = dbGet<ConflictRow>(
    "SELECT * FROM conflict_logs WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
    DEFAULT_USER_ID
  );
  if (open) {
    dbRun(
      "UPDATE conflict_logs SET status = 'repaired', resolved_at = ?, tension_after = ?, repair_quality = ? WHERE id = ?",
      nowIso(),
      round1(s.unresolved_tension),
      quality,
      open.id
    );
  }
}

export function listConflicts(limit = 30): ConflictRow[] {
  return dbAll<ConflictRow>('SELECT * FROM conflict_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?', DEFAULT_USER_ID, limit);
}

export function openConflictCount(): number {
  const r = dbGet<{ c: number }>(
    "SELECT COUNT(*) AS c FROM conflict_logs WHERE user_id = ? AND status = 'open'",
    DEFAULT_USER_ID
  );
  return Number(r?.c || 0);
}

/** 事情过去了但一直没处理：张力自然衰减（很慢） */
export function fadeTension(delta = -1): void {
  const s = getRelationshipState();
  if (s.unresolved_tension <= 0) return;
  s.unresolved_tension = clamp(s.unresolved_tension + delta, 0, 100);
  if (s.unresolved_tension < 15 && s.conflict_state !== 'none') s.conflict_state = 'none';
  saveRelationshipState(s);
}

/**
 * 冲突反应方式 = 依恋风格 × 性格（直接性 / 情绪强度）
 * 注入 Prompt 的行为指导
 */
export function conflictBehaviorGuide(): string {
  const s = getRelationshipState();
  const a = dbGet<{ anxiety: number; avoidance: number }>(
    'SELECT anxiety, avoidance FROM attachment_state WHERE user_id = ?',
    DEFAULT_USER_ID
  );
  const style = attachmentStyleOf(Number(a?.anxiety ?? 30), Number(a?.avoidance ?? 30));
  const base = tensionEffectGuide(s.unresolved_tension, s.conflict_state);
  if (!base) return '';

  const styleGuide: Record<string, string> = {
    secure: '（安全型的你：可以平静地说出自己的感受，不攻击他、不翻旧账，也愿意听他解释，并主动往修复的方向走。）',
    anxious: '（焦虑型的你：会反复确认他是不是还爱你、是不是不在乎你了，可能追问、可能情绪上头，需要他明确安抚才能平复。）',
    avoidant: '（回避型的你：不想当场吵，会想缩回自己的空间、回复变少变慢，需要一点时间才愿意谈，但心里希望他能主动来找你。）',
    fearful: '（混乱型的你：一会儿想质问他、一会儿又想消失，行为不太一致，可能先刺他一句又后悔。）',
  };
  return base + ' ' + (styleGuide[style] || '');
}