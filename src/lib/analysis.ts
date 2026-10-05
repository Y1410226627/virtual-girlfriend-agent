// 后台抽取流水线：每轮对话后调用 LLM 抽取记忆 / 关系变化 / 情感银行 / 冲突 / 性格信号 / 依恋信号
// 应用阶段（事务化的本地写入 + 操作账本）已拆到 analysis-apply.ts（analysis.ts → analysis-apply 单向依赖）。
import { dbAll, dbGet, getCounter, setCounter, boolSetting, customModeOn, DEFAULT_USER_ID } from './db';
import { localDateStr, truncate, errMsg } from './utils';
import { chat, chatJson } from './llm';
import { buildAnalysisMessages, buildAttachmentAnalysisMessages, buildDailySummaryMessages } from './prompts';
import { addMemory, addMemoriesBatch, forgetSweep, saveDailySummary, recentMessagesForSummary, applyMemoryCorrection } from './memory';
import { logRelationship, agentName, userName } from './relationship';
import { signalProgress } from './personality';
import { shouldRunAttachmentAnalysis } from './attachment';
import { renderContentForModel } from './stickers';
import { recordOperation } from './turnOps';
import type { AnalysisResult } from './types';
import {
  normalize,
  parseMemoryCorrections,
  transcript,
  snapshotForUndo,
  maxId,
  type RawAnalysis,
  type RawSharedWorldUpdate,
  type RawAttachmentAnalysis,
} from './analysis-parse';
import { applyAnalysisResult } from './analysis-apply';

// 应用阶段与其上下文的对外导出面保持不变（实现见 analysis-apply.ts）
export { applyAnalysisResult } from './analysis-apply';
export type { ApplyAnalysisContext, ApplyOutcome } from './analysis-apply';

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
 *
 * 结构（P0-07 原子化）：
 *   1) 网络阶段全部前置：主分析 / 依恋分析 / 记忆写入（含 embedding）；
 *   2) 应用阶段（applyAnalysisResult）整体包在一个 tx 内，内部无 await；
 *      中途失败 → 关系/银行/冲突/性格/依恋/生活等一律零写入（记忆是 append-only，另行 try/catch）。
 */
export async function analyzeTurn(params: {
  userMessage: string;
  assistantMessage: string;
  userMessageId?: number | null;
  assistantMessageId?: number | null;
  turnId?: number | null;
  generationId?: number | null;
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
    const led = { turnId: params.turnId ?? null, generationId: params.generationId ?? null };

    /* ---------------- 网络阶段（全部前置） ---------------- */
    const messages = buildAnalysisMessages({
      userMessage: truncate(renderContentForModel(params.userMessage), 1200),
      assistantMessage: truncate(renderContentForModel(params.assistantMessage), 1200),
      // P1-12：transcript 排除当前回合消息 id，避免当前回合被重复放大（消息先落库）
      recentTranscript: transcript(10, [params.userMessageId, params.assistantMessageId].filter(
        (x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0
      )),
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

    // 依恋分析：输入只依赖 transcript(20)+turn，可提前到网络阶段（条件与结果不变）
    let attShouldRun = false;
    let attRaw: RawAttachmentAnalysis | null = null;
    if (!custom) {
      const lastAttachmentTurn = getCounter('last_attachment_analysis_turn');
      attShouldRun = shouldRunAttachmentAnalysis(turn, lastAttachmentTurn);
      if (attShouldRun) {
        try {
          attRaw = await chatJson<RawAttachmentAnalysis>(buildAttachmentAnalysisMessages(transcript(20), turn), {
            maxTokens: 900,
            temperature: 0.2,
            thinking: boolSetting('analysis_thinking', false),
          });
        } catch (e) {
          // 依恋分析失败不影响主流程，但要留痕，避免依恋系统长期静默不更新
          console.warn('[依恋分析] 失败（不影响主流程）:', errMsg(e));
        }
      }
    }

    // 1) 记忆（含 embedding 网络调用；append-only，保持在事务之外、最前）
    //    P1-23：一次 embed(全部文本) 算完向量再逐条判重写入（逐条 savepoint 隔离，单条失败只跳过它）。
    const memMaxBefore = maxId('memories');
    const memUpdates = result.memory_updates;
    if (memUpdates.length) {
      try {
        const ids = await addMemoriesBatch(memUpdates, params.assistantMessageId ?? null);
        ids.forEach((id, i) => {
          if (!id) return;
          outcome.applied.memories++;
          // 只有真正"新建"的记忆才记账（合并/重复上报返回的是已有 id，不应被删除）
          if (id > memMaxBefore) {
            const m = memUpdates[i];
            recordOperation({
              ...led,
              operationType: 'memory.create',
              targetTable: 'memories',
              targetId: id,
              after: { type: m?.type, content: m?.content },
            });
          }
        });
      } catch (e) {
        console.warn('[analysis] 记忆批量写入失败:', errMsg(e));
      }
    }

    // 1.5) 记忆纠正：用户明确指出她记错了 → 推翻旧记忆并写入正确事实
    //      P1-21：带上 old_fact_key，让它优先按事实键精确命中被纠正的旧记忆
    try {
      for (const c of parseMemoryCorrections(raw)) {
        await applyMemoryCorrection(c.old_hint, c.new_fact, params.userMessageId ?? null, c.old_fact_key);
      }
    } catch (e) {
      console.warn('[analysis] memory_corrections 处理失败:', errMsg(e));
    }

    // 1.6) 共享世界里的"共同记忆"也是一条记忆（含 embedding，放事务外）
    const swu: RawSharedWorldUpdate = raw.shared_world_update || {};
    if (swu.new_memory) {
      try {
        const content = String(swu.new_memory).slice(0, 300);
        const id = await addMemory(
          { type: 'relationship', content, importance: 7, emotion: '温暖' },
          params.assistantMessageId ?? null
        );
        if (id && id > memMaxBefore) {
          recordOperation({ ...led, operationType: 'memory.create', targetTable: 'memories', targetId: id, after: { type: 'relationship', content } });
        }
      } catch (e) {
        console.warn('[analysis] 共享记忆写入失败:', errMsg(e));
      }
    }

    /* ---------------- 应用阶段：一个事务内的全部本地写入（无 await） ---------------- */
    applyAnalysisResult(raw, result, {
      turn,
      custom,
      userMessage: params.userMessage,
      userMessageId: params.userMessageId ?? null,
      assistantMessageId: params.assistantMessageId ?? null,
      turnId: params.turnId ?? null,
      generationId: params.generationId ?? null,
      before,
      attShouldRun,
      attRaw,
    }, outcome);

    // 11) 偶尔做一次遗忘清理（记忆归档，append-only，放事务外）
    if (turn % 20 === 0) {
      const archived = forgetSweep();
      if (archived > 0) logRelationship('milestone', `记忆整理：归档 ${archived} 条低价值记忆`, null, null, '定期遗忘机制');
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