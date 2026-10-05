// 人味层：不论模型聪明还是愚蠢，都保证"像真人"的下限
// 1) 清洗 AI 腔、Markdown、角色前缀、替用户说话等；
// 2) 控制长度，避免长篇大论；
// 3) 如果她没有神态/动作，由动作库兜底补一个；
// 4) 完全没产出时给一个符合阶段与心情的兜底台词 + 动作。
import { pickAction, tagOfAction, type ActionTag } from './actions';
import { hasSticker } from './stickers';
import { truncate } from './utils';

export interface HumanizeContext {
  userName: string;
  agentName: string;
  stage: number;
  personality: Record<string, number>;
  attachmentStyle: string;
  mood?: string;
  /** 最近用过的动作（避免重复） */
  recentActions?: string[];
  /** 她最近说过的原话（用于查重） */
  recentReplies?: string[];
  /** 用户这一轮说了什么（仅用于兜底台词的判断） */
  userMessage?: string;
  /** 当前场景：线上（隔着屏幕）/ 线下（在一起）——用于剔除与场景打架的动作 */
  scene?: 'online' | 'offline';
}

export interface HumanizeResult {
  text: string;
  /** 是否做过修正 */
  changed: boolean;
  /** 是否由动作库补了动作 */
  addedAction: boolean;
  /** 是否是兜底台词（模型没产出可用内容） */
  fallback: boolean;
  notes: string[];
}

/** AI 自我暴露 / 元信息（中英文都拦）——普通模式用（连"数据库/后台/系统提示"这类术语也一并删） */
const AI_SELF_RE =
  /(作为一个?\s*(AI|人工智能|人工智能助手|语言模型|大模型|助手|程序|机器人|智能体)|我是(一个)?\s*(AI|人工智能|语言模型|助手|程序|机器人|虚拟人|智能体)|作为(你的)?(虚拟)?(女友)?(助手|AI)|语言模型的?限制|系统提示|提示词|数据库|记忆库|后台|算法|训练数据|模型(认为|判断)|as an? ai|ai language model|language model|i am an? ai|i'm an? ai|as a helpful assistant|i cannot feel)/i;
/**
 * 严格版：只拦"她自认是 AI / 程序 / 助手"这类真正出戏的话，
 * 不含"数据库 / 后台 / 系统提示 / 提示词 / 模型"等术语——用于用户正经问技术/元问题时放宽模式。
 */
const AI_SELF_HARD_RE =
  /(作为一个?\s*(AI|人工智能|人工智能助手|语言模型|大模型|助手|程序|机器人|智能体)|我是(一个)?\s*(AI|人工智能|语言模型|助手|程序|机器人|虚拟人|智能体)|作为(你的)?(虚拟)?(女友)?(助手|AI)|语言模型的?限制|as an? ai|ai language model|language model|i am an? ai|i'm an? ai|as a helpful assistant|i cannot feel)/i;

/** 技术/元对话关键词（用户消息里出现这些，多半是在正经问"你怎么运作的"） */
const META_TECH_WORD_RE = /(记忆|系统|模型|AI|人工智能|设置|数据库|prompt|提示词|后台|算法|程序|代码|接口|功能|实现|原理|机制|设定|人格|参数)/i;
/** 疑问 / 求解释的语气 */
const META_QUESTION_RE =
  /([?？]|怎么|如何|为什么|为啥|什么|哪些|能不能|可不可以|能否|介绍|解释|说明|讲讲|说说|聊聊|原理|机制|工作方式|怎么工作|是啥|是不是|有没有|你说说)/;

/**
 * 用户这一轮是不是在问技术/元问题（如"你这个记忆系统怎么工作的"）。
 * 是 → humanize 走放宽模式：只删明显出戏句（自认 AI/程序），保留术语。
 */
export function isMetaTechQuestion(userMessage: string): boolean {
  const t = String(userMessage || '');
  if (!t) return false;
  return META_TECH_WORD_RE.test(t) && META_QUESTION_RE.test(t);
}

/** 用户替身发言（她在回复里替你说话） */
const ROLE_PREFIX_RE = /^\s*(?:她|他|AI|Assistant|assistant)\s*[：:]\s*/;
/** 括号里的元信息（内心独白/注释） */
const META_PAREN_RE = /[（(](?:内心|注|旁白|说明|补充|PS|ps)[：:][^）)]{0,80}[）)]/g;

/** 用户名后是否紧跟冒号（全/半角都算）：用字面量判断，避免用户名含正则元字符时误判或抛错 */
function startsWithNameColon(text: string, name: string): boolean {
  return text.startsWith(`${name}：`) || text.startsWith(`${name}:`);
}

/** 用户名后紧跟冒号（全/半角）首次出现的位置；没有则返回 -1 */
function indexOfNameColon(text: string, name: string): number {
  const iFull = text.indexOf(`${name}：`);
  const iHalf = text.indexOf(`${name}:`);
  if (iFull < 0) return iHalf;
  if (iHalf < 0) return iFull;
  return Math.min(iFull, iHalf);
}

function stripMarkdown(line: string): string {
  let t = line;
  t = t.replace(/^\s*#{1,6}\s*/, ''); // 标题
  t = t.replace(/^\s*(?:[-*•·>]+)\s+/, ''); // 列表 / 引用
  t = t.replace(/^\s*\d+[.、)]\s+/, ''); // 有序列表
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1'); // 粗体
  t = t.replace(/__([^_]+)__/g, '$1');
  t = t.replace(/`([^`]+)`/g, '$1'); // 行内代码
  t = t.replace(/^\s*["“]([\s\S]*)["”]\s*$/, '$1'); // 整句被引号包住
  return t;
}

function looksLikeJson(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith('{') || t.startsWith('[')) {
    // 收紧：必须真的是 JSON 结构（原来只要以 [ 开头就算，把"[笑了笑]你回来啦"整行删掉，连台词一起丢）
    if (!(t.endsWith('}') || t.endsWith(']'))) return false;
    try {
      JSON.parse(t);
      return true;
    } catch {
      return /"(memory_updates|relationship_delta|personality_signals|attachment_signals|reasoning)"\s*:/.test(t);
    }
  }
  if (/"(memory_updates|relationship_delta|personality_signals|attachment_signals|reasoning)"\s*:/.test(t)) return true;
  if (/^(JSON|json)\s*[:：]/.test(t)) return true;
  return false;
}

/** 把各种写法的动作统一成全角括号，便于界面统一渲染 */
function normalizeParens(text: string): string {
  const hasCn = (s: string) => /[\u4e00-\u9fa5]/.test(s);
  return text
    .replace(/【([^】\n]{1,120})】/g, (m, inner: string) => (hasCn(inner) ? `（${inner}）` : m))
    .replace(/\[([^\]\n]{1,120})\]/g, (m, inner: string) => (hasCn(inner) ? `（${inner}）` : m))
    .replace(/\*([^*\n]{1,120})\*/g, (m, inner: string) => (hasCn(inner) ? `（${inner}）` : m))
    // 混合括号：全角开+半角闭 / 半角开+全角闭（先处理，避免跨对误吞）
    .replace(/（([^)）\n]{1,120})\)/g, (m, inner: string) => (hasCn(inner) ? `（${inner}）` : m))
    .replace(/\(([^)）\n]{1,120})）/g, (m, inner: string) => (hasCn(inner) ? `（${inner}）` : m))
    .replace(/\(([^)\n]{1,120})\)/g, (m, inner: string) => (hasCn(inner) ? `（${inner}）` : m))
    .replace(/（([^）\n]{1,120})$/gm, '（$1）') // 句尾没闭合的补上
    .replace(/\(([^)\n]{1,120})$/gm, (m, inner: string) => (hasCn(inner) ? `（${inner}）` : m)); // 半角同款
}

/** 和情绪无关的机械操作（写了只会让人出戏）；语序两种都拦：调低亮度 / 亮度调低 */
const MECHANICAL_ACTION_RE =
  /((亮度|音量|色温|屏幕)[^，。]{0,6}(调|关|点|锁|设|改|切|变|降到|亮|暗)|(调|关|点|锁|设|改|切|把)(低|高|亮|暗|掉|小|大)?[^，。]{0,4}(亮度|音量|色温|屏幕)|看(了|一眼)?(时间|表|几点)|切(歌|下一首)|解锁(手机)?|打开(了)?(app|APP|应用)|整理(桌面|桌子|东西|房间)|收拾(桌面|桌子|东西)|调整(坐姿|姿势|椅子)|活动(了)?(一下)?(脖子|肩膀|手腕)|伸(了)?(个)?懒腰|清(了)?清嗓子|揉(了)?(揉)?眼睛|洗(了)?(把)?脸)/;
/** 情绪线索：出现这些词说明动作是有情绪写的，不算机械动作 */
const ACTION_EMOTION_RE =
  /(笑|哭|泪|脸红|耳|烫|热|颤|抖|紧|攥|握|咬|皱|愣|怔|心|慌|软|酸|疼|闷|叹|哼|嘟|撒|羞|气|委屈|想|喜欢|怕|不知所措|低头|别开|移开|埋|缩|躲)/;
/** 线上（隔着屏幕）不该出现的身体接触动作（要求"你"等作宾语才判；抱抱枕、拉被子这类自我安抚不算） */
const ONLINE_CONFLICT_RE =
  /(牵(住|着)?你|拉住你|抱(住|紧|着)?你|搂(住|着|你)|亲你|亲了|靠(在|着|向|近)你|靠过来|摸(你|你的)|揉(你|你的)|碰(你|你的)|贴(着|在|向)你|贴过来|捏(你|你的)|拽(你|你的)|拉(你|你的)|钻(进|到)你怀里|埋进你|窝进你怀里|枕在你|你(的)?(手背|手心|肩膀|肩|脸|头|发|腰|脖子|胳膊|手腕|衣角|袖子|腿|脚|耳朵|耳))/;
/** 线下不该出现的"隔着屏幕"动作 */
const OFFLINE_CONFLICT_RE = /(盯着(对话框|聊天框|屏幕|手机屏幕)|点开对话框|打字|发消息|回消息|撤回|表情包|视频通话|语音条)/;
/**
 * 动作里已经"睡过去"了：这种动作之后她不能再说话。
 * （模型经常会写"彻底陷入梦乡"，人味层以前还会在没台词时补一句兜底台词 → 睡着后开口，很出戏）
 */
const ACTION_SLEPT_RE = /(陷入梦乡|沉入梦乡|进入梦乡|沉沉睡去|睡着了|睡熟了|睡了过去|渐渐睡去|安心睡去|彻底睡|昏昏睡去|沉入睡眠|睡得(很|好)?沉)/;

/** 如果她在动作里已经睡过去了：把该动作之后的台词删掉（睡着的人不会说话） */
function trimTalkAfterSleepOnset(text: string): { text: string; note?: string } {
  const re = /[（(]([^）)\n]{1,160})[）)]/g;
  let lastOnsetEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (ACTION_SLEPT_RE.test(String(m[1] || ''))) lastOnsetEnd = m.index + m[0].length;
  }
  if (lastOnsetEnd < 0) return { text };
  const tail = text.slice(lastOnsetEnd);
  if (tail.replace(/\s/g, '').length < 2) return { text };
  return {
    text: text.slice(0, lastOnsetEnd).trim(),
    note: `已经睡过去了，删掉后面的台词：${truncate(tail.trim(), 24)}`,
  };
}

/** 剔除与情景不符 / 纯机械 / 刚用过的动作；宁缺毋滥——缺了后面会用动作库按心情补 */
function filterActions(
  text: string,
  ctx: HumanizeContext,
  replace: (inner: string) => string | null
): { text: string; notes: string[] } {
  const notes: string[] = [];
  const recent = (ctx.recentActions || []).map((a) => String(a).replace(/\s/g, ''));
  let out = text.replace(/（([^）)\n]{1,120})）/g, (full, inner: string) => {
    const s = String(inner).trim();
    // 原地换一个贴合语境的动作（而不是删掉后在结尾另补，避免"结尾突然多一句"的观感）
    const swap = (kind: string) => {
      const rep = replace(s);
      if (rep) {
        notes.push(`${kind}：${s} → ${rep}`);
        return `（${rep}）`;
      }
      notes.push(`${kind}：${s}`);
      return '';
    };
    if (ctx.scene === 'online' && ONLINE_CONFLICT_RE.test(s) && !/(想|希望|要你|要是|如果)/.test(s)) {
      return swap('去掉线上不该有的接触动作');
    }
    if (ctx.scene === 'offline' && OFFLINE_CONFLICT_RE.test(s)) {
      return swap('去掉线下不该有的屏幕动作');
    }
    if (MECHANICAL_ACTION_RE.test(s) && !ACTION_EMOTION_RE.test(s)) {
      return swap('去掉机械动作');
    }
    const flat = s.replace(/\s/g, '');
    // 4-5 字的动作原来永远比不出重复（slice(0,6) 定长前缀对短串恒不等）→ 用双方较短长度作比较长度
    const k1 = Math.min(flat.length, 6);
    if (flat.length >= 4 && recent.some((r) => r.slice(0, Math.min(r.length, k1)) === flat.slice(0, k1))) {
      return swap('复读动作');
    }
    return full;
  });
  // 动作被删后留下的空行与悬空标点
  out = out
    .split('\n')
    .map((l) =>
      l
        .replace(/^[，,、。；;]+/, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
    )
    .filter((l) => l.length > 0)
    .join('\n');
  return { text: out, notes };
}

/** 句级清理：去掉暴露 AI 身份、解释系统、替用户说话的句子 */
function cleanSentences(text: string, userName: string, selfRe: RegExp): { text: string; notes: string[] } {
  const notes: string[] = [];
  const sentences = text.split(/(?<=[。！？!?…；;\n])/);
  const kept: string[] = [];
  for (const s of sentences) {
    const raw = s;
    let cur = s;
    if (!cur.trim()) {
      // 纯空白段只保留换行，别把模型的分段吃掉（影响流式与最终的观感一致性）
      if (cur.includes('\n')) kept.push('\n');
      continue;
    }
    if (selfRe.test(cur)) {
      notes.push(`删掉AI腔: ${truncate(raw.trim(), 24)}`);
      continue;
    }
    // 替用户说话：出现"用户名："之后的内容整段截掉（半角冒号同样要拦）
    if (userName) {
      const idx = indexOfNameColon(cur, userName);
      if (idx >= 0) {
        cur = cur.slice(0, idx);
        notes.push('截掉替用户发言');
        if (!cur.trim()) continue;
      }
    }
    kept.push(cur);
  }
  return { text: kept.join(''), notes };
}

/** 模型没产出可用内容时的兜底台词（符合阶段与心情，不是套话模板感很强的句子） */
export function fallbackReply(ctx: HumanizeContext): string {
  const { stage, mood = '', userMessage = '' } = ctx;
  const asking = /[?？]|吗|呢|怎么|为什么|什么/.test(userMessage);
  const sad = /(累|烦|难过|委屈|生气|崩|哭|压力|不顺|失败)/.test(userMessage + mood);
  let line: string;
  if (sad) {
    line =
      stage >= 3
        ? '先别硬撑了，我在呢。想说的话慢慢跟我说，不想说就这样待一会儿也行。'
        : stage >= 1
          ? '听起来不太好受……你先缓一缓，我在听。'
          : '听起来挺不容易的，先别太为难自己。';
  } else if (asking) {
    line = stage >= 3 ? '嗯……让我想想怎么跟你说。你先说说你的想法？' : '唔，我还在想怎么说比较好，你先讲讲你那边的情况？';
  } else {
    line =
      stage >= 3
        ? '嗯，我在呢。你刚才那句我还记着。'
        : stage >= 1
          ? '嗯嗯，我在听，然后呢？'
          : '嗯，我在的，你继续说。';
  }
  return line;
}

/**
 * 主入口：把模型原始输出变"像真人说的话"
 */
export function humanizeReply(raw: string, ctx: HumanizeContext): HumanizeResult {
  const notes: string[] = [];
  let text = String(raw || '');
  // 用户在正经问技术/元问题（"你这个记忆系统怎么工作的"）→ 放宽：只删自认 AI/程序的出戏句，保留术语
  const metaTalk = isMetaTechQuestion(ctx.userMessage || '');
  const selfRe = metaTalk ? AI_SELF_HARD_RE : AI_SELF_RE;
  if (metaTalk) notes.push('技术/元对话模式：放宽术语过滤');

  // 代码块 / JSON
  text = text.replace(/```[\s\S]*?```/g, '');
  const lines = text.split(/\r?\n/);
  const keptLines: string[] = [];
  let cutForImpersonation = false;
  for (const line of lines) {
    if (cutForImpersonation) break;
    const l = line.trim();
    if (!l) {
      keptLines.push('');
      continue;
    }
    if (looksLikeJson(l) && !hasSticker(l)) {
      // 表情包 token（[[sticker:xx]]）也以 [ 开头，别误当 JSON 删了
      notes.push('删掉JSON残留');
      continue;
    }
    let cur = stripMarkdown(l);
    cur = cur.replace(ROLE_PREFIX_RE, '');
    if (ctx.agentName) {
      // 兜底：模型有时会写成"占雨：xxxx"
      for (const sep of ['：', ':']) {
        const prefix = `${ctx.agentName}${sep}`;
        if (cur.startsWith(prefix)) {
          cur = cur.slice(prefix.length).trim();
          break;
        }
      }
    }
    cur = cur.replace(META_PAREN_RE, '');
    if (selfRe.test(cur)) {
      notes.push(`删掉AI腔: ${truncate(cur, 24)}`);
      continue;
    }
    if (ctx.userName && startsWithNameColon(cur.trimStart(), ctx.userName)) {
      notes.push('截掉替用户发言');
      cutForImpersonation = true;
      continue;
    }
    keptLines.push(cur);
  }
  text = keptLines.join('\n');

  // 句子级清理
  const sent = cleanSentences(text, ctx.userName, selfRe);
  notes.push(...sent.notes);
  text = sent.text;

  // 空白与重复行整理
  text = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    // 去掉中文与括号之间多余的空格（模型爱在动作后面加空格）
    .map((l) =>
      l
        .replace(/([）)])\s+(?=[\u4e00-\u9fa5“”。，！？…])/g, '$1')
        .replace(/(?<=[\u4e00-\u9fa5])[ \t]+(?=[（(])/g, '')
        .replace(/(?<=[\u4e00-\u9fa5])[ \t]+(?=[\u4e00-\u9fa5“”。，！？…])/g, '')
    )
    .join('\n');
  const dedupLines: string[] = [];
  for (const l of text.split('\n')) {
    if (dedupLines[dedupLines.length - 1] === l) continue;
    dedupLines.push(l);
  }
  text = dedupLines.join('\n');

  // 统一动作写法（各种括号 → 全角括号），再剔除机械动作 / 与场景打架的动作 / 刚用过的动作
  text = normalizeParens(text);
  // 语境基调：难过/安慰/冲突等严肃语境 → 补/换动作时避开俏皮类，免得"挑眉"出现在陪哭的句子里
  const heavyTone = /(难过|伤心|委屈|哭|眼泪|累|烦|糟|压力|焦虑|不安|低落|崩溃|生气|吵架|冷战|病|疼|痛|失败|不顺|疲惫|心累|丧)/.test(
    `${ctx.userMessage || ''} ${ctx.mood || ''}`
  );
  // 本段已有的动作（含将被剔除的）：补/换动作时不与它们重复
  const usedLocal: string[] = [
    ...(ctx.recentActions || []),
    ...[...text.matchAll(/（([^）)\n]{1,120})）/g)].map((m) => String(m[1]).trim()),
  ];
  const pickFitting = (avoidTag?: ActionTag): string | null => {
    const picked = pickAction({
      stage: ctx.stage,
      personality: ctx.personality || {},
      attachmentStyle: ctx.attachmentStyle || 'secure',
      used: usedLocal,
      // 心情 + 他的话 + 她的话一起作为语境：带情绪标签的动作只有情境命中才容易被选中
      mood: `${ctx.mood || ''} ${ctx.userMessage || ''} ${text}`,
      avoidTag,
      // 兜底补动作时只挑"轻"的动作：不会和台词语义打架
      subtleOnly: true,
      moodAware: true,
      // 线下时避开"屏幕/对话框"类动作，免得情景打架
      scene: ctx.scene,
      tone: heavyTone ? 'heavy' : undefined,
    });
    if (picked) usedLocal.push(picked.text);
    return picked ? picked.text : null;
  };
  const act = filterActions(text, ctx, () => pickFitting());
  text = act.text;
  notes.push(...act.notes);
  // 括号转换后可能留下多余空格，清一遍
  text = text
    .replace(/([）)])\s+(?=[\u4e00-\u9fa5“”。，！？…])/g, '$1')
    .replace(/(?<=[\u4e00-\u9fa5，。！？…])\s+(?=[（(])/g, '');

  // 连贯性：动作里她已经睡过去了 → 该动作后面的台词一律删掉
  const slept = trimTalkAfterSleepOnset(text);
  if (slept.note) notes.push(slept.note);
  text = slept.text;

  const stickerPresent = hasSticker(text);

  // 长度整形：优先在完整句末（。！？…）截断，绝不在句末可达时从逗号处切半句；整段找不到句末才退到逗号位。上限放得很宽，正常回复不会被切
  const CAP = 1000;
  if (!stickerPresent && text.length > CAP) {
    const cut = text.slice(0, CAP);
    const sentEnd = Math.max(
      cut.lastIndexOf('。'),
      cut.lastIndexOf('！'),
      cut.lastIndexOf('？'),
      cut.lastIndexOf('…')
    );
    const comma = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('；'));
    const idx = sentEnd > 80 ? sentEnd : comma;
    if (idx > 80) {
      text = cut.slice(0, idx + 1);
      notes.push(`长度整形 ${raw.length}→${text.length}`);
    } else {
      notes.push(`找不到句末，整段保留 ${text.length}`);
    }
  }

  text = text.trim();
  text = text.replace(/^[，,、。；;]+/, '').trim();

  let fallback = false;
  if (text.replace(/[（(][^）)\n]*[）)]/g, '').trim().length < 1) {
    const fb = fallbackReply(ctx);
    // 只剩动作时：动作太短/疑似占位（如"（无）"）就不保留，直接换成兜底台词
    const actionOnly = text.trim().replace(/[（(]([^）)\n]*)[）)]/g, '$1').replace(/\s/g, '');
    if (text.trim() && actionOnly.length >= 2) {
      if (ACTION_SLEPT_RE.test(text)) {
        // 动作里她已经睡过去了：不能再补台词（睡着的人不会说话）
        notes.push('动作里已睡过去，不补台词');
      } else {
        // 她只写了动作没说话：保留动作，补一句台词，而不是把动作整个丢掉
        text = `${text.trim()}\n${fb}`;
        notes.push('补兜底台词（保留动作）');
      }
    } else {
      text = fb;
      notes.push('使用兜底台词');
    }
    fallback = true;
  }

  // 神态/动作兜底：保证"看得见她"（发了表情包就不再硬塞动作）
  let addedAction = false;
  const hasAction = /[（(][^）)\n]{1,120}[）)]/.test(text) || stickerPresent;
  if (!hasAction && !stickerPresent) {
    const lastAction = (ctx.recentActions || [])[0];
    const avoidTag: ActionTag | undefined = lastAction ? tagOfAction(lastAction) || undefined : undefined;
    const picked = pickFitting(avoidTag);
    if (picked) {
      text = `${text}\n（${picked}）`;
      addedAction = true;
      notes.push(`补动作: ${picked}`);
    }
  }

  return {
    text: text.trim(),
    changed: notes.length > 0,
    addedAction,
    fallback,
    notes,
  };
}