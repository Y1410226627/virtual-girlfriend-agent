// 回复校验层（ResponseValidator，务实版 · P1-13）
// 人味层（humanize）只管"格式与 AI 腔"，不管"她到底有没有接住他说的内容"。
// 这里用零 LLM 调用的启发式规则，给出一条回复的"是否答非所问/跑题/复读/太短"的粗判，
// 供 chat 路由决定"要不要自动重答一次"。纯函数、无副作用、不依赖数据库，便于确定性测试。

export interface ValidateReplyOptions {
  /** 用户这一条消息 */
  userMessage: string;
  /** 她生成的回复（已过人味层） */
  reply: string;
  /** 最近几条她的回复（用于复读检测） */
  recentReplies?: string[];
}

export interface ValidationResult {
  /** 0~1，越高越像一条好回复（1 = 没有命中任何问题） */
  score: number;
  /** 命中的问题标签 */
  issues: string[];
  /** 是否硬失败（答非所问，必须重答） */
  hardFail: boolean;
}

/* ------------------------------------------------------------------ */
/* 阈值与权重（具名常量，便于日后单独调整）                             */
/* ------------------------------------------------------------------ */
/** 命中 hardFail 或 score 低于此值时，chat 路由触发自动重答（最多一次） */
export const RETRY_SCORE_THRESHOLD = 0.35;
/** 用户消息与回复的字符 bigram 覆盖率 ≤ 此值 ≈ "完全没接住" */
const QUESTION_OVERLAP_MAX = 0.02;
/** 话题连续度：覆盖率低于此值判为跑题（soft） */
const TOPIC_OFF_COVERAGE = 0.1;
/** 用户消息短于此长度时，不判跑题（太短没有足够线索） */
const TOPIC_OFF_USER_MIN = 4;
/** 与历史回复的 bigram Jaccard 相似度高于此值判为复读 */
const REPETITION_JACCARD = 0.75;
/** 去除（动作）后回复短于此长度算"极短" */
const TOO_SHORT_LEN = 4;
/** 用户消息长于此长度才算"说了很多"（用于极短判定） */
const USER_LONG_MIN = 12;

/** 各问题的扣分权重 */
export const ISSUE_WEIGHTS: Record<string, number> = {
  question_ignored: 0.6,
  topic_off: 0.3,
  repetition: 0.25,
  too_short: 0.35,
};

/** 明显提问：问号结尾，或含疑问词 */
export const QUESTION_RE = /[?？]\s*$|[吗呢]|怎么|为什么|什么|哪|谁|多少|是不是/;
/** 回应型开场（去动作后以这些开头，视为"接住了"的信号） */
const RESPONSE_OPENERS = /^(嗯|对|确实|因为|就是|我觉|你问|哈哈|是的|当然|其实|唔|哎|抱歉|对不起)/;

/* ------------------------------------------------------------------ */
/* 文本处理小工具                                                       */
/* ------------------------------------------------------------------ */
/** 去掉（括号神态动作）/ (parenthetical action) */
function stripActions(s: string): string {
  return String(s || '').replace(/（[^）]*）|\([^)]*\)/g, '');
}

/** 归一化：去动作、去所有非字母数字字符（含标点/空白/Emoji） */
function normalize(s: string): string {
  return stripActions(s).replace(/[^\p{L}\p{N}]/gu, '');
}

/** 中文按 2-gram 切分的字符集合 */
function charBigrams(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 回复对用户消息的 bigram 覆盖率（0~1） */
function coverageOf(userGrams: Set<string>, replyGrams: Set<string>): number {
  if (!userGrams.size) return 0;
  let inter = 0;
  for (const g of userGrams) if (replyGrams.has(g)) inter++;
  return inter / userGrams.size;
}

/**
 * 启发式校验一条回复。绝不抛错：任何输入都会被安全处理。
 */
export function validateReply(opts: ValidateReplyOptions): ValidationResult {
  const userMessage = String(opts.userMessage || '');
  const reply = String(opts.reply || '');
  const recentReplies = Array.isArray(opts.recentReplies) ? opts.recentReplies : [];

  const cleanUser = normalize(userMessage);
  const cleanReply = normalize(reply);
  const userGrams = charBigrams(cleanUser);
  const replyGrams = charBigrams(cleanReply);
  const coverage = coverageOf(userGrams, replyGrams);

  const issues: string[] = [];

  // (a) 明显提问却完全没接住 → hardFail
  const isQuestion = QUESTION_RE.test(userMessage);
  const hasOpener = RESPONSE_OPENERS.test(cleanReply);
  if (isQuestion && coverage <= QUESTION_OVERLAP_MAX && !hasOpener) {
    issues.push('question_ignored');
  }

  // (b) 话题连续度：没覆盖到用户消息的任何实词 → 跑题（soft）
  if (cleanUser.length >= TOPIC_OFF_USER_MIN && coverage < TOPIC_OFF_COVERAGE) {
    issues.push('topic_off');
  }

  // (c) 复读：与任意一条最近回复高度相似
  for (const prev of recentReplies) {
    const prevGrams = charBigrams(normalize(prev));
    if (!prevGrams.size || !replyGrams.size) continue;
    let same = 0;
    for (const g of replyGrams) if (prevGrams.has(g)) same++;
    const union = replyGrams.size + prevGrams.size - same;
    const jaccard = union > 0 ? same / union : 0;
    if (jaccard > REPETITION_JACCARD) {
      issues.push('repetition');
      break;
    }
  }

  // (d) 空/极短：用户说了很多，她却几乎没说话
  if (cleanReply.length < TOO_SHORT_LEN && cleanUser.length >= USER_LONG_MIN) {
    issues.push('too_short');
  }

  let deduction = 0;
  for (const issue of issues) deduction += ISSUE_WEIGHTS[issue] ?? 0;
  const score = Math.max(0, Math.min(1, 1 - deduction));

  return { score, issues, hardFail: issues.includes('question_ignored') };
}