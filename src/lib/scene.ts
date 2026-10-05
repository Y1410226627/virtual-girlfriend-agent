// 场景系统：区分"线上聊天（隔着手机）"与"线下相处（在一起）"
// 自动识别用规则兜底（零延迟），后台分析用 LLM 校正；用户可强制指定
import { TOKEN_RE } from '@/lib/stickers';
import { clamp } from '@/lib/utils';

export type Scene = 'online' | 'offline';

/**
 * 这句话的"时间性"：只有 current（当下正在发生）才允许改变场景。
 * past / dream / hypothetical / quoted 描述的都是"非当下"，据此改场景会把人设带偏。
 */
export type SceneTemporal = 'current' | 'past' | 'dream' | 'hypothetical' | 'quoted';

/** 线下相处线索：明确的身体动作搭配、物理位置、同处一个空间 */
const OFFLINE_CUES =
  /(抱抱|抱着|抱住|抱一下|抱抱我|搂着|搂住|牵着|牵手|牵着手|牵住|拉住|拽住|亲亲|亲了一口|亲你|亲一下|吻你|吻了|靠着|靠在你肩|靠在肩上|靠着你|拍拍你|摸了摸|摸摸你|揉揉|蹭蹭|贴着|贴着你|怀里|胸口|耳边|枕着|枕在|额头|脸上|面前|面对面|看着你|看向你|你旁边|走过来|坐过来|躺下|趴在|递给你|喂我|喂你|捏了捏|握住|伸出手|一起走|出门|见面|见到|接你|陪你走|床边|床上|沙发)/;
/** 线上聊天线索：手机、消息、屏幕 */
const ONLINE_CUES =
  /(回我(消息|信息)?|在吗|在不在|看到我发的|微信|企鹅|QQ|打字|屏幕|手机上|发消息|发个消息|消息(发|回|收)|收不到|没看到|视频通话|语音通话|打个电话|打电话|备注|头像|朋友圈|定位|截图|发你|发张|照片发|表情包|在线|下线|已读|对话框|聊天记录|隔着屏幕)/;

/** 纯表情包消息（不含其他内容） */
const STICKER_ONLY_RE = new RegExp(`^\\s*${TOKEN_RE.source}\\s*$`, 'i');
/** 线索计数的全局副本：提到模块级常量，避免每次调用重建正则（String.match 会重置 lastIndex，复用安全） */
const OFFLINE_CUES_G = new RegExp(OFFLINE_CUES.source, 'g');
const ONLINE_CUES_G = new RegExp(ONLINE_CUES.source, 'g');

export interface SceneDetection {
  scene: Scene;
  reason: string;
  /** 0~1 的置信度：0 表示不改变场景 */
  confidence: number;
  /** 这句话的时间性；只有 current 才允许切换场景 */
  temporal?: SceneTemporal;
}

/* ------------------------------------------------------------------ */
/* 时间性识别：非当下的描述（回忆 / 梦 / 假设 / 引用）不应改变场景       */
/* ------------------------------------------------------------------ */
/** 梦：出现"梦见/梦到"等，即便带了"抱着你"这类线下动作，也只当梦话 */
const DREAM_RE = /(梦见|梦到|做梦|梦里|做了个梦|梦里面|梦见了)/;
/** 引用/影视：整句被引号包住，或明说来自台词/歌词/影视/书里 */
const QUOTED_RE =
  /([「『][^」』]{1,80}[」』]|“[^”]{1,80}”|《[^》]{1,60}》|台词|歌词|电影里|电视剧里|剧里|小说里|书里|原文里|引用的|他念的)/;
/** 假设：如果/要是/假如…描述的是"没发生的可能"，不是当下 */
const HYPOTHETICAL_RE = /(如果|要是|假如|假设|万一|若是我|若你|倘若|若能|要是能|如果我)/;
/** 过去：昨晚/前几天/那时候…是回忆，不是此刻 */
const PAST_RE =
  /(昨晚|昨天晚上|昨天|前天|前几天|前些天|那天|那时候|当时|上次|上回|以前|之前|小时候|上周|上周天|上个月|去年|那年|很久以前|早些时候)/;

function classifyTemporal(text: string): SceneTemporal {
  if (DREAM_RE.test(text)) return 'dream';
  if (QUOTED_RE.test(text)) return 'quoted';
  if (HYPOTHETICAL_RE.test(text)) return 'hypothetical';
  if (PAST_RE.test(text)) return 'past';
  return 'current';
}

const TEMPORAL_REASON: Record<Exclude<SceneTemporal, 'current'>, string> = {
  past: '他说的是过去的事，不改变当前场景',
  dream: '他在说梦，不改变当前场景',
  hypothetical: '他在做假设，不改变当前场景',
  quoted: '他在引用影视/台词，不改变当前场景',
};

/**
 * 依据用户这句话判断场景（无法判断时保持原场景）。
 * 只有"当下"（temporal = current）的句子才可能切换场景；回忆/梦/假设/引用一律不切换。
 */
export function detectScene(userText: string, current: Scene): SceneDetection {
  const text = String(userText || '');
  // 纯表情包消息不改变场景判断（"抱抱我/亲你一下"这类短句仍要判断，不再按长度早退）
  if (STICKER_ONLY_RE.test(text)) {
    return { scene: current, reason: '', confidence: 0, temporal: 'current' };
  }
  const temporal = classifyTemporal(text);
  if (temporal !== 'current') {
    return { scene: current, reason: TEMPORAL_REASON[temporal], confidence: 0, temporal };
  }
  const off = (text.match(OFFLINE_CUES_G) || []).length;
  const on = (text.match(ONLINE_CUES_G) || []).length;
  if (off === 0 && on === 0) return { scene: current, reason: '', confidence: 0, temporal: 'current' };
  if (off === on) return { scene: current, reason: '', confidence: 0, temporal: 'current' };
  const winner: Scene = off > on ? 'offline' : 'online';
  // 置信度校准：主导线索 ≥1 才有意义（0.5 起步），线索越多、差距越大越自信，封顶 0.98
  const dominant = Math.max(off, on);
  const margin = Math.abs(off - on);
  const confidence = clamp(0.5 + 0.15 * (dominant - 1) + 0.05 * margin, 0.5, 0.98);
  const reason =
    winner === 'offline'
      ? `他说的话像在旁边（${off} 个线下线索）`
      : `他在说手机上的事（${on} 个线上线索）`;
  return { scene: winner, reason, confidence, temporal: 'current' };
}

/** 注入回复 Prompt 的场景约束 */
export function sceneBlock(scene: Scene, stage: number): string {
  const stageNote =
    stage <= 1
      ? '你们还不算熟：线下时保持礼貌距离（目光、点头、让位、递东西），不要有身体接触；线上就正常聊天。'
      : stage === 2
        ? '你们互相喜欢：线下可以靠近、碰衣袖、并肩走；线上可以撒娇但别太黏。'
        : stage === 3
          ? '你们是恋人：线下可以牵手、靠着、抱、闹别扭；线上可以撒娇、说想他。'
          : '你们很稳定：线下的亲密是自然顺手的那种（理衣领、靠着不说话、递东西），线上不必刻意甜。';

  if (scene === 'offline') {
    return `【现在的场景：线下相处】你们此刻在同一个空间里，面对面（或挨着），不是隔手机聊天。
- 绝对不要出现只有异地才会说的话：回我消息、我在手机这头、发你一张图、你是不是没看手机、我先不聊了、晚点回你、等你回我。
- 你的动作可以直接作用于他：牵他的手、靠着他的肩、把东西塞给他、拉他的袖子、抬头看他、凑近听、从他手里拿过杯子。
- 说话更像现场：更短、更即时，可以被打断；用"……""（顿了一下）"表示停顿，而不是"发送消息"。
- 想休息/走开时，用线下方式表达（"我靠你肩上眯一会儿""我去倒杯水"），而不是"我去洗澡了，等下回你"。
${stageNote}`;
  }
  return `【现在的场景：线上聊天】你们不在一起，正在用手机聊天。
- 动作要围绕屏幕和距离：盯着对话框、打字、躺床上、裹着被子、支着下巴看手机、边吃边回。
- 不要写需要身体接触的动作（牵手、靠着、埋进怀里、摸头）——那是线下才有的；可以写"想抱你"这样的表达。
- 可以自然出现线上语境：等我一下我去倒水、晚点聊、发你一张照片、语音条、表情包。
- 回复可以稍微密一点、更像打字（分两小段也可以）。
${stageNote}`;
}