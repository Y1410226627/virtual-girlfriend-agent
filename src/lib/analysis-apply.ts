// 分析管线的「应用阶段」子模块（从 analysis.ts 拆出）：
// 把一轮分析结果的全部本地写入包进一个事务（P0-07 原子化），并把每处真实变化写入操作账本（P0-08）。
// 依赖方向：analysis.ts → analysis-apply.ts（单向，无环）。
import { dbRun, tx, DEFAULT_USER_ID, setCounter, getSetting, cAll, cGet, cRun } from './db';
import { ck } from './companion-context';
import { clamp, nowIso, round1, errMsg } from './utils';
import { applyRelationshipDelta, checkStageTransition, getRelationshipState, saveRelationshipState, logRelationship, saveAffectState } from './relationship';
import { addBankEntry } from './emotionalBank';
import { registerConflict, registerRepair } from './conflict';
import { addSignals, runConfirmLayer, saveWeeklySnapshot } from './personality';
import { addAttachmentSignals, runAttachmentLayer } from './attachment';
import {
  applyLifeDeltas,
  applyLocationChange,
  applyActivityChange,
  addDailyEvent,
  addSharedPlan,
  addSharedRitual,
  addSharedPlace,
  addSharedItem,
  revealProfileFields,
  revealPreferences,
  applyCareEvent,
  applyInteractionEffects,
} from './life';
import { applyIntimacyDelta, startAftercare } from './intimacy';
import { recordOperation } from './turnOps';
import {
  parseBool,
  pickEnum,
  num,
  snapshotForUndo,
  maxId,
  type RawAnalysis,
  type RawLocationChange,
  type RawActivityChange,
  type RawDailyEvent,
  type RawSharedWorldUpdate,
  type RawAttachmentAnalysis,
  type NormalizedAnalysis,
} from './analysis-parse';
import type { AttachmentSignal } from './types';

/** 用户明确表达"喜欢/不喜欢这样的我"的句式（规则兜底，权重 3 倍）
 *  收紧：只认指向"她这个人/她的说话方式"的明确反馈，避免"说得好/别那么"这类泛化词一命中就把整轮信号 ×3 */
const STRONG_FEEDBACK_RE =
  /(我喜欢你(这样|这样说|这样说话|这样回|这么)|我就喜欢你这样|别这样|不要这样|不要再这样|你好烦|好烦你|我讨厌你(这样|这样说|这么)|我不喜欢(你)?这样|继续这样|(再|更|要)温柔一点|(再|更|要)主动一点|别那么(凶|冷|敷衍)|你能不能别)/;

/** 应用阶段需要回写的副作用标记（结构上与 AnalyzeOutcome.applied 兼容，避免与 analysis.ts 形成类型环） */
export interface ApplyOutcome {
  applied: {
    memories: number;
    personalitySignals: number;
    conflict: boolean;
    repaired: boolean;
    stageChanged: boolean;
    attachmentAnalyzed: boolean;
    life?: boolean;
    aftercare?: boolean;
  };
}

/** shared_world 单行快照（供操作账本记录 / 反向） */
function sharedWorldSnapshot() {
  const r = cGet<{
    shared_places_json: string | null;
    shared_plans_json: string | null;
    shared_rituals_json: string | null;
    shared_items_json: string | null;
    cast_json: string | null;
  }>('SELECT shared_places_json, shared_plans_json, shared_rituals_json, shared_items_json, cast_json FROM shared_world WHERE companion_id = ?');
  return {
    shared_places_json: r?.shared_places_json ?? null,
    shared_plans_json: r?.shared_plans_json ?? null,
    shared_rituals_json: r?.shared_rituals_json ?? null,
    shared_items_json: r?.shared_items_json ?? null,
    cast_json: r?.cast_json ?? null,
  };
}

/** 应用阶段所需上下文（网络阶段算好后传入；应用阶段本身不再发起任何网络调用） */
export interface ApplyAnalysisContext {
  turn: number;
  custom: boolean;
  userMessage: string;
  userMessageId: number | null;
  assistantMessageId: number | null;
  turnId: number | null;
  generationId: number | null;
  /** 本轮应用前的关系快照 */
  before: ReturnType<typeof snapshotForUndo>;
  /** 是否需要跑依恋分析窗口 */
  attShouldRun: boolean;
  /** 依恋分析结果（网络已前置算好） */
  attRaw: RawAttachmentAnalysis | null;
}

/**
 * 应用阶段：把一轮分析结果的全部本地写入包进一个事务（P0-07）。
 * 内部严禁出现 await（网络调用已在 analyzeTurn 的网络阶段完成）——
 * 任何一处抛错都会让关系 / 银行 / 冲突 / 性格 / 依恋 / 生活等一并回滚，不留半份。
 * 同时把每处真实变化写入操作账本（P0-08），供删除 / 重新生成时精确反向。
 */
export function applyAnalysisResult(
  raw: RawAnalysis,
  result: NormalizedAnalysis,
  ctx: ApplyAnalysisContext,
  outcome: ApplyOutcome
): void {
  const { turn, custom, assistantMessageId, before } = ctx;
  const led = { turnId: ctx.turnId, generationId: ctx.generationId };
  const tensionBefore = Number(before.tension);

  // P1-01：冲突 / 修复由代码路径处理时，把模型给出的对应增量置零，避免同一轮重复计算。
  //   - registerConflict 自己 +6/12/15 张力；registerRepair 自己按质量降张力并加修复信用。
  //   - doConflict 会先抬张力（类型非 none 时 +6 起），因此 doRepair 的预测与实际一致（张力必 >5）。
  //   - 若 repair_attempt 但张力≤5（不会走 registerRepair），保留模型 repair_credit_delta。
  const doConflict = !custom && result.conflict_detected && result.conflict_type !== 'none';
  const doRepair = !custom && result.repair_attempt && (tensionBefore > 5 || doConflict);
  const deltaForApply = { ...result.relationship_delta };
  if (doConflict || doRepair) deltaForApply.unresolved_tension_delta = 0;
  if (doRepair) deltaForApply.repair_credit_delta = 0;

  tx(() => {
    // 账本基线（应用前）
    const bankMaxBefore = maxId('emotional_bank');
    const plogMaxBefore = maxId('personality_logs');
    const attLogFrom = maxId('attachment_logs');
    const dailyMaxBefore = maxId('agent_daily_events');
    const conflictMaxBefore = maxId('conflict_logs');
    const relLogFrom = maxId('relationship_logs');
    const sharedBefore = sharedWorldSnapshot();

    // 2) 关系数值（自定义模式跳过：数值由用户直控）
    if (!custom) {
      applyRelationshipDelta(deltaForApply, `第 ${turn} 轮分析：${result.reasoning}`);
      if (assistantMessageId) {
        dbRun('UPDATE messages SET emotion = ? WHERE id = ?', result.relationship_delta.mood, assistantMessageId);
      }
      // 张力回落到安全区 → 清掉"想谈一谈"的标记
      if (getRelationshipState().unresolved_tension < 20) {
        const s2 = getRelationshipState();
        if (s2.pending_relationship_talk) {
          s2.pending_relationship_talk = 0;
          saveRelationshipState(s2);
        }
      }
    }

    // 2.5) 此刻情绪（P1-16）：与长期关系数值分家；自定义模式跳过（数值/情绪由用户直控）
    //   normalizeAffect 已保证 confidence≥0.3 且 primary 非空，否则 result.affect 为 null（不改动）
    if (!custom && result.affect) saveAffectState(result.affect);

    // 3) 情感银行显式记账（自定义模式跳过）
    if (!custom && Math.abs(result.relationship_delta.emotional_balance_delta) >= 1) {
      addBankEntry(
        result.relationship_delta.emotional_balance_delta,
        result.relationship_delta.emotional_balance_delta > 0 ? '正向互动' : '负向互动',
        result.reasoning || '本轮互动',
        assistantMessageId ?? null
      );
    }

    // 4) 冲突与修复（P1-02：顺序处理，同一轮可"先冲突后修复"；自定义模式跳过）
    if (doConflict) {
      registerConflict(result.conflict_type, result.reasoning || '本轮出现分歧');
      outcome.applied.conflict = true;
      const cid = maxId('conflict_logs');
      if (cid > conflictMaxBefore) {
        recordOperation({ ...led, operationType: 'conflict.create', targetTable: 'conflict_logs', targetId: cid, after: { type: result.conflict_type, description: result.reasoning || '' } });
      }
    }
    if (doRepair) {
      // 记录"修复前仍未解决"的冲突（含刚开的那条），修复会一次性结清它们
      const openBeforeRepair = cAll<{ id: number }>(
        "SELECT id FROM conflict_logs WHERE companion_id = ? AND status = 'open'"
      ).map((r) => Number(r.id));
      registerRepair(result.repair_quality || 'sweet', result.reasoning || '双方主动修复');
      outcome.applied.repaired = true;
      for (const cid of openBeforeRepair) {
        recordOperation({ ...led, operationType: 'conflict.repair', targetTable: 'conflict_logs', targetId: cid, meta: { quality: result.repair_quality } });
      }
    }

    // 5) 性格信号（只累积，不改性格；自定义模式不累积）
    if (!custom) {
      const directFeedback = STRONG_FEEDBACK_RE.test(ctx.userMessage || '');
      const signals = directFeedback
        ? result.personality_signals.map((s) => ({ ...s, is_direct_feedback: true }))
        : result.personality_signals;
      if (directFeedback && signals.length) {
        logRelationship('milestone', '收到明确反馈，本轮性格信号按 3 倍权重累积', null, null, ctx.userMessage.slice(0, 60));
      }
      outcome.applied.personalitySignals = addSignals(signals, assistantMessageId ?? null);
    }

    // 6) 依恋信号（单轮只记录明显信号；自定义模式不记录）
    if (!custom) {
      const strongAnxiety = Math.abs(result.attachment_signals.anxiety_delta) >= 1;
      const strongAvoidance = Math.abs(result.attachment_signals.avoidance_delta) >= 1;
      if (strongAnxiety || strongAvoidance) {
        addAttachmentSignals({
          anxiety_delta: result.attachment_signals.anxiety_delta,
          avoidance_delta: result.attachment_signals.avoidance_delta,
          reasoning: result.attachment_signals.reasoning,
          user_attachment_cues: result.attachment_signals.user_attachment_cues,
        }, assistantMessageId ?? null);
      }
    }

    // 7) 关系确认 → 阶段跃迁 / 或者检查是否到达跃迁条件（自定义模式跳过）
    if (!custom) {
      if (result.relationship_confirmation) {
        const before2 = getRelationshipState().stage;
        checkStageTransition(true, `第 ${turn} 轮发生了关系确认`);
        outcome.applied.stageChanged = getRelationshipState().stage !== before2;
      } else {
        checkStageTransition(false, `第 ${turn} 轮`);
      }

      // 关系对话标记
      const cur = getRelationshipState();
      if (result.next_relationship_talk && cur.unresolved_tension > 20) {
        cur.pending_relationship_talk = 1;
        saveRelationshipState(cur);
        logRelationship('milestone', '她决定找一个时机谈一谈悬而未决的事', null, null, result.reasoning);
      }
    }

    // 8) 场景校正（带上下文判断；但如果这一轮已经不是最新一轮，就别覆盖更新的场景）
    if (result.scene && (result.scene === 'online' || result.scene === 'offline')) {
      const newest = cGet<{ id: number | null }>(
        'SELECT MAX(id) AS id FROM messages WHERE companion_id = ?'
      );
      const stale = Number(newest?.id || 0) > Number(assistantMessageId || 0);
      const cur = getRelationshipState();
      const mode = getSetting('scene_mode') || 'auto';
      if (!stale && mode === 'auto' && cur.scene !== result.scene) {
        cur.scene = result.scene;
        cur.scene_reason = result.scene_reason || '分析模型判断';
        cur.scene_updated_at = nowIso();
        saveRelationshipState(cur);
        logRelationship(
          'milestone',
          `场景切换为${result.scene === 'offline' ? '线下相处' : '线上聊天'}`,
          null,
          result.scene,
          result.scene_reason || result.reasoning
        );
      }
    }

    // 8.5) 世界模拟 + 亲密系统（都在这里落地；new_memory 已在事务外的记忆阶段写入）
    try {
      const rawAny: RawAnalysis = raw;
      applyLifeDeltas({ health: rawAny.health_delta, psychology: rawAny.psychology_delta });
      // 字符串字段统一限长（原来这些直读 rawAny，模型偶发超长文本会直接落库并回注 Prompt）
      const lc: RawLocationChange = rawAny.location_change || {};
      if (lc.new_location) applyLocationChange(String(lc.new_location).slice(0, 20), String(lc.reason || '').slice(0, 60));
      const ac: RawActivityChange = rawAny.activity_change || {};
      if (ac.new_activity) applyActivityChange(String(ac.new_activity).slice(0, 24), String(ac.expected_end || '').slice(0, 20));
      const de: RawDailyEvent = rawAny.daily_event || {};
      if (de.content) addDailyEvent(String(de.type || '生活').slice(0, 12), String(de.content).slice(0, 200), String(de.impact || '').slice(0, 120));
      const sw: RawSharedWorldUpdate = rawAny.shared_world_update || {};
      if (sw.new_plan) addSharedPlan(String(sw.new_plan).slice(0, 80));
      if (sw.new_ritual) addSharedRitual(String(sw.new_ritual).slice(0, 80));
      if (sw.new_place) addSharedPlace(String(sw.new_place).slice(0, 60));
      if (sw.new_item) addSharedItem(String(sw.new_item).slice(0, 80));
      if (Array.isArray(rawAny.profile_reveal)) {
        revealProfileFields(rawAny.profile_reveal.filter((x) => typeof x === 'string').slice(0, 6).map(String));
      }
      if (Array.isArray(rawAny.preference_reveal)) {
        revealPreferences(rawAny.preference_reveal.filter((x) => typeof x === 'string').slice(0, 6).map(String));
      }
      // P1-03：raw 布尔读取一律走 parseBool（"false" 不能再被当成 true）
      // P1-04：一次"被关心"只走 applyCareEvent 一个入口（含全部关怀效果），不再叠加两套。
      if (parseBool(rawAny.cared_for_her)) {
        applyCareEvent();
        outcome.applied.life = true;
      }
      // 基础互动康复（孤独/想念底噪）：与 applyCareEvent 各自内部按自定义模式冻结，避免重复加成
      applyInteractionEffects({});
      // 亲密系统（自定义模式跳过：数值由用户直控）
      if (!custom) {
        const idelta: Record<string, number> = rawAny.intimacy_delta || {};
        if (typeof idelta === 'object' && Object.keys(idelta).length) applyIntimacyDelta(idelta);
        if (parseBool(rawAny.aftercare_needed)) {
          const quality = pickEnum<'good' | 'neutral' | 'ignored'>(
            rawAny.aftercare_quality,
            ['good', 'neutral', 'ignored'],
            'neutral'
          );
          const aft = startAftercare(quality);
          if (aft) {
            outcome.applied.aftercare = true;
            logRelationship('milestone', `进入事后状态：${aft.state}`, null, aft.state, '亲密系统');
          }
        }
      }
    } catch (e) {
      console.warn('[life/intimacy] apply failed:', errMsg(e));
    }

    // 9) 三层机制：确认层 + 固化层（这是唯一真正修改性格的地方；自定义模式跳过）
    if (!custom) runConfirmLayer(assistantMessageId ?? null);
    saveWeeklySnapshot();

    // 10) 依恋分析应用（结果已在网络阶段算好；只有真的分析成功才推进轮次）
    if (!custom) {
      if (ctx.attShouldRun && ctx.attRaw) {
        const a = ctx.attRaw;
        setCounter(ck('last_attachment_analysis_turn'), turn);
        const sig: AttachmentSignal = {
          anxiety_delta: clamp(num(a.suggested_anxiety_delta), -2, 2),
          avoidance_delta: clamp(num(a.suggested_avoidance_delta), -2, 2),
          reasoning: String(a.reasoning || '').slice(0, 500),
          user_attachment_cues: Array.isArray(a.user_attachment_cues) ? a.user_attachment_cues.slice(0, 6).map(String) : [],
        };
        addAttachmentSignals(sig, assistantMessageId ?? null);
        runAttachmentLayer(); // 累积 3 次同向才真正调整
        outcome.applied.attachmentAnalyzed = true;
      } else if (!ctx.attShouldRun) {
        runAttachmentLayer();
      }
    }

    /* ---------------- 操作账本（P0-08）：记录本轮真实产生的状态变化 ---------------- */
    // turnId / generationId 可能为空（老调用方 / 无回合上下文）——仍照记，便于按消息来源反向；
    // 为空时无法按 generation 精确定位（rollbackOperationsForGeneration 会跳过）。
    for (const r of cAll<{ id: number; delta: number; balance_after: number }>(
      'SELECT id, delta, balance_after FROM emotional_bank WHERE companion_id = ? AND id > ?',
      bankMaxBefore
    )) {
      recordOperation({ ...led, operationType: 'emotional_bank.create', targetTable: 'emotional_bank', targetId: Number(r.id), after: { delta: Number(r.delta), balance_after: Number(r.balance_after) } });
    }
    for (const r of cAll<{ id: number; dimension: string; old_value: number; new_value: number }>(
      'SELECT id, dimension, old_value, new_value FROM personality_logs WHERE companion_id = ? AND id > ?',
      plogMaxBefore
    )) {
      recordOperation({ ...led, operationType: 'personality_log.create', targetTable: 'personality_logs', targetId: Number(r.id), meta: { dimension: String(r.dimension), old_value: Number(r.old_value), new_value: Number(r.new_value) } });
    }
    for (const r of cAll<{ id: number; old_anxiety: number; new_anxiety: number; old_avoidance: number; new_avoidance: number }>(
      'SELECT id, old_anxiety, new_anxiety, old_avoidance, new_avoidance FROM attachment_logs WHERE companion_id = ? AND id > ?',
      attLogFrom
    )) {
      recordOperation({ ...led, operationType: 'attachment_log.create', targetTable: 'attachment_logs', targetId: Number(r.id), meta: { old_anxiety: Number(r.old_anxiety), new_anxiety: Number(r.new_anxiety), old_avoidance: Number(r.old_avoidance), new_avoidance: Number(r.new_avoidance) } });
    }
    for (const r of cAll<{ id: number }>(
      'SELECT id FROM agent_daily_events WHERE companion_id = ? AND id > ?',
      dailyMaxBefore
    )) {
      recordOperation({ ...led, operationType: 'agent_daily_events.create', targetTable: 'agent_daily_events', targetId: Number(r.id) });
    }
    const sharedAfter = sharedWorldSnapshot();
    if (JSON.stringify(sharedAfter) !== JSON.stringify(sharedBefore)) {
      recordOperation({ ...led, operationType: 'shared_world.update', targetTable: 'shared_world', targetId: null, before: sharedBefore, after: sharedAfter });
    }
    // 关系数值整轮快照：before/after 记五数值 + mood + stage；
    // 反向时 emotional_balance 由 emotional_bank 账本单独处理，避免余额被重复扣减（见 turnOps）。
    const afterSnap = snapshotForUndo();
    recordOperation({ ...led, operationType: 'relationship.delta', targetTable: 'relationship_state', targetId: null, before, after: afterSnap });

    // 12) 记录本轮实际产生的影响（供"删除消息并撤销影响"旧推断路径使用；保留）
    try {
      const conflict = cGet<{ id: number }>(
        'SELECT id FROM conflict_logs WHERE companion_id = ? ORDER BY id DESC LIMIT 1'
      );
      cRun(
        `INSERT INTO turn_effects (companion_id, user_id, message_id, user_message_id,
           intimacy_delta, trust_delta, balance_delta, tension_delta, repair_delta,
           mood_before, mood_after, stage_before, stage_after,
           rel_log_from, rel_log_to, att_log_from, att_log_to, conflict_id, created_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        DEFAULT_USER_ID,
        assistantMessageId ?? null,
        ctx.userMessageId ?? null,
        round1(afterSnap.intimacy - before.intimacy),
        round1(afterSnap.trust - before.trust),
        round1(afterSnap.balance - before.balance),
        round1(afterSnap.tension - before.tension),
        round1(afterSnap.repair - before.repair),
        before.mood,
        afterSnap.mood,
        before.stage,
        afterSnap.stage,
        relLogFrom,
        maxId('relationship_logs'),
        attLogFrom,
        maxId('attachment_logs'),
        outcome.applied.conflict && conflict ? conflict.id : null,
        nowIso(),
        JSON.stringify({
          before,
          memories: outcome.applied.memories,
          signals: outcome.applied.personalitySignals,
          repaired: outcome.applied.repaired,
          intimacy_before: before.intimacy,
          trust_before: before.trust,
          balance_before: before.balance,
          tension_before: before.tension,
          repair_before: before.repair,
        })
      );
    } catch (e) {
      console.warn('[analysis] turn_effects 记录失败:', errMsg(e));
    }
  });
}