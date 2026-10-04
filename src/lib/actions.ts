// 神态/动作库：即使换成一个"不太聪明"的模型，也能保证她始终有活人感
// 由代码在生成后兜底挑选，按关系阶段 / 性格 / 依恋 / 最近用过的动作加权

export type ActionTag = 'eye' | 'hand' | 'voice' | 'touch' | 'scene';

export interface ActionDef {
  text: string;
  tag: ActionTag;
  /** 最低关系阶段（0 初识 / 1 试探 / 2 加深 / 3 融合 / 4 承诺） */
  minStage: number;
  /** 这些性格维度越高越容易出现 */
  boost?: Partial<
    Record<'warmth' | 'playfulness' | 'romance' | 'directness' | 'independence' | 'emotional_intensity', number>
  >;
  /** 这些依恋倾向更容易出现 */
  style?: ('anxious' | 'avoidant' | 'secure')[];
  /** 情绪关键词命中时提高权重 */
  mood?: string[];
}

export const ACTIONS: ActionDef[] = [
  /* ---------------- 眼神表情 ---------------- */
  { text: '睫毛垂下去，耳朵有点热', tag: 'eye', minStage: 0, boost: { warmth: 1 }, mood: ['害羞', '心动'] },
  { text: '眼睛亮了一下', tag: 'eye', minStage: 0, boost: { playfulness: 1 }, mood: ['开心', '愉悦'] },
  { text: '眼神飘到别处，又偷偷转回来', tag: 'eye', minStage: 0, style: ['anxious', 'avoidant'] },
  { text: '咬着嘴唇忍住笑', tag: 'eye', minStage: 0, boost: { playfulness: 1 } },
  { text: '轻轻挑了下眉', tag: 'eye', minStage: 0, boost: { playfulness: 1, directness: 1 } },
  { text: '愣了一下，眼睛慢慢弯起来', tag: 'eye', minStage: 1, boost: { warmth: 1 } },
  { text: '吸了吸鼻子，把眼睛眨干', tag: 'eye', minStage: 1, boost: { emotional_intensity: 1 }, mood: ['难过', '委屈'] },
  { text: '盯着屏幕看了很久，没打字', tag: 'eye', minStage: 1, style: ['anxious'] },
  { text: '眉头松开了一点', tag: 'eye', minStage: 1, boost: { warmth: 1 }, mood: ['安心', '缓和'] },
  { text: '视线从屏幕上抬起来，看着你', tag: 'eye', minStage: 2, boost: { romance: 1 } },
  { text: '被看得不好意思，别开脸', tag: 'eye', minStage: 2, boost: { romance: 1 }, mood: ['害羞'] },
  { text: '眼底都是心疼', tag: 'eye', minStage: 2, boost: { warmth: 1 }, mood: ['心疼', '担心'] },
  { text: '眯起眼睛笑，露出小虎牙', tag: 'eye', minStage: 2, boost: { playfulness: 1 } },
  { text: '眼圈有点红，但还在笑', tag: 'eye', minStage: 3, boost: { emotional_intensity: 1 }, mood: ['委屈', '难过'] },

  /* ---------------- 手上小动作 ---------------- */
  { text: '手指无意识地绕着发尾', tag: 'hand', minStage: 0, style: ['anxious'] },
  { text: '把手机攥紧了一点', tag: 'hand', minStage: 0, boost: { emotional_intensity: 1 } },
  { text: '指尖在桌沿上轻轻敲了两下', tag: 'hand', minStage: 0, boost: { playfulness: 1 } },
  { text: '捏着衣角，慢慢揉', tag: 'hand', minStage: 0, style: ['anxious'] },
  { text: '把对话框点开又关掉', tag: 'hand', minStage: 1, style: ['anxious'] },
  { text: '认真地把这句话又读了一遍', tag: 'hand', minStage: 1, boost: { warmth: 1 } },
  { text: '把杯子捧在手心里暖着', tag: 'hand', minStage: 1, boost: { warmth: 1, independence: 1 } },
  { text: '在纸上随手画了个小圈', tag: 'hand', minStage: 1, boost: { independence: 1 } },
  { text: '偷偷截了个图收起来', tag: 'hand', minStage: 2, boost: { romance: 1 } },
  { text: '把脸埋进枕头里蹭了蹭', tag: 'hand', minStage: 2, boost: { playfulness: 1 }, mood: ['害羞', '撒娇'] },
  { text: '手指在你手背上轻轻画圈', tag: 'hand', minStage: 3, boost: { romance: 1 } },
  { text: '抓着你的衣角不松手', tag: 'hand', minStage: 3, boost: { warmth: 1 }, style: ['anxious', 'secure'] },
  { text: '给你把外套理了理', tag: 'hand', minStage: 4, boost: { warmth: 1 } },

  /* ---------------- 声音语气 ---------------- */
  { text: '声音闷闷的', tag: 'voice', minStage: 0, boost: { emotional_intensity: -1 }, mood: ['低落', '难过'] },
  { text: '尾音轻轻往上扬', tag: 'voice', minStage: 0, boost: { playfulness: 1 } },
  { text: '说到一半停住了', tag: 'voice', minStage: 0, boost: { emotional_intensity: 1 } },
  { text: '小声嘟囔了一句', tag: 'voice', minStage: 1, boost: { playfulness: 1 } },
  { text: '语气软下来', tag: 'voice', minStage: 1, boost: { warmth: 1 }, mood: ['和好', '安心'] },
  { text: '笑出了气音', tag: 'voice', minStage: 1, boost: { playfulness: 1 }, mood: ['开心'] },
  { text: '声音压低了一些，怕吵到你', tag: 'voice', minStage: 2, boost: { warmth: 1 } },
  { text: '突然认真起来，一个字一个字说', tag: 'voice', minStage: 2, boost: { directness: 1, emotional_intensity: 1 } },
  { text: '带着一点撒娇的鼻音', tag: 'voice', minStage: 2, boost: { playfulness: 1, romance: 1 } },
  { text: '话说到一半，声音有点抖', tag: 'voice', minStage: 3, boost: { emotional_intensity: 1 }, mood: ['委屈', '生气'] },
  { text: '把想说的话咽了回去', tag: 'voice', minStage: 3, style: ['avoidant'] },

  /* ---------------- 距离与接触 ---------------- */
  { text: '往你那边挪了半步', tag: 'touch', minStage: 1, boost: { romance: 1 } },
  { text: '凑近屏幕看你打的字', tag: 'touch', minStage: 1, boost: { playfulness: 1 } },
  { text: '肩膀轻轻碰了你一下', tag: 'touch', minStage: 2, boost: { playfulness: 1 } },
  { text: '整个人靠过来，重量压在你身上', tag: 'touch', minStage: 2, boost: { romance: 1 } },
  { text: '把额头抵在你肩上', tag: 'touch', minStage: 3, boost: { warmth: 1 }, mood: ['累', '难过'] },
  { text: '从背后抱住你，不出声', tag: 'touch', minStage: 3, boost: { romance: 1, warmth: 1 } },
  { text: '赌气转过身去，又悄悄回头看你', tag: 'touch', minStage: 3, boost: { playfulness: 1, emotional_intensity: 1 }, mood: ['生气', '别扭'] },
  { text: '伸手把你圈住，不让你走', tag: 'touch', minStage: 3, boost: { romance: 1 }, mood: ['撒娇', '想念'] },
  { text: '把脸埋在你颈边', tag: 'touch', minStage: 4, boost: { romance: 1 } },
  { text: '退开半步，给自己留了点空间', tag: 'touch', minStage: 2, style: ['avoidant'] },

  /* ---------------- 环境互动 ---------------- */
  { text: '把台灯调暗了一点', tag: 'scene', minStage: 1, boost: { independence: 1 } },
  { text: '往窗外看了一眼', tag: 'scene', minStage: 0, boost: { independence: 1 } },
  { text: '裹紧了毯子', tag: 'scene', minStage: 0, boost: { warmth: -1 } },
  { text: '把刚洗好的水果推到你那边', tag: 'scene', minStage: 2, boost: { warmth: 1 } },
  { text: '走去阳台吹了会儿风', tag: 'scene', minStage: 1, boost: { independence: 1 }, style: ['avoidant'], mood: ['烦', '生气'] },
  { text: '把耳机摘下来，认真听你说', tag: 'scene', minStage: 1, boost: { warmth: 1 } },
  { text: '把桌上的书本合上了', tag: 'scene', minStage: 2, boost: { warmth: 1 } },
  { text: '泡了两杯热的东西，一杯给你', tag: 'scene', minStage: 2, boost: { warmth: 1 } },
  { text: '把手机放在一边，不回别的消息了', tag: 'scene', minStage: 3, boost: { romance: 1 } },
  { text: '关了灯，只留着一盏小夜灯', tag: 'scene', minStage: 3, boost: { romance: 1 } },
];

function similarity(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  // 连续 5 个字相同即视为"用过的同类动作"
  for (let i = 0; i + 5 <= Math.min(a.length, b.length); i++) {
    if (b.includes(a.slice(i, i + 5))) return true;
  }
  return false;
}

export interface PickActionOptions {
  stage: number;
  personality: Record<string, number>;
  attachmentStyle: string;
  used?: string[];
  mood?: string;
  /** 想避开的上一条动作类型（避免连续同类） */
  avoidTag?: ActionTag;
  /** 只挑"轻"的动作（眼神/语气/手上小动作）——代码兜底补动作时用，语义风险最小 */
  subtleOnly?: boolean;
  /** 允许带 mood 标签的动作参与（情境命中权重 1.8，未命中重罚 0.2）——兜底补动作时开启，挑得更贴语境 */
  moodAware?: boolean;
  /** 当前场景：线下时避开屏幕/对话框类动作，线上时避开身体接触类动作 */
  scene?: 'online' | 'offline';
  /** 语境基调：难过/安慰/冲突等严肃语境（heavy）时避开俏皮类动作，免得和情景打架 */
  tone?: 'light' | 'heavy';
}

/** 按阶段/性格/依恋/情绪加权挑一个动作，并避开最近用过的 */
export function pickAction(opts: PickActionOptions): { text: string; tag: ActionTag } | null {
  const { stage, personality, attachmentStyle, used = [], mood = '' } = opts;
  const SUBTLE: ActionTag[] = ['eye', 'voice', 'hand'];
  const candidates = ACTIONS.filter((a) => {
    if (a.minStage > stage) return false;
    if (used.some((u) => similarity(u, a.text))) return false;
    if (opts.avoidTag && a.tag === opts.avoidTag) return false;
    if (opts.subtleOnly && !SUBTLE.includes(a.tag)) return false;
    // 兜底补动作：默认不带情绪标签；moodAware 时放行（命中情境加权、未命中重罚）
    if (opts.subtleOnly && !opts.moodAware && a.mood && a.mood.length) return false;
    // 场景过滤：线下别挑"拿手机/盯屏幕/点对话框"的线上动作
    if (opts.scene === 'offline' && /(对话框|屏幕|打字|发消息|回消息)/.test(a.text)) return false;
    // 线上别挑身体接触动作（"凑近屏幕看"这种隔着屏幕的除外）
    if (opts.scene === 'online' && a.tag === 'touch' && !/屏幕/.test(a.text)) return false;
    // 严肃语境别挑俏皮类动作（挑眉、把脸埋枕头这类）
    if (opts.tone === 'heavy' && Number(a.boost?.playfulness || 0) > 0) return false;
    return true;
  });
  if (!candidates.length) return null;

  const scored = candidates.map((a) => {
    let weight = 1;
    for (const [dim, w] of Object.entries(a.boost || {})) {
      const v = Number(personality[dim] ?? 50);
      weight += v > 50 ? ((v - 50) / 25) * Number(w) : -(((50 - v) / 25) * Number(w)) * 0.6;
    }
    if (a.style && a.style.includes(attachmentStyle as any)) weight += 1.4;
    if (a.mood && a.mood.length) {
      // 带情绪标签的动作：情境命中才加分，没命中重罚（避免"赌气转身"配安慰的话）
      const hit = mood ? a.mood.some((m) => mood.includes(m)) : false;
      weight *= hit ? 1.8 : 0.2;
    }
    return { a, weight: Math.max(0.05, weight) };
  });

  const total = scored.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const s of scored) {
    r -= s.weight;
    if (r <= 0) return { text: s.a.text, tag: s.a.tag };
  }
  return { text: scored[scored.length - 1].a.text, tag: scored[scored.length - 1].a.tag };
}

/** 推断一段话最后用过的动作类型（用于避免连续同类型） */
export function tagOfAction(text: string): ActionTag | null {
  const hit = ACTIONS.find((a) => similarity(a.text, text));
  return hit ? hit.tag : null;
}