// 后台抽取流水线：每轮对话后调用 LLM 抽取记忆 / 关系变化 / 情感银行 / 冲突 / 性格信号 / 依恋信号
import { dbAll, dbGet, dbRun, DEFAULT_USER_ID, bumpCounter, getCounter, setCounter, boolSetting, numSetting, getSetting, customModeOn } from './db';
import { clamp, nowIso, localDateStr, round1, truncate } from './utils';
import { chat, chatJson } from './llm';
import { buildAnalysisMessages, buildAttachmentAnalysisMessages, buildDailySummaryMessages } from './prompts';
import { addMemory, forgetSweep, saveDailySummary, recentMessagesForSummary } from './memory';
import { applyRelationshipDelta, checkStageTransition, getRelationshipState, saveRelationshipState, logRelationship, agentName, userName } from './relationship';
import { addBankEntry } from './emotionalBank';
import { registerConflict, registerRepair, type ConflictType, type RepairQuality } from './conflict';
import { addSignals, runConfirmLayer, saveWeeklySnapshot, signalProgress } from './personality';
import { addAttachmentSignals, runAttachmentLayer, shouldRunAttachmentAnalysis, getAttachmentState } from './attachment';
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
import type { AnalysisResult, AttachmentSignal, MemoryUpdate, PersonalitySignal, RelationshipDelta } from './types';

/** 用户明确表达"喜欢/不喜欢这样的我"的句式（规则兜底，权重 3 倍） */
const STRONG_FEEDBACK_RE =
  /(我喜欢你(这样|这样说|这样说话|这样回|这么)|我就喜欢你这样|别这样|不要这样|不要再这样|你好烦|好烦你|我讨厌你(这样|这样说|这么)|我不喜欢(你)?这样|这样很好|这样就很好|说得好|说得对|继续这样|再温柔一点|凶一点|主动一点|别那么)/;

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

function emptyResult(): AnalysisResult {
  return {
    memory_updates: [],
    relationship_delta: {
      intimacy: 0,
      trust: 0,
      mood: getRelationshipState().mood,
      emotional_balance_delta: 0,
      unresolved_tension_delta: 0,
      repair_credit_delta: 0,
    },
    personality_signals: [],
    attachment_signals: { anxiety_delta: 0, avoidance_delta: 0, reasoning: '' },
    conflict_detected: false,
    conflict_type: 'none',
    repair_attempt: false,
    repair_quality: 'none',
    relationship_confirmation: false,
    next_check_in_minutes: 120,
    next_relationship_talk: false,
    reasoning: '',
  };
}

function num(v: any, def = 0): number {
  const n = Number(v);
  return isFinite(n) ? n : def;
}

function normalize(raw: any): AnalysisResult {
  const base = emptyResult();
  if (!raw || typeof raw !== 'object') return base;

  const rd = raw.relationship_delta || {};
  const delta: RelationshipDelta = {
    intimacy: clamp(num(rd.intimacy), -2, 2),
    trust: clamp(num(rd.trust), -2, 2),
    mood: typeof rd.mood === 'string' && rd.mood.trim() ? rd.mood.trim().slice(0, 12) : base.relationship_delta.mood,
    emotional_balance_delta: clamp(num(rd.emotional_balance_delta), -5, 5),
    unresolved_tension_delta: clamp(num(rd.unresolved_tension_delta), -20, 20),
    repair_credit_delta: clamp(num(rd.repair_credit_delta), 0, 10),
  };

  const memories: MemoryUpdate[] = Array.isArray(raw.memory_updates)
    ? raw.memory_updates
        .filter((m: any) => m && typeof m.content === 'string' && m.content.trim().length > 1)
        .slice(0, 6)
        .map((m: any) => ({
          type: ['semantic', 'episodic', 'emotional', 'relationship', 'attachment', 'personality'].includes(m.type)
            ? m.type
            : 'episodic',
          content: String(m.content).trim().slice(0, 500),
          importance: clamp(num(m.importance, 5), 0, 10),
          emotion: m.emotion ? String(m.emotion).slice(0, 12) : null,
          expires_at: m.expires_at || null,
        }))
    : [];

  const signals: PersonalitySignal[] = Array.isArray(raw.personality_signals)
    ? raw.personality_signals
        .filter((s: any) => s && s.dimension)
        .slice(0, 8)
        .map((s: any) => ({
          signal: String(s.signal || '').slice(0, 200),
          dimension: String(s.dimension),
          direction: String(s.direction || '+').startsWith('-') ? '-' : '+',
          strength: clamp(num(s.strength, 0.5), 0, 1),
          context: String(s.context || '未知情境').slice(0, 120),
          reasoning: s.reasoning ? String(s.reasoning).slice(0, 300) : undefined,
          is_direct_feedback: !!s.is_direct_feedback,
        }))
    : [];

  const as = raw.attachment_signals || {};
  const attachment: AttachmentSignal = {
    anxiety_delta: clamp(num(as.anxiety_delta), -2, 2),
    avoidance_delta: clamp(num(as.avoidance_delta), -2, 2),
    reasoning: String(as.reasoning || '').slice(0, 500),
    user_attachment_cues: Array.isArray(as.user_attachment_cues) ? as.user_attachment_cues.slice(0, 6).map(String) : [],
  };

  const conflictType: ConflictType = ['minor', 'major', 'boundary'].includes(raw.conflict_type)
    ? raw.conflict_type
    : 'none';
  const repairQuality: RepairQuality = ['sincere', 'sweet', 'avoidant', 'none'].includes(raw.repair_quality)
    ? raw.repair_quality
    : 'none';

  return {
    memory_updates: memories,
    relationship_delta: delta,
    personality_signals: signals,
    attachment_signals: attachment,
    conflict_detected: !!raw.conflict_detected,
    conflict_type: conflictType,
    repair_attempt: !!raw.repair_attempt,
    repair_quality: repairQuality,
    relationship_confirmation: !!raw.relationship_confirmation,
    next_check_in_minutes: clamp(num(raw.next_check_in_minutes, 120), 0, 360),
    next_relationship_talk: !!raw.next_relationship_talk,
    scene: ['online', 'offline'].includes(String(raw.scene)) ? String(raw.scene) : 'keep',
    scene_reason: String(raw.scene_reason || '').slice(0, 200),
    reasoning: String(raw.reasoning || '').slice(0, 800),
  };
}

/** 把一轮对话的上下文整理成文字（供分析使用） */
function transcript(limit = 10): string {
  const rows = dbAll<any>(
    'SELECT role, content FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    DEFAULT_USER_ID,
    limit
  ).reverse();
  const her = agentName();
  const him = userName();
  return rows
    .map((r) => `${r.role === 'user' ? him : her}：${truncate(r.content, 300)}`)
    .join('\n');
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

    const raw = await chatJson(messages, {
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
      const rawAny: any = raw;
      applyLifeDeltas({ health: rawAny.health_delta, psychology: rawAny.psychology_delta });
      const lc = rawAny.location_change || {};
      if (lc.new_location) applyLocationChange(String(lc.new_location), String(lc.reason || ''));
      const ac = rawAny.activity_change || {};
      if (ac.new_activity) applyActivityChange(String(ac.new_activity), String(ac.expected_end || ''));
      const de = rawAny.daily_event || {};
      if (de.content) addDailyEvent(String(de.type || '生活'), String(de.content), String(de.impact || ''));
      const sw = rawAny.shared_world_update || {};
      if (sw.new_plan) addSharedPlan(String(sw.new_plan));
      if (sw.new_ritual) addSharedRitual(String(sw.new_ritual));
      if (sw.new_place) addSharedPlace(String(sw.new_place));
      if (sw.new_item) addSharedItem(String(sw.new_item));
      if (sw.new_memory) {
        await addMemory(
          { type: 'relationship', content: String(sw.new_memory), importance: 7, emotion: '温暖' },
          params.assistantMessageId ?? null
        );
      }
      if (Array.isArray(rawAny.profile_reveal)) revealProfileFields(rawAny.profile_reveal.map(String));
      if (Array.isArray(rawAny.preference_reveal)) revealPreferences(rawAny.preference_reveal.map(String));
      if (rawAny.cared_for_her) {
        careBoost('care');
        outcome.applied.life = true;
      }
      applyInteractionEffects({ caredForHer: false });
      // 亲密系统（自定义模式跳过：数值由用户直控）
      if (!custom) {
        const idelta = rawAny.intimacy_delta || {};
        if (typeof idelta === 'object' && Object.keys(idelta).length) applyIntimacyDelta(idelta);
        if (rawAny.aftercare_needed) {
          const quality = ['good', 'neutral', 'ignored'].includes(rawAny.aftercare_quality)
            ? rawAny.aftercare_quality
            : 'neutral';
          const aft = startAftercare(quality);
          if (aft) {
            outcome.applied.aftercare = true;
            logRelationship('milestone', `进入事后状态：${aft.state}`, null, aft.state, '亲密系统');
          }
        }
      }
    } catch (e) {
      console.warn('[life/intimacy] apply failed:', (e as any)?.message || e);
    }

    // 9) 三层机制：确认层 + 固化层（这是唯一真正修改性格的地方；自定义模式跳过）
    if (!custom) runConfirmLayer(params.assistantMessageId ?? null);
    saveWeeklySnapshot();

    // 10) 每 10 轮：依恋分析（自定义模式跳过）
    if (!custom) {
      const lastAttachmentTurn = getCounter('last_attachment_analysis_turn');
      if (shouldRunAttachmentAnalysis(turn, lastAttachmentTurn)) {
        setCounter('last_attachment_analysis_turn', turn);
        try {
          const attRaw = await chatJson(buildAttachmentAnalysisMessages(transcript(20), turn), {
            maxTokens: 900,
            temperature: 0.2,
            thinking: boolSetting('analysis_thinking', false),
          });
          if (attRaw) {
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
        } catch {
          // 依恋分析失败不影响主流程
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
      const conflict = dbGet<any>(
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
      console.warn('[analysis] turn_effects 记录失败:', (e as any)?.message || e);
    }

    outcome.ok = true;
    return outcome;
  } catch (e: any) {
    outcome.error = e?.message || String(e);
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
  const lifeEvents = dbAll<any>(
    "SELECT event_type, content, created_at FROM agent_daily_events WHERE user_id = ? AND date(created_at, 'localtime') = ? ORDER BY id ASC",
    DEFAULT_USER_ID, target
  );
  const lifeLogs = dbAll<any>(
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

/* ------------------------------------------------------------------ */
/* 撤销支持：记录/回滚一轮对话造成的影响                                */
/* ------------------------------------------------------------------ */
function snapshotForUndo() {
  const s = getRelationshipState();
  return {
    intimacy: round1(s.intimacy),
    trust: round1(s.trust),
    balance: round1(s.emotional_balance),
    tension: round1(s.unresolved_tension),
    repair: round1(s.repair_credit),
    mood: s.mood,
    stage: s.stage,
  };
}

function maxId(table: string): number {
  const row = dbGet<{ m: number | null }>(`SELECT MAX(id) AS m FROM ${table} WHERE user_id = ?`, DEFAULT_USER_ID);
  return Number(row?.m || 0);
}