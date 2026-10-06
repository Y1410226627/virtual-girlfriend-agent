// 调度钩子（T03 / T02 收尾 D3）：把「按伴侣私有命名空间的回合计数」与「每 PURSUIT_CHECK_EVERY 回合的攻略检查」串起来。
//
// 挂载点：分析完成后的应用阶段（analysis.ts → applyAnalysisResult 之后），是最小侵入的单点。
// 关键约束：
// - 回合计数**复用聊天引擎已维护的** ck('turn_count')（commitTurn 每轮 +1，见 engine.ts）。
//   这里只读不写——若在此再自增一个独立计数，会与引擎的 turn_count 双重计数，
//   导致"每 5 回合检查"实际变成每 ~2.5 回合就触发一次。
// - 计数落 companion 私有命名空间（见架构 §2.4）：主女友→'turn_count'，其它→'turn_count#c{id}'。
// - 单女友默认流程零行为变化：主女友 / 已晋升女友 / 已关闭的伴侣直接 no-op（不写任何计数、不改任何行）。
import { dbGet, getCounter } from './db';
import { cId, ck, withCompanion } from './companion-context';
import { checkAdvance, isPursuitActive, PURSUIT_CHECK_EVERY } from './pursuit';
import type { CompanionRow } from './types';

/** 复用的回合计数键（经 ck() 落到 'turn_count' 或 'turn_count#c{id}'，与 engine.commitTurn 同源） */
export const TURN_COUNTER = 'turn_count';

export interface PursuitTickResult {
  /** 本次是否真的跑了一次状态机检查 */
  ran: boolean;
  /** 该伴侣的私有回合计数（no-op 时为 0） */
  turn: number;
  /** 是否跳过（主女友 / 女友 / 已关闭 / 无该伴侣） */
  skipped?: boolean;
  status?: string;
  from?: string;
  to?: string;
}

/**
 * 回合提交钩子：读取该伴侣的私有回合数，每 PURSUIT_CHECK_EVERY 回合跑一次攻略检查。
 * 任何异常都被吞掉——攻略检查绝不能影响聊天/分析主流程。
 * @param companionId 目标伴侣；缺省取当前上下文（cId()）
 */
export function noteTurnAndMaybeCheck(companionId?: number): PursuitTickResult {
  const target =
    typeof companionId === 'number' && Number.isFinite(companionId) && companionId > 0 ? Math.trunc(companionId) : cId();
  try {
    const row = dbGet<CompanionRow>('SELECT * FROM companions WHERE id = ?', target);
    // 主女友 / 已晋升女友 / 已关闭 / 非攻略中状态：no-op（零写库，保证单女友流程零变化）
    if (!row || Number(row.is_primary) === 1 || !isPursuitActive(row.status)) {
      return { ran: false, turn: 0, skipped: true, status: row?.status };
    }
    return withCompanion(target, () => {
      // 只读引擎维护的回合计数；turn<=0 时不触发（避免把"尚未开聊"误判成第 5 轮）
      const turn = getCounter(ck(TURN_COUNTER));
      if (turn <= 0 || turn % PURSUIT_CHECK_EVERY !== 0) {
        return { ran: false, turn, status: row.status };
      }
      const res = checkAdvance(target, turn);
      const status = res?.status ?? row.status;
      return { ran: true, turn, from: res?.from ?? row.status, to: status, status };
    });
  } catch {
    return { ran: false, turn: 0, skipped: true };
  }
}
