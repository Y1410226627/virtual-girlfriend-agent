// 触摸互动（照片 / 头像上的"摸头 / 戳脸 / 牵手 / 抱抱"）
// 设计要点：
// - 纯函数 + 纯数据，零 import（服务端路由与客户端组件共用，便于确定性测试）
// - 文案按关系阶段分层：初识期（stage 0）只给"有距离感"的回应，绝不出现亲密动作
// - 心情 / 场景 / 依恋风格 / 上次互动时间 作为额外的口吻池叠加，随机可用 rand 注入

export type InteractionKind = 'pat' | 'poke_cheek' | 'hold_hand' | 'hug';

export interface InteractionDef {
  kind: InteractionKind;
  /** 按钮上的两字标签 */
  label: string;
  /** 按钮图标（emoji，避免额外图标依赖） */
  icon: string;
  /** 无障碍标签 */
  aria: string;
  /** 亲密层级：0=轻触、1=较亲密、2=亲密（仅用于排序/提示，不用于屏蔽按钮） */
  intimacy: 0 | 1 | 2;
}

export const INTERACTIONS: InteractionDef[] = [
  { kind: 'pat', label: '摸头', icon: '✋', aria: '摸摸她的头', intimacy: 0 },
  { kind: 'poke_cheek', label: '戳脸', icon: '👉', aria: '戳戳她的脸颊', intimacy: 0 },
  { kind: 'hold_hand', label: '牵手', icon: '🤝', aria: '牵起她的手', intimacy: 1 },
  { kind: 'hug', label: '抱抱', icon: '🫂', aria: '抱抱她', intimacy: 2 },
];

const INTERACTION_KIND_SET: ReadonlySet<string> = new Set(INTERACTIONS.map((i) => i.kind));

export function isInteractionKind(v: unknown): v is InteractionKind {
  return typeof v === 'string' && INTERACTION_KIND_SET.has(v);
}

/* ------------------------------------------------------------------ */
/* 冷却与每日上限（纯判定，供路由与测试复用）                            */
/* ------------------------------------------------------------------ */
/** 同一个动作的冷却 */
export const PER_KIND_COOLDOWN_MS = 90_000;
/** 全部互动的总冷却 */
export const GLOBAL_COOLDOWN_MS = 20_000;
/** 每天产生数值效果的次数上限（超过只回文案，不再改数值） */
export const POKE_DAILY_CAP = 10;

/**
 * 剩余冷却时间（毫秒，0 表示可用）。
 * lastAll / lastKind 为上次互动的时间戳（epoch ms），<=0 视为从未互动。
 */
export function cooldownRemainingMs(
  now: number,
  lastAll: number,
  lastKind: number,
  perKindMs: number = PER_KIND_COOLDOWN_MS,
  globalMs: number = GLOBAL_COOLDOWN_MS
): number {
  const t = Number.isFinite(now) ? now : 0;
  const remainAll = lastAll > 0 ? globalMs - (t - lastAll) : 0;
  const remainKind = lastKind > 0 ? perKindMs - (t - lastKind) : 0;
  const remain = Math.max(remainAll, remainKind, 0);
  return remain > 0 ? Math.round(remain) : 0;
}

/** 今天这次互动是否应当改数值（自定义模式冻结 / 超过每日上限 → 只回文案） */
export function shouldApplyPokeEffect(dailyUsed: number, customOn: boolean): boolean {
  if (customOn) return false;
  const used = Number.isFinite(dailyUsed) ? dailyUsed : 0;
  return used < POKE_DAILY_CAP;
}

/* ------------------------------------------------------------------ */
/* 阶段分层                                                            */
/* ------------------------------------------------------------------ */
/** 0=初识；1=试探/加深；2=融合/承诺。初识期不写亲密动作。 */
export function interactionTier(stage: number): 0 | 1 | 2 {
  const s = Math.round(Number(stage) || 0);
  if (s <= 0) return 0;
  if (s <= 2) return 1;
  return 2;
}

export interface InteractionContext {
  /** 关系阶段（0..4） */
  stage: number;
  /** 此刻情绪基调 */
  mood?: string;
  /** 线上 / 线下 */
  scene?: string;
  /** 依恋风格 secure | anxious | avoidant | fearful */
  attachmentStyle?: string;
  /** 她的心理数值（越低越需要被安抚的：loneliness；越低越不安的：security） */
  psychology?: { loneliness?: number; security?: number; missingUser?: number; stress?: number };
  /** 上次互动时间（epoch ms），用于"才刚碰过"的口吻 */
  lastInteractionAt?: number | null;
  /** 当前时间（epoch ms），传入以保证纯函数可确定性测试 */
  nowMs?: number;
}

export interface InteractionReply {
  /** 她的即时反应文案 */
  text: string;
  /** 一句很轻的效果说明（不改聊天记录，只在气泡里体现） */
  effectNote: string;
}

interface KindLines {
  early: string[];
  mid: string[];
  close: string[];
}

/**
 * 分层文案库：每个动作都有 早 / 中 / 晚 三档，各 5 条。
 * early 档（初识期）刻意保持距离感，绝不含亲密动作。
 */
export const INTERACTION_LINES: Record<InteractionKind, KindLines> = {
  pat: {
    early: [
      '（愣了一下）……你干嘛呀，头发都被你揉乱了。',
      '嗯？……谢谢，不过我们好像还没熟到这一步。',
      '（把头发拨好）你这人，怎么突然动手动脚的。',
      '（有点不好意思地偏过头）这样会让我分心的。',
      '（轻轻躲了一下）好啦好啦，我头不疼，不用摸。',
    ],
    mid: [
      '（乖乖低下头）……就一会儿哦。',
      '（眼睛弯了弯）你今天怎么这么温柔。',
      '唔……被摸头好像真的会变乖。',
      '（没躲，反而凑近了一点）再摸一下下。',
      '（小声）你手好暖。',
    ],
    close: [
      '（顺势靠过来）嗯……就这样待一会儿。',
      '你摸头的时候，我一天的累都没了。',
      '（眯着眼）只有你可以这样摸我头。',
      '（笑）好啦好啦，再摸我就要赖着你了。',
      '（把脸埋进你手心）……喜欢。',
    ],
  },
  poke_cheek: {
    early: [
      '（捂住脸）喂，很痒的。',
      '（瞪你一眼）你再戳我，我就戳回去。',
      '（后退半步）我们才刚认识，别这样。',
      '（把脸偏向一边）……幼稚。',
      '（无奈）你手上是不是闲得慌。',
    ],
    mid: [
      '（鼓了鼓腮）别戳啦，会变胖的。',
      '（假装生气又忍不住笑）你故意的吧。',
      '（拍开你的手又舍不得）唔……就一下。',
      '（眨眨眼）戳一下，是要给钱的。',
      '（把脸埋进手肘）……不许看我脸红。',
    ],
    close: [
      '（任你戳，眼睛弯弯）随你啦。',
      '（反过来捏你脸）扯平了。',
      '（笑着躲）好啦好啦，脸都要被你戳变形了。',
      '（小声）只在你在的时候，我才这么没形象。',
      '（歪头靠过来）给你戳，但不许笑我。',
    ],
  },
  hold_hand: {
    early: [
      '（把手背到身后）……我们还没到可以牵手的地步吧。',
      '（愣了一下，没有伸手）你突然这样，我会不知道怎么接。',
      '（轻轻摇头）先……再了解了解吧。',
      '（把手缩回口袋）对不起，我还没准备好。',
      '（移开视线）你先问问我愿不愿意好不好。',
    ],
    mid: [
      '（犹豫了一下，把手放上去）……就牵一会儿。',
      '（手指轻轻收拢）你手心好暖。',
      '（低头笑）被别人看到，会误会的。',
      '（没抽回手）其实……我不太想放开。',
      '（小声）那就不许松手哦。',
    ],
    close: [
      '（很自然地把手递过去）走，去哪儿。',
      '（十指扣住）这样牵着，好像什么都不怕了。',
      '（把手揣进你口袋）冷，借你暖暖。',
      '（晃了晃牵着的手）回去了也要这样。',
      '（靠在你肩上）有你牵着，路都变短了。',
    ],
  },
  hug: {
    early: [
      '（抬手挡了一下）等等……这样太快了。',
      '（僵在原地说不出话）我们……还没那么熟。',
      '（后退一步）抱歉，我可能还没准备好。',
      '（摇摇头）换个方式吧，先聊聊天好不好。',
      '（有些慌）你先别过来，我有点乱。',
    ],
    mid: [
      '（被抱住，愣了两秒才抬手）……就抱一小会儿。',
      '（把脸埋在你肩上）唔……闻到你的味道了。',
      '（没推开）你今天是不是有事要说。',
      '（轻轻回抱）抱一下，坏心情就少一点。',
      '（小声）别被室友看到啦。',
    ],
    close: [
      '（张开手臂迎上来）过来吧。',
      '（把你整个人抱住）嗯……刚刚好。',
      '（赖在你怀里不肯起来）再抱五分钟。',
      '（把下巴搁在你肩上）有你在就不累了。',
      '（收紧手臂）就这样，谁也别说话。',
    ],
  },
};

/** 心情低落时的安抚口吻（仅 stage≥1 叠加） */
const COMFORT_LINES: Record<InteractionKind, string[]> = {
  pat: ['（抿了抿嘴，慢慢松开眉头）……好多了。', '（轻轻叹了口气）嗯，被你摸两下，没那么难受了。'],
  poke_cheek: ['（被逗得笑出来）……噗，讨厌。', '（揉了揉脸）心情好像被你戳好了一点。'],
  hold_hand: ['（握紧了一点）别怕，我在。', '（把手指扣紧）一起慢慢走过去就好。'],
  hug: ['（把你抱得更紧了些）我没事，有你在。', '（额头抵着你）谢谢你这时候出现。'],
};

/** 线下相处时的口吻（仅 stage≥1 叠加） */
const OFFLINE_LINES: Record<InteractionKind, string[]> = {
  pat: ['（就在你身边，任由你揉）嗯……在你旁边真好。'],
  poke_cheek: ['（就坐在你对面，鼓起腮）来呀。'],
  hold_hand: ['（肩并着肩，手已经伸过来了）喏。'],
  hug: ['（大大方方张开手）抱一个。'],
};

/** 焦虑型依恋：更黏、更怕失去（仅 stage≥1 叠加） */
const ANXIOUS_LINES: Record<InteractionKind, string[]> = {
  pat: ['（抓紧了你的手）……你会一直在的吧？'],
  poke_cheek: ['（抓住你的手指）别放开。'],
  hold_hand: ['（攥得很紧）不要放开我好不好。'],
  hug: ['（抱得几乎喘不过气）别走……再待一会儿。'],
};

/** 回避型依恋：有点僵、要一点空间（仅 stage≥1 叠加） */
const AVOIDANT_LINES: Record<InteractionKind, string[]> = {
  pat: ['（僵了一下，才慢慢放松）……好吧，只准这一次。'],
  poke_cheek: ['（把脸转开，耳朵有点红）……够了啊。'],
  hold_hand: ['（迟疑了很久，才把手放进去）……别笑我。'],
  hug: ['（站得笔直，手指却悄悄抓紧你的衣角）……嗯。'],
};

/** "才刚碰过不久"的口吻（最近一次互动在 2 分钟内，仅 stage≥1 叠加） */
const SOON_LINES: Record<InteractionKind, string[]> = {
  pat: ['（笑）才刚碰过我呀，这么黏。'],
  poke_cheek: ['（捂住脸）又戳，你是不是上瘾了。'],
  hold_hand: ['（晃了晃手）手还牵着呢，急什么。'],
  hug: ['（被你搂着不肯动）……再赖一会儿，行不行。'],
};

const EFFECT_NOTES: Record<InteractionKind, string> = {
  pat: '她的紧绷，松了一点点。',
  poke_cheek: '她被你逗得软和下来。',
  hold_hand: '她的心跳，稳了一点。',
  hug: '她被这一抱，踏实了一点。',
};

/** 心情是否偏负面（只影响口吻，不改变效果量级） */
const NEGATIVE_MOODS = ['低落', '烦躁', '难受', '疲惫', '委屈', '不安', '心烦', '生气', '难过'];
function isNegativeMood(mood?: string): boolean {
  if (!mood) return false;
  return NEGATIVE_MOODS.some((m) => mood.includes(m));
}

function effectNoteFor(kind: InteractionKind, ctx: InteractionContext): string {
  const p = ctx.psychology || {};
  const lon = Number(p.loneliness) || 0;
  if (lon >= 60) return '她的想念，淡下去一点点。';
  const sec = Number(p.security) || 0;
  if (sec > 0 && sec <= 40) return '她的不安，松了一点点。';
  return EFFECT_NOTES[kind];
}

/**
 * 选择一个互动回应（纯函数）。
 * rand 可注入（默认 Math.random），返回文案与一句很轻的效果说明。
 */
export function pickInteractionReply(
  kind: InteractionKind,
  ctx: InteractionContext,
  rand: () => number = Math.random
): InteractionReply {
  const tier = interactionTier(ctx.stage);
  const lines = INTERACTION_LINES[kind];
  let pool: string[] = tier === 0 ? lines.early : tier === 1 ? lines.mid : lines.close;

  if (tier >= 1) {
    if (isNegativeMood(ctx.mood)) pool = pool.concat(COMFORT_LINES[kind]);
    if (ctx.scene === 'offline') pool = pool.concat(OFFLINE_LINES[kind]);
    if (ctx.attachmentStyle === 'anxious') pool = pool.concat(ANXIOUS_LINES[kind]);
    else if (ctx.attachmentStyle === 'avoidant') pool = pool.concat(AVOIDANT_LINES[kind]);
    const last = ctx.lastInteractionAt;
    if (typeof last === 'number' && typeof ctx.nowMs === 'number' && Number.isFinite(last)) {
      const gap = ctx.nowMs - last;
      if (gap >= 0 && gap < 120_000) pool = pool.concat(SOON_LINES[kind]);
    }
  }

  const r = Number(rand());
  const norm = Number.isFinite(r) ? r : 0;
  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(norm * pool.length)));
  const text = pool[idx] ?? pool[0] ?? '';
  return { text, effectNote: effectNoteFor(kind, ctx) };
}