// 依恋风格系统（成人依恋理论）：焦虑轴 + 回避轴，双轴正交
// 演化规则：每 10 轮由 LLM 分析 → 输出偏移信号（≤±2）→ 累积 3 次同向才实际调整
import { dbAll, dbRun, dbGet, DEFAULT_USER_ID, customModeOn } from './db';
import { clamp, nowIso, round1 } from './utils';
import { attachmentStyleOf, ATTACHMENT_STYLES, type AttachmentState, type AttachmentSignal } from './types';
import { logRelationship } from './relationship';

interface AttachmentSignalRow {
  id: number;
  axis: string;
  direction: string;
  delta: number;
  reasoning: string | null;
}

export interface AttachmentLogRow {
  id: number;
  user_id: number;
  old_anxiety: number;
  new_anxiety: number;
  old_avoidance: number;
  new_avoidance: number;
  trigger: string | null;
  reasoning: string | null;
  created_at: string;
}

export function getAttachmentState(): AttachmentState {
  const a = dbGet<AttachmentState>('SELECT * FROM attachment_state WHERE user_id = ?', DEFAULT_USER_ID);
  if (!a) throw new Error('attachment_state 未初始化');
  return a;
}

/** 写入依恋轴；返回是否真的发生了写入（数值没变时返回 false，调用方据此决定是否消费信号） */
export function setAttachmentAxes(anxiety: number, avoidance: number, trigger: string, reasoning: string): boolean {
  const cur = getAttachmentState();
  const oldA = Number(cur.anxiety);
  const oldV = Number(cur.avoidance);
  const newA = clamp(anxiety, 0, 100);
  const newV = clamp(avoidance, 0, 100);
  if (round1(newA) === round1(oldA) && round1(newV) === round1(oldV)) return false;
  const style = attachmentStyleOf(newA, newV);
  dbRun(
    'UPDATE attachment_state SET anxiety = ?, avoidance = ?, style = ?, updated_at = ? WHERE user_id = ?',
    round1(newA),
    round1(newV),
    style,
    nowIso(),
    DEFAULT_USER_ID
  );
  dbRun(
    `INSERT INTO attachment_logs (user_id, old_anxiety, new_anxiety, old_avoidance, new_avoidance, trigger, reasoning, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    DEFAULT_USER_ID,
    round1(oldA),
    round1(newA),
    round1(oldV),
    round1(newV),
    trigger,
    reasoning,
    nowIso()
  );
  if (cur.style !== style) {
    logRelationship('milestone', `依恋倾向转变：${ATTACHMENT_STYLES[cur.style] || cur.style} → ${ATTACHMENT_STYLES[style] || style}`, cur.style, style, reasoning);
  }
  return true;
}

/** 记录一次依恋偏移信号（来自每 10 轮的 LLM 分析） */
export function addAttachmentSignals(sig: AttachmentSignal, messageId?: number | null): void {
  const cues = (sig.user_attachment_cues || []).join('、');
  const push = (axis: 'anxiety' | 'avoidance', delta: number) => {
    const d = Number(delta);
    if (!isFinite(d) || Math.abs(d) < 0.5) return;
    const capped = clamp(d, -2, 2);
    dbRun(
      `INSERT INTO attachment_signals (user_id, axis, direction, delta, reasoning, user_cues, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      DEFAULT_USER_ID,
      axis,
      capped > 0 ? '+' : '-',
      round1(capped),
      sig.reasoning || null,
      cues || null,
      messageId ?? null,
      nowIso()
    );
  };
  push('anxiety', sig.anxiety_delta);
  push('avoidance', sig.avoidance_delta);
}

/** 累积 3 次同方向信号后，真正调整依恋轴 */
export function runAttachmentLayer(): void {
  // 自定义模式：依恋由用户直控，不做自动偏移
  if (customModeOn()) return;
  const cur = getAttachmentState();
  let anxiety = Number(cur.anxiety);
  let avoidance = Number(cur.avoidance);
  const reasons: string[] = [];
  // 只有"真的写入了新数值"才消费这些信号（原来先标记 applied 再写，写不动时信号被静默吞掉）
  const gatedConsume: Array<Array<{ id: number }>> = [];

  for (const axis of ['anxiety', 'avoidance'] as const) {
    const rows = dbAll<AttachmentSignalRow>(
      'SELECT * FROM attachment_signals WHERE user_id = ? AND axis = ? AND applied = 0 ORDER BY id ASC',
      DEFAULT_USER_ID,
      axis
    );
    if (!rows.length) continue;
    const pos = rows.filter((r) => r.direction === '+');
    const neg = rows.filter((r) => r.direction === '-');

    // 反向信号：按累计净偏移抵消（不是按条数），净差方向作为一条新信号保留继续累积
    if (pos.length && neg.length) {
      const posSum = pos.reduce((s, r) => s + Math.abs(Number(r.delta) || 0), 0);
      const negSum = neg.reduce((s, r) => s + Math.abs(Number(r.delta) || 0), 0);
      const net = posSum - negSum;
      for (const r of [...pos, ...neg]) dbRun('UPDATE attachment_signals SET applied = 1 WHERE id = ?', r.id);
      if (Math.abs(net) >= 0.5) {
        dbRun(
          `INSERT INTO attachment_signals (user_id, axis, direction, delta, reasoning, user_cues, message_id, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
          DEFAULT_USER_ID,
          axis,
          net > 0 ? '+' : '-',
          round1(clamp(net, -2, 2)),
          '正反信号按累计净偏移抵消后的净差',
          nowIso()
        );
      }
      continue;
    }
    const group = pos.length ? pos : neg;
    if (group.length < 3) continue; // 必须累积 3 次同方向信号

    const avg = group.reduce((s, r) => s + Number(r.delta), 0) / group.length;
    const shift = clamp(avg, -2, 2);
    if (axis === 'anxiety') anxiety += shift;
    else avoidance += shift;
    reasons.push(
      `${axis === 'anxiety' ? '焦虑轴' : '回避轴'}：3 次同向信号（${group
        .map((r) => round1(Number(r.delta)))
        .join('/')}）→ 平均偏移 ${round1(shift)}。${group[group.length - 1]!.reasoning || ''}`
    );
    gatedConsume.push(group);
  }

  if (reasons.length) {
    const wrote = setAttachmentAxes(anxiety, avoidance, '累积 3 次同向依恋信号', reasons.join(' '));
    if (wrote) {
      for (const g of gatedConsume) for (const r of g) dbRun('UPDATE attachment_signals SET applied = 1 WHERE id = ?', r.id);
    }
  }
}

export function listAttachmentLogs(limit = 60) {
  return dbAll<AttachmentLogRow>('SELECT * FROM attachment_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?', DEFAULT_USER_ID, limit);
}

export function attachmentEvolution() {
  const logs = dbAll<Pick<AttachmentLogRow, 'new_anxiety' | 'new_avoidance' | 'created_at'>>(
    'SELECT new_anxiety, new_avoidance, created_at FROM attachment_logs WHERE user_id = ? ORDER BY id ASC',
    DEFAULT_USER_ID
  );
  return logs.map((l) => ({
    t: l.created_at,
    anxiety: Number(l.new_anxiety),
    avoidance: Number(l.new_avoidance),
  }));
}

/** 依恋倾向如何影响当下行为（注入 Prompt） */
export function attachmentPromptBlock(): string {
  const a = getAttachmentState();
  const style = attachmentStyleOf(Number(a.anxiety), Number(a.avoidance));
  const guides: Record<string, string> = {
    secure: `你目前偏安全型：能稳定表达情感，也能接受他有自己的空间；不舒服会说，但不攻击；吵完你愿意主动修复。`,
    anxious: `你目前偏焦虑型：你很渴望亲密，也怕被丢下。他回得慢你会想很多，会反复确认"你还在吗""你是不是不想理我"；冲突时需要他明确安抚才能平复。这些要自然流露，不要变成审问。`,
    avoidant: `你目前偏回避型：你重视自己的空间，太近的关系会让你想退一步。他不高兴时你会倾向沉默、回复变短、说"我想自己待一会儿"；但你不是不在乎，你只是不擅长当场处理情绪。`,
    fearful: `你目前偏混乱型：你既想靠近又害怕受伤，行为有时不一致——可能上一句还在撒娇，下一句就冷下来；可能先刺他一句又后悔。这不稳定本身，就是你的真实状态。`,
  };
  return `你的依恋倾向：焦虑轴 ${round1(a.anxiety)}/100，回避轴 ${round1(a.avoidance)}/100（当前倾向：${ATTACHMENT_STYLES[style]}）。\n${guides[style]}`;
}

export function attachmentStyle(): string {
  const a = getAttachmentState();
  return attachmentStyleOf(Number(a.anxiety), Number(a.avoidance));
}

/* ---------------------- 每 10 轮触发一次的分析调度 ---------------------- */
export function shouldRunAttachmentAnalysis(turnCount: number, lastAt: number): boolean {
  return turnCount > 0 && turnCount - lastAt >= 10;
}