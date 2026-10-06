// 情感银行账户系统（基于 Gottman 关系研究）
// 每段互动都是一次情感存款或情感取款：情感余额 / 修复信用 / 未解决张力
import { tx, DEFAULT_USER_ID, cRun, cGet, cAll } from './db';
import { clamp, nowIso, round1 } from './utils';
import { getRelationshipState, saveRelationshipState, logRelationship } from './relationship';

export interface BankEntry {
  id: number;
  user_id: number;
  message_id: number | null;
  delta: number;
  kind: string;
  behavior: string | null;
  reason: string | null;
  balance_after: number;
  created_at: string;
}

/**
 * 唯一的余额记账点：改余额 + 写流水，两步一个事务（账实一致）。
 * 注意：relationship.applyRelationshipDelta 不再改余额，避免同一笔 delta 被记两次。
 */
export function addBankEntry(
  delta: number,
  behavior: string,
  reason: string,
  messageId?: number | null
): number {
  const s = getRelationshipState();
  const before = s.emotional_balance;
  const newBalance = clamp(before + delta, -100, 100);
  s.emotional_balance = newBalance;
  tx(() => {
    saveRelationshipState(s);
    // companion_id 写在最前，由 cRun 注入 cId()；user_id 是全局用户引用（恒为 1），非隔离键
    cRun(
      `INSERT INTO emotional_bank (companion_id, user_id, message_id, delta, kind, behavior, reason, balance_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      DEFAULT_USER_ID,
      messageId ?? null,
      round1(delta),
      delta >= 0 ? 'deposit' : 'withdrawal',
      behavior,
      reason,
      round1(newBalance),
      nowIso()
    );
  });
  if (round1(before) !== round1(newBalance)) {
    logRelationship('bank', `情感余额 ${round1(before)} → ${round1(newBalance)}`, before, newBalance, reason);
  }
  return newBalance;
}

export function listBankEntries(limit = 60): BankEntry[] {
  return cAll<BankEntry>(
    'SELECT * FROM emotional_bank WHERE companion_id = ? ORDER BY id DESC LIMIT ?',
    limit
  );
}

export function bankStats() {
  const row = cGet<{ deposits: number; withdrawals: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS deposits,
       COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS withdrawals
     FROM emotional_bank WHERE companion_id = ?`
  );
  return { deposits: round1(row?.deposits || 0), withdrawals: round1(row?.withdrawals || 0) };
}

/** 情感余额如何影响她的行为（注入 Prompt） */
export function bankEffectGuide(balance: number): string {
  if (balance > 50) return '你们的情感账户很充盈：你可以更主动、更甜、更愿意表达爱意和撒娇。';
  if (balance > 30) return '情感账户是正向的：你更愿意主动表达在意、撒娇和分享。';
  if (balance >= -20) return '情感账户大致平衡：自然互动，不需要刻意加甜。';
  if (balance >= -50) return '情感账户有些透支：你更谨慎、更多观察，可以表达一点被忽略的失落，但别上纲上线。';
  return '情感账户严重透支：你进入"低潮"，回复变短、减少主动、情绪偏冷，需要他认真对你好才会缓过来。';
}

/** 未解决张力如何影响她的行为（注入 Prompt） */
export function tensionEffectGuide(tension: number, conflictState: string): string {
  if (conflictState === 'cold_war' || tension > 80) {
    return `你们正处于冷战状态（张力 ${round1(tension)}）：你回复很短、明显冷淡，不主动找话题，但心里其实在等他先低头。`;
  }
  if (tension > 50) {
    return `你心里憋着情绪（张力 ${round1(tension)}）：你可能语气变冷、回复变短，或者直接说"我们聊聊好不好"。`;
  }
  if (tension > 20) {
    return `你心里有一点没过去的小情绪（张力 ${round1(tension)}）：可以在合适的时候温和地提一句，或者有点小别扭、小委屈。`;
  }
  return '';
}

/** 修复信用如何影响她的行为（注入 Prompt） */
export function repairCreditGuide(credit: number): string {
  if (credit >= 60) return '你们有很好的修复经验：即使吵架，你也相信最后会和好，所以你敢表达真实的不满。';
  if (credit >= 30) return '你们修复过几次矛盾：你对"吵完还能好"有一定信心。';
  if (credit > 0) return '你们修复经验不多：吵架后你会有点不安，需要他给一点确定的回应。';
  return '你们几乎没有修复经验：冲突后你会不安、容易胡思乱想。';
}