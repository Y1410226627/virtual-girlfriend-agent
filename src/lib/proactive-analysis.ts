// 她的自我暴露 → 长期记忆 / 计划 / 日常事件（P1-45）
// 现状：主动消息（她主动开口）保存后没有任何后续分析，她说"我明天想去……"不会变成她自己的记忆/计划。
// 这里补上：抽取她消息里"属于她自己"的信息，落到长期记忆（relationship）、共享计划/仪式、日常事件。
//
// 依赖方向：本模块 → life.ts 桶 / memory.ts / llm.ts；只被 proactive.ts 单向引用，不反向依赖，避免成环。
import { addMemory } from '@/lib/memory';
import { addSharedPlan, addSharedRitual, addDailyEvent } from '@/lib/life';
import { chatJson } from '@/lib/llm';

/** 她提到的一件"刚经历的小事" */
export interface AgentOriginLifeEvent {
  type?: string;
  content?: string;
}

/** 从她的主动消息里抽取出的"她自己的信息" */
export interface AgentOriginData {
  /** 自述 / 偏好 / 状态（一句话） */
  self_disclosure?: string;
  /** 她提出或约好的共同计划 */
  plan?: string;
  /** 她做的承诺或共同仪式 */
  promise?: string;
  /** 她刚经历的小事 */
  life_event?: AgentOriginLifeEvent;
  /** 她表达的主要情绪 */
  emotion?: string;
  /** 她提到的未来打算 / 想做的事 */
  future_intention?: string;
}

/** 抽取用的内联提示（不依赖 prompts.ts —— 那是提示词中枢的职责边界） */
const EXTRACT_SYSTEM = [
  '你在分析一条"她（AI 角色）主动发给用户"的消息，抽取其中属于她自己本人的信息，用于长期记忆与生活连续性。',
  '只抽取她本人的信息，不要抽取关于用户的事实，不要编造消息里没有的内容。',
  '只输出一个 JSON 对象，不要解释、不要 markdown。字段（没有的请省略或留空字符串）：',
  '{"self_disclosure":"她对自己的自述/偏好/状态，一句话",',
  ' "plan":"她提出或约好的共同计划",',
  ' "promise":"她做的承诺或共同仪式",',
  ' "life_event":{"type":"生活事件类型，如 心情/学习/朋友/饮食","content":"她刚经历的小事，一句话"},',
  ' "emotion":"她表达的主要情绪",',
  ' "future_intention":"她提到的未来打算或想做的事"}',
].join('\n');

/** 安全取字符串 */
function clean(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 纯落库（可脱离网络测试）：把抽取结果逐项写入长期记忆 / 共享世界 / 日常事件。
 * 每一项独立 try/catch —— 单项失败不影响其它项，也不向调用方抛错（分析属于后台增强，绝不能影响主流程）。
 */
export async function applyAgentOriginExtraction(messageId: number, data: AgentOriginData): Promise<void> {
  const d = data || {};

  // 自述 / 未来意图 → 关系类长期记忆（source_message_id 指回这条主动消息）
  for (const text of [clean(d.self_disclosure), clean(d.future_intention)]) {
    if (text.length < 2) continue;
    try {
      await addMemory({ type: 'relationship', content: text, importance: 6 }, messageId);
    } catch {
      /* 单项失败静默 */
    }
  }

  const plan = clean(d.plan);
  if (plan) {
    try {
      addSharedPlan(plan);
    } catch {
      /* 单项失败静默 */
    }
  }

  const promise = clean(d.promise);
  if (promise) {
    try {
      addSharedRitual(promise);
    } catch {
      /* 单项失败静默 */
    }
  }

  const lifeContent = d.life_event ? clean(d.life_event.content) : '';
  if (lifeContent.length >= 2) {
    try {
      addDailyEvent(clean(d.life_event?.type) || '生活', lifeContent, '她主动分享');
    } catch {
      /* 单项失败静默 */
    }
  }
}

/** 轻量抽取：调用分析模型链产出结构化 JSON；找不到模型配置 / 解析失败时返回 null（静默） */
export async function extractAgentOrigin(content: string): Promise<AgentOriginData | null> {
  const text = String(content || '').trim();
  if (!text) return null;
  try {
    const data = await chatJson<AgentOriginData>(
      [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: text },
      ],
      { maxTokens: 500, temperature: 0.2 }
    );
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * 主动消息分析入口：抽取 → 落库。整体静默，失败不影响发送。
 * 注：主动消息本身已被限流（每日 ≤ 3 条、有最小间隔），这里再叠一层小时节流收益极低，故不额外节流。
 */
export async function analyzeProactiveMessage(messageId: number, content: string): Promise<void> {
  const data = await extractAgentOrigin(content);
  if (!data) return;
  await applyAgentOriginExtraction(messageId, data);
}