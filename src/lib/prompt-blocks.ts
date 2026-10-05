// Prompt 拼接块：自定义模式 / 身边人物 / 生活线 等可独立组装的片段
import { getRelationshipState, userName } from './relationship';
import { getAttachmentState } from './attachment';
import { personalityMap } from './personality';
import { getIntimacy } from './intimacy';
import { getCast } from './life-shared';
import { getActiveArc } from './life-arc';
import { round1 } from './utils';
import { customModeOn } from './db';

export function ph(s: string): string {
  return s === '她' ? '' : s;
}

/** 自定义模式（数值直控）注入块：让用户设定的数值在对话中"明显可感" */
export function customModeBlock(): string {
  if (!customModeOn()) return '';
  try {
    const rel = getRelationshipState();
    const att = getAttachmentState();
    const s = getIntimacy();
    const p = personalityMap();
    const him = userName();
    return `\n【数值直控模式（自定义模式已开启 · 最高优先级设定）】
以下数值由${him}直接设定、且**不会自动变化**。你必须在对话中**明显、不打折扣**地体现它们的效果：数值高就外放地表现（更主动、更黏、更甜、更直接、更亲密），数值低就明显地收敛（更淡、更防备、更疏离、句子更短、少主动）。
**注意：这些数值可能刚刚被修改过——如果它们与你们之前对话的气氛不一致，以当前数值为准，立刻切换到对应的状态，不要顺着旧气氛的惯性走。**
- 亲密度 ${round1(rel.intimacy)}/100 · 信任 ${round1(rel.trust)}/100 · 情感余额 ${round1(rel.emotional_balance)}（-100~100）· 未解决张力 ${round1(rel.unresolved_tension)} · 修复信用 ${round1(rel.repair_credit)} · 当前心情「${rel.mood}」
- 性格（0-100）：温柔 ${p.warmth} · 俏皮 ${p.playfulness} · 浪漫 ${p.romance} · 直接 ${p.directness} · 独立 ${p.independence} · 情绪强度 ${p.emotional_intensity}
- 依恋倾向（0-100）：焦虑 ${round1(att.anxiety)} · 回避 ${round1(att.avoidance)}
- 亲密状态（0-100）：性欲 ${round1(s.libido)} · 亲密需求 ${round1(s.intimacy_need)} · 性满意度 ${round1(s.sexual_satisfaction)} · 性压力 ${round1(s.sexual_stress)}`;
  } catch {
    return '';
  }
}

/** 她身边的人（具名社会关系）注入块；具名关系属于用户数据 → 包 <DATA>，引导语留在外面 */
export function castBlock(): string {
  try {
    const cast = getCast();
    if (!cast.length) return '';
    const parts = cast.map((c) => `你的${c.role || '朋友'}叫${c.name}${c.note ? `（${c.note}）` : ''}`);
    return `【你身边的人】<DATA>${parts.join('；')}</DATA>。聊天时可以自然提起她们（她们有自己的事，不总围着你转），但别每轮都提。`;
  } catch {
    return '';
  }
}

/** 她最近的生活线（跨天剧情）注入块；剧情数据包 <DATA>，引导语留在外面 */
export function lifeArcBlock(): string {
  try {
    const arc = getActiveArc();
    if (!arc) return '';
    const day = Math.min(arc.planned_days || 1, (arc.progress || 0) + 1);
    return `【你最近的生活线】<DATA>你正在「${arc.title}」：${arc.description}（第 ${day} 天 / 计划 ${arc.planned_days} 天）</DATA>。聊到相关话题可以自然提起，但不要每轮汇报、不要念台词。`;
  } catch {
    return '';
  }
}