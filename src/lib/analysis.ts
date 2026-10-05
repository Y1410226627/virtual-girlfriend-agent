// 后台抽取流水线：每轮对话后调用 LLM 抽取记忆 / 关系变化 / 情感银行 / 冲突 / 性格信号 / 依恋信号
import { dbAll, dbGet, dbRun, DEFAULT_USER_ID, getCounter, setCounter, boolSetting, getSetting, customModeOn } from './db';
import { clamp, nowIso, localDateStr, round1, truncate, errMsg } from './utils';
import { chat, chatJson } from './llm';
import { buildAnalysisMessages, buildAttachmentAnalysisMessages, buildDailySummaryMessages } from './prompts';
import { addMemory, forgetSweep, saveDailySummary, recentMessagesForSummary, applyMemoryCorrection } from './memory';
import { applyRelationshipDelta, checkStageTransition, getRelationshipState, saveRelationshipState, logRelationship, agentName, userName } from './relationship';
import { addBankEntry } from './emotionalBank';
import { registerConflict, registerRepair } from './conflict';
import { addSignals, runConfirmLayer, saveWeeklySnapshot, signalProgress } from './personality';
import { addAttachmentSignals, runAttachmentLayer, shouldRunAttachmentAnalysis } from './attachment';
import { renderContentForModel } from './stickers';
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
  careBoost,
  applyInteractionEffects,
} from './life';
import { applyIntimacyDelta, startAftercare } from './intimacy';
import type { AnalysisResult, AttachmentSignal } from './types';
import {
  normalize,
  parseMemoryCorrections,
  pickEnum,
  num,
  transcript,
  snapshotForUndo,
  maxId,
  type RawAnalysis,
  type RawLocationChange,
  type RawActivityChange,
  type RawDailyEvent,
  type RawSharedWorldUpdate,
  type RawAttachmentAnalysis,
} from './analysis-parse';

/** 用户明确表达"喜欢/不喜欢这样的我"的句式（规则兜底，权重 3 倍）
 *  收紧：只认指向"她这个人/她的说话方式"的明确反馈，避免"说得好/别那么"这类泛化词一命中就把整轮信号 ×3 */
const STRONG_FEEDBACK_RE =
  /(我喜欢你(这样|这样说|这样说话|这样回|这么)|我就喜欢你这样|别这样|不要这样|不要再这样|你好烦|好烦你|我讨厌你(这样|这样说|这么)|我不喜欢(你)?这样|继续这样|(再|更|要)温柔一点|(再|更|要)主动一点|别那么(凶|冷|敷衍)|你能不能别)/;

export interface AnalyzeOutcome {
  ok: boolean;
  error?: string;
  result?: AnalysisResult;
  applied: {
    memories: number;
    personalitySignals: number;
    conflict: boolean;
    repaired: boolean;
    stageChanged: boolean;
    attachmentAnalyzed: boolean;
    /** 本轮有生活/心理状态变化 */
    life?: boolean;
    /** 本轮进入事后状态 */
    aftercare?: boolean;
  };
}

/**
 * 主入口：分析一轮对话并落库。
 * 注意：性格修改绝不在这里直接发生 —— 只记录信号，由三层机制（runConfirmLayer）处理。
 */
export async function analyzeTurn(params: {
  userMessage: string;
  assistantMessage: string;
  userMessageId?: number | null;
  assistantMessageId?: number | null;
}): Promise<AnalyzeOutcome> {
  const outcome: AnalyzeOutcome = {
    ok: false,
    applied: { memories: 0, personalitySignals: 0, conflict: false, repaired: false, stageChanged: false, attachmentAnalyzed: false },
  };

  try {
    const turn = getCounter('turn_count');
    // 自定义模式：数值直控——只保留记忆/场景/生活叙事，冻结一切自动数值改写
    const custom = customModeOn();
    // 记录"本轮开始前"的状态：删除这条消息时可以精确撤销本轮影响
    const before = snapshotForUndo();
    const relLogFrom = maxId('relationship_logs');
    const attLogFrom = maxId('attachment_logs');
    const messages = buildAnalysisMessages({
      userMessage: truncate(renderContentForModel(params.userMessage), 1200),
      assistantMessage: truncate(renderContentForModel(params.assistantMessage), 1200),
      recentTranscript: transcript(10),
      turnCount: turn,
    });

    const raw = await chatJson<RawAnalysis>(messages, {
      maxTokens: 2600,
      temperature: 0.25,
      thinking: boolSetting('analysis_thinking', false),
    });
    if (!raw) {
      outcome.error = '分析模型未返回有效 JSON（本轮已跳过，不影响聊天）';
      return outcome;
    }

    const result = normalize(raw);
    outcome.result = result;

    // 1) 记忆
    for (const m of result.memory_updates) {
      const id = await addMemory(m, params.assistantMessageId ?? null);
      if (id) outcome.applied.memories++;
    }

    // 1.5) 记忆纠正：用户明确指出她记错了 → 推翻旧记忆并写入正确事实
    // 全部包在 try/catch 里：字段缺失或落库失败时行为与现在完全一致，绝不影响主流程
    try {
      for (const c of parseMemoryCorrections(raw)) {
        await applyMemoryCorrection(c.old_hint, c.new_fact, params.userMessageId ?? null);
      }
    } catch (e) {
      console.warn('[analysis] memory_corrections 处理失败:', errMsg(e));
    }

    // 2) 关系数值（自定义模式跳过：数值由用户直控）
    const rel = getRelationshipState();
    const tensionBefore = rel.unresolved_tension;
    if (!custom) {
      applyRelationshipDelta(result.relationship_delta, `第 ${turn} 轮分析：${result.reasoning}`);
      if (params.assistantMessageId) {
        dbRun('UPDATE messages SET emotion = ? WHERE id = ?', result.relationship_delta.mood, params.assistantMessageId);
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

    // 3) 情感银行显式记账（自定义模式跳过）
    if (!custom && Math.abs(result.relationship_delta.emotional_balance_delta) >= 1) {
      addBankEntry(
        result.relationship_delta.emotional_balance_delta,
        result.relationship_delta.emotional_balance_delta > 0 ? '正向互动' : '负向互动',
        result.reasoning || '本轮互动',
        params.assistantMessageId ?? null
      );
    }

    // 4) 冲突与修复（自定义模式跳过：会改张力的机制全部冻结）
    const after = getRelationshipState();
    if (!custom && result.conflict_detected && result.conflict_type !== 'none') {
      registerConflict(result.conflict_type, result.reasoning || '本轮出现分歧');
      outcome.applied.conflict = true;
    } else if (!custom && result.repair_attempt && (tensionBefore > 5 || after.unresolved_tension > 5)) {
      registerRepair(result.repair_quality || 'sweet', result.reasoning || '双方主动修复');
      outcome.applied.repaired = true;
    }

    // 5) 性格信号（只累积，不改性格；自定义模式不累积）
    // 用户明确的直接反馈（"我喜欢你这样""别这样""你好烦"）→ 权重 3（一次抵三次）。
    // 这里用规则做一次兜底判定，不依赖分析模型是否记得标记。
    if (!custom) {
      const directFeedback = STRONG_FEEDBACK_RE.test(params.userMessage || '');
      const signals = directFeedback
        ? result.personality_signals.map((s) => ({ ...s, is_direct_feedback: true }))
        : result.personality_signals;
      if (directFeedback && signals.length) {
        logRelationship('milestone', '收到明确反馈，本轮性格信号按 3 倍权重累积', null, null, params.userMessage.slice(0, 60));
      }
      outcome.applied.personalitySignals = addSignals(signals, params.assistantMessageId ?? null);
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
        }, params.assistantMessageId ?? null);
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
      const newest = dbGet<{ id: number | null }>(
        'SELECT MAX(id) AS id FROM messages WHERE user_id = ?',
        DEFAULT_USER_ID
      );
      const stale = Number(newest?.id || 0) > Number(params.assistantMessageId || 0);
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

    // 8.5) 世界模拟 + 亲密系统（都在这里落地）
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
      if (sw.new_memory) {
        await addMemory(
          { type: 'relationship', content: String(sw.new_memory).slice(0, 300), importance: 7, emotion: '温暖' },
          params.assistantMessageId ?? null
        );
      }
      if (Array.isArray(rawAny.profile_reveal)) {
        revealProfileFields(rawAny.profile_reveal.filter((x) => typeof x === 'string').slice(0, 6).map(String));
      }
      if (Array.isArray(rawAny.preference_reveal)) {
        revealPreferences(rawAny.preference_reveal.filter((x) => typeof x === 'string').slice(0, 6).map(String));
      }
      if (rawAny.cared_for_her) {
        careBoost('care');
        outcome.applied.life = true;
      }
      // 传递真实的"被关心"信号（原来恒 false，关怀加成是死代码）；自定义模式跳过（承诺冻结自动改写）
      if (!custom) applyInteractionEffects({ caredForHer: !!rawAny.cared_for_her });
      // 亲密系统（自定义模式跳过：数值由用户直控）
      if (!custom) {
        const idelta: Record<string, number> = rawAny.intimacy_delta || {};
        if (typeof idelta === 'object' && Object.keys(idelta).length) applyIntimacyDelta(idelta);
        if (rawAny.aftercare_needed) {
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
    if (!custom) runConfirmLayer(params.assistantMessageId ?? null);
    saveWeeklySnapshot();

    // 10) 每 10 轮：依恋分析（自定义模式跳过）
    if (!custom) {
      const lastAttachmentTurn = getCounter('last_attachment_analysis_turn');
      if (shouldRunAttachmentAnalysis(turn, lastAttachmentTurn)) {
        try {
          const attRaw = await chatJson<RawAttachmentAnalysis>(buildAttachmentAnalysisMessages(transcript(20), turn), {
            maxTokens: 900,
            temperature: 0.2,
            thinking: boolSetting('analysis_thinking', false),
          });
          if (attRaw) {
            // 只有真的分析成功才推进轮次（原来先记账、失败就白白吞掉一次窗口）
            setCounter('last_attachment_analysis_turn', turn);
            const sig: AttachmentSignal = {
              anxiety_delta: clamp(num(attRaw.suggested_anxiety_delta), -2, 2),
              avoidance_delta: clamp(num(attRaw.suggested_avoidance_delta), -2, 2),
              reasoning: String(attRaw.reasoning || '').slice(0, 500),
              user_attachment_cues: Array.isArray(attRaw.user_attachment_cues)
                ? attRaw.user_attachment_cues.slice(0, 6).map(String)
                : [],
            };
            addAttachmentSignals(sig, params.assistantMessageId ?? null);
            runAttachmentLayer(); // 累积 3 次同向才真正调整
            outcome.applied.attachmentAnalyzed = true;
          }
        } catch (e) {
          // 依恋分析失败不影响主流程，但要留痕，避免依恋系统长期静默不更新
          console.warn('[依恋分析] 失败（不影响主流程）:', errMsg(e));
        }
      } else {
        runAttachmentLayer();
      }
    }

    // 11) 偶尔做一次遗忘清理
    if (turn % 20 === 0) {
      const archived = forgetSweep();
      if (archived > 0) logRelationship('milestone', `记忆整理：归档 ${archived} 条低价值记忆`, null, null, '定期遗忘机制');
    }

    // 12) 记录本轮实际产生的影响（供"删除消息并撤销影响"使用）
    try {
      const after = snapshotForUndo();
      const conflict = dbGet<{ id: number }>(
        'SELECT id FROM conflict_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1',
        DEFAULT_USER_ID
      );
      dbRun(
        `INSERT INTO turn_effects (user_id, message_id, user_message_id,
           intimacy_delta, trust_delta, balance_delta, tension_delta, repair_delta,
           mood_before, mood_after, stage_before, stage_after,
           rel_log_from, rel_log_to, att_log_from, att_log_to, conflict_id, created_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        DEFAULT_USER_ID,
        params.assistantMessageId ?? null,
        params.userMessageId ?? null,
        round1(after.intimacy - before.intimacy),
        round1(after.trust - before.trust),
        round1(after.balance - before.balance),
        round1(after.tension - before.tension),
        round1(after.repair - before.repair),
        before.mood,
        after.mood,
        before.stage,
        after.stage,
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

    outcome.ok = true;
    return outcome;
  } catch (e) {
    outcome.error = errMsg(e);
    return outcome;
  }
}

/** 每日摘要：跨天后生成昨天的摘要；错过多天会逐天补齐；失败会自动重试 */
export async function maybeGenerateDailySummary(force = false): Promise<string | null> {
  // 失败后 30 分钟内不再重试，避免后台每次 tick 都打模型
  const retryAfter = getCounter('summary_retry_after');
  if (!force && retryAfter > Date.now()) return null;

  const today = localDateStr();
  let target = today; // force：直接生成今天的
  if (!force) {
    // 最近一天"聊过（≥4 条）但还没有摘要"的日子，最多回看 14 天
    const row = dbGet<{ d: string }>(
      `SELECT d FROM (
         SELECT date(created_at, 'localtime') AS d, COUNT(*) AS c FROM messages
         WHERE user_id = ? AND date(created_at, 'localtime') < ?
         GROUP BY d HAVING c >= 4 ORDER BY d DESC LIMIT 14
       )
       WHERE d NOT IN (SELECT date FROM daily_summaries WHERE user_id = ?)
       ORDER BY d DESC LIMIT 1`,
      DEFAULT_USER_ID,
      today,
      DEFAULT_USER_ID
    );
    if (!row?.d) return null;
    target = row.d;
  }

  const rows = recentMessagesForSummary(target);
  const lifeEvents = dbAll<{ event_type: string; content: string; created_at: string }>(
    "SELECT event_type, content, created_at FROM agent_daily_events WHERE user_id = ? AND date(created_at, 'localtime') = ? ORDER BY id ASC",
    DEFAULT_USER_ID, target
  );
  const lifeLogs = dbAll<{ field: string; new_value: string; reason: string | null; created_at: string }>(
    "SELECT field, new_value, reason, created_at FROM life_state_logs WHERE user_id = ? AND date(created_at, 'localtime') = ? AND field IN ('activity', 'illness', 'care', 'shared_plan', 'shared_ritual', 'shared_place', 'shared_item') ORDER BY id ASC",
    DEFAULT_USER_ID, target
  );
  if (rows.length < 4 && !lifeEvents.length && !lifeLogs.length) return null;
  const conversation = rows
    .map((r) => `${r.role === 'user' ? userName() : agentName()}：${truncate(r.content, 300)}`)
    .join('\n');
  const lifeText = [
    ...lifeEvents.map((e) => `她的生活事件（${e.event_type}）：${e.content}`),
    ...lifeLogs.map((l) => `她的生活变化（${l.field}）：${l.new_value}${l.reason ? `；${l.reason}` : ''}`),
  ].join('\n');
  const text = [conversation, lifeText ? `【她自己的日常】\n${lifeText}` : ''].filter(Boolean).join('\n\n');

  try {
    const plain = await chat(buildDailySummaryMessages(text, target), {
      maxTokens: 800,
      temperature: 0.3,
      thinking: false,
      kind: 'analysis',
    });
    if (plain && plain.length > 10) {
      saveDailySummary(target, plain.slice(0, 800), { messages: rows.length, lifeEvents: lifeEvents.length, lifeChanges: lifeLogs.length });
      logRelationship('milestone', `生成 ${target} 的每日摘要`, null, null, '每日摘要把对话压缩为长期记忆');
      return plain;
    }
  } catch {
    /* 失败：下面统一安排重试 */
  }
  setCounter('summary_retry_after', Date.now() + 30 * 60 * 1000);
  return null;
}

/** 供前端展示：当前累积层进度（性格页） */
export function personalitySignalSnapshot() {
  return signalProgress();
}