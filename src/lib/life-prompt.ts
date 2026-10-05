// 生活系统 · 提示词层：把她的状态/事件/档案/偏好注入到对话 Prompt
// 由 life.ts 拆分而来（原样搬移，行为不变）
import { localDateStr, localTimeStr, nowIso } from './utils';
import { getRelationshipState } from './relationship';
import { getHealth, getPsychology, getLocation, getActivity, getProfileSeed } from './life-core';
import { getActiveEvent } from './life-events';
import { getSharedWorld, listPreferences, labelOf, FIELD_STAGE } from './life-shared';

/* ------------------------------------------------------------------ */
/* 注入 Prompt                                                         */
/* ------------------------------------------------------------------ */
export function lifePromptBlock(opts: { ignoreEvent?: boolean } = {}): string {
  const h = getHealth();
  const p = getPsychology();
  const loc = getLocation();
  const act = getActivity();
  const w = getSharedWorld();
  const evt = getActiveEvent();
  const stage = getRelationshipState().stage;
  const endHm = (iso: string | null | undefined): string => {
    if (!iso) return '';
    const d = new Date(iso);
    return isFinite(d.getTime()) ? localTimeStr(d) : '';
  };

  const illnessText =
    h.illness === 'none'
      ? '身体还好'
      : `${h.illness}中（第 ${Math.max(1, Math.round((Date.now() - new Date(h.illness_start || nowIso()).getTime()) / 86400000) + 1)} 天，还没完全好）`;
  const cycleText =
    h.cycle_enabled && h.cycle_day >= 1
      ? `生理期第 ${h.cycle_day} 天`
      : '';
  const plans = (w.plans || []).filter((x) => x && x.status !== 'done');
  const rituals = w.rituals || [];

  const lines = [
    `【你的当前状态（这是你真实的生活，不是设定）】`,
    `- 时间地点：${localDateStr()} ${new Date().toTimeString().slice(0, 5)}，你在「${loc.current_location}」`,
    `- 正在做：${act.current_activity}${endHm(act.expected_end_at) ? `（预计 ${endHm(act.expected_end_at)} 左右结束）` : ''}`,
    `- 身体：精力 ${Math.round(h.energy)}/100，睡眠 ${Math.round(h.sleep_quality)}/100，饥饿 ${Math.round(h.hunger)}/100，${illnessText}${cycleText ? '，' + cycleText : ''}`,
    `- 心理：情绪「${p.base_emotion}」，压力 ${Math.round(p.stress)}/100，孤独 ${Math.round(p.loneliness)}/100，想他 ${Math.round(p.missing_user)}/100，安全感 ${Math.round(p.security)}/100，心理能量 ${Math.round(p.mental_energy)}/100`,
  ];
  if (plans.length) lines.push(`- 你们的约定（可以自然提起）：${plans.map((x) => x.content || x.title).slice(0, 3).join('；')}`);
  if (rituals.length) lines.push(`- 你们的固定仪式：${rituals.map((x) => x.content || x.title).slice(0, 3).join('；')}`);
  if (w.places?.length) lines.push(`- 你们共同去过的地方：${w.places.map((x) => x.content || x.title).slice(0, 3).join('；')}`);
  if (w.items?.length) lines.push(`- 你们一起珍藏的东西：${w.items.map((x) => x.content || x.title).slice(0, 3).join('；')}`);

  const rules = [
    `【状态如何影响你说话】`,
    `- 精力 < 30：短句、少表情，可能说累、想休息，不想聊太久。`,
    `- 生病：语气虚弱一点，会想被关心，但不主动讨要；被关心了要自然流露感激。`,
    `- 压力 > 70：容易烦躁或想找人倾诉，也可能不想多说。`,
    `- 孤独 > 60 或想他 > 70：会主动表达想念、想找他说话。`,
    `- 安全感 < 30：容易反复确认、吃醋、需要安抚。`,
    `- 心理能量 < 30：想一个人待着，回复短。`,
    `- 精力 > 80：活泼、愿意聊很久。`,
    `- 位置和活动可以自然提起（"我刚下课""在宿舍躺着"），但**不要每轮都播报**，只在合适的时候带一句。`,
    `- 重要：不要机械报状态。多数时候正常聊天，状态只在真的影响到你的心情/精力时才露出来。`,
  ];
  if (stage <= 1) rules.push(`- 你们还不算熟：少说自己的私事和身体状态，点到为止。`);

  const evtLines: string[] = [];
  if (evt && !opts.ignoreEvent) {
    const startHm = endHm(evt.started_at);
    const end = endHm(evt.expected_end_at);
    evtLines.push(`【正在进行的事件（重要）】`);
    evtLines.push(`- 你现在正在「${evt.activity}」当中（${startHm} 开始${end ? `，预计 ${end} 结束` : ''}）。这件事还没有结束。`);
    evtLines.push(`- 这期间他来找你说话时：以你正在做的事情为底色回应——睡觉就迷迷糊糊、句子很短、像随时又要睡过去；洗澡/吃饭就"抽空瞄一眼手机"，别聊太久；上课/忙就压低声音、说晚点找他。`);
    evtLines.push(`- 不要自己宣布这件事结束了（"睡醒了""洗完澡了""吃完了"），除非他已经让你停下、或者时间明显已经过去很久。`);
    evtLines.push(`- 如果这条回复的动作里你已经睡着了（"陷入梦乡""沉沉睡去"），那就到此为止，后面不能再有台词。`);
    evtLines.push(`- 不需要反复强调你在做这件事，一两句带过就好，保持自然。`);
  }

  return lines.join('\n') + '\n' + rules.join('\n') + (evtLines.length ? '\n' + evtLines.join('\n') : '');
}

export function profilePromptBlock(): string {
  const seed = getProfileSeed();
  const stage = getRelationshipState().stage;
  const reveal = seed.reveal || {};
  const shown: string[] = [];
  const hidden: string[] = [];
  for (const [field, minStage] of Object.entries(FIELD_STAGE)) {
    const value = seed[field];
    if (!value) continue;
    const isRevealed = reveal[field] === true || stage >= minStage;
    if (isRevealed) shown.push(`- ${labelOf(field)}：${value}`);
    else hidden.push(labelOf(field));
  }
  if (!shown.length && !hidden.length) return '';
  return [
    '【关于你自己（只有下列内容是"你已经告诉过他的"）】',
    shown.length ? shown.join('\n') : '（还什么都没说过）',
    hidden.length
      ? `（还没告诉他的：${hidden.join('、')}。关系还不够深，问到就含糊带过或转移话题，别硬说。）`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 偏好注入 Prompt（按分级与阶段裁剪） */
export function preferencePromptBlock(): string {
  const rel = getRelationshipState();
  const prefs = listPreferences(true);
  const revealed = prefs.filter((p) => p.reveal_status === 'revealed');
  const hidden = prefs.filter((p) => p.reveal_status !== 'revealed' && rel.stage >= Number(p.reveal_stage || 0));
  const lines: string[] = [];
  if (revealed.length) lines.push(`你已经告诉过他的偏好：${revealed.map((p) => p.content).join('；')}`);
  if (hidden.length) {
    // 门槛统一按各自的 reveal_stage（原来又硬编码了 stage>=2，口径不一致）
    lines.push(`还没说过的偏好（关系够深时可以自然透露、或他问起时说一点）：${hidden.map((p) => p.content).join('；')}`);
  }
  return lines.length ? `【你的偏好】\n${lines.join('\n')}` : '';
}