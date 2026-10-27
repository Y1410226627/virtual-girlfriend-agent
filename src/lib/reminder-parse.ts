// 从用户消息里识别"到点提醒我"的意图（纯函数、可注入 now，便于确定性测试）
// 只处理明确的提醒请求 + 明确时间；其余一律返回 null（宁可不提醒，也不误报）
export interface ParsedReminder {
  due: Date;
  /** 到点要提醒他的内容（已去掉时间与"提醒我"这类词） */
  content: string;
  /** 给提示词/界面用的人话时间（如「今天 21:30」） */
  dueText: string;
}

const INTENT = /(提醒我|提醒一下我|叫我|喊我)/;
const INTENT_SOFT = /(记得|别忘了|别忘记)[^。！？!?；;\n]{0,12}(提醒|叫我|喊我)/;
const REL = /(\d{1,3})\s*(分钟|分|小时|钟头)\s*(?:之后|以后|后)/;
const SOFT_REL = /(等会儿|等会|待会儿|待会|一会儿|过会儿|过一阵子?|过一阵)/;
const DAY = /(今天|今晚|明天|明早|明晚|后天)/;
const PERIOD = /(凌晨|早上|上午|中午|下午|傍晚|晚上)/;
const CLOCK = /(\d{1,2})\s*(?:[:：点])\s*(\d{1,2})?\s*(分|半)?/;
const WEEK = /(下?周[一二三四五六日天]|星期[一二三四五六日天])/;

const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

function dayOffset(label: string): number {
  if (label === '后天') return 2;
  if (label === '今天' || label === '今晚') return 0;
  return 1; // 明天 / 明早 / 明晚
}

function weekdayOffset(label: string, base: Date): number {
  if (label.startsWith('星期')) label = '周' + label.slice(2);
  const ch = label.slice(-1);
  const target = WEEKDAY[ch] ?? 1;
  let offset = (target - base.getDay() + 7) % 7;
  if (offset === 0) offset = 7;
  if (label.startsWith('下周')) offset += 7;
  return offset;
}

/** 人话时间标签（今天/明天/具体日期 + HH:mm） */
export function formatDueLabel(due: Date, now: Date = new Date()): string {
  const sameDay = due.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = sameDay
    ? '今天'
    : due.toDateString() === tomorrow.toDateString()
      ? '明天'
      : `${due.getMonth() + 1}月${due.getDate()}日`;
  const hh = String(due.getHours()).padStart(2, '0');
  const mm = String(due.getMinutes()).padStart(2, '0');
  return `${day} ${hh}:${mm}`;
}

/**
 * 解析提醒意图。支持：
 *   - 相对：20分钟后 / 2小时后 / 等会儿
 *   - 绝对：提醒我明天早上8点交报告 / 今晚9点半… / 周三下午3点… / 明天（默认 9:00）
 */
export function parseReminder(text: string, now: Date = new Date()): ParsedReminder | null {
  const raw = String(text || '').replace(/\r\n?/g, ' ').trim();
  if (!raw || raw.length > 120) return null;
  if (!INTENT.test(raw) && !INTENT_SOFT.test(raw)) return null;

  const spans: string[] = [];
  let due: Date | null = null;

  // 1) 相对时间
  const rel = raw.match(REL);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2] ?? '';
    const minutes = /小时|钟头/.test(unit) ? n * 60 : n;
    if (minutes > 0 && minutes <= 60 * 24 * 30) {
      due = new Date(now.getTime() + minutes * 60000);
      spans.push(rel[0]);
    }
  }

  if (!due) {
    const dayM = raw.match(DAY);
    const periodM = raw.match(PERIOD);
    const weekM = raw.match(WEEK);
    const clockM = raw.match(CLOCK);
    // "第3点/这3点"这类不是时刻，排除
    const clockIsOrdinal =
      clockM?.index != null && /[第这那哪]/.test(raw.slice(Math.max(0, clockM.index - 2), clockM.index));

    if (clockM && !clockIsOrdinal) {
      const h = Number(clockM[1]);
      let m = clockM[2] ? Number(clockM[2]) : 0;
      if (clockM[3] === '半') m = 30;
      let hh = h;
      // 「今晚/明晚」即使没写"晚上"也按晚间处理（否则 9 点会被当成早上 9 点）
      const period = periodM?.[1] || (dayM && /今晚|明晚/.test(dayM[1] ?? '') ? '晚上' : '');
      if (/下午|傍晚|晚上/.test(period) && hh < 12) hh += 12;
      if (period === '中午' && hh < 11) hh = 12;
      if (period === '凌晨' && hh >= 12) hh -= 12;
      if (hh === 24) hh = 0;
      if (hh < 0 || hh > 23 || m < 0 || m > 59) return null;
      const base = new Date(now);
      const dayLabel = dayM?.[1];
      const weekLabel = weekM?.[1];
      const offset = weekLabel ? weekdayOffset(weekLabel, base) : dayLabel ? dayOffset(dayLabel) : 0;
      const d = new Date(base);
      d.setDate(d.getDate() + offset);
      d.setHours(hh, m, 0, 0);
      // 没有指明哪一天、且这个点已经过了 → 顺延到明天
      if (!weekM && !dayM && d.getTime() <= now.getTime() + 30_000) d.setDate(d.getDate() + 1);
      due = d;
      spans.push(clockM[0]);
      if (periodM) spans.push(periodM[0]);
      if (dayM) spans.push(dayM[0]);
      if (weekM) spans.push(weekM[0]);
    } else if (dayM || weekM) {
      // 只有日期没有钟点 → 用默认时刻（明早 8:00 / 今晚·明晚 20:00 / 其余 9:00）
      const tag = dayM?.[1] ?? weekM?.[1] ?? '';
      const base = new Date(now);
      const offset = weekM ? weekdayOffset(weekM[1] ?? '', base) : dayOffset(dayM?.[1] ?? '明天');
      const hh = /明早/.test(tag) ? 8 : /今晚|明晚/.test(tag) ? 20 : 9;
      const d = new Date(base);
      d.setDate(d.getDate() + offset);
      d.setHours(hh, 0, 0, 0);
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
      due = d;
      spans.push(tag);
    } else {
      const soft = raw.match(SOFT_REL);
      if (soft) {
        due = new Date(now.getTime() + 15 * 60000);
        spans.push(soft[0]);
      }
    }
  }

  if (!due) return null;
  if (due.getTime() <= now.getTime() + 30_000) return null;
  if (due.getTime() - now.getTime() > 30 * 86400000) return null;

  let content = raw;
  for (const s of spans) if (s) content = content.split(s).join(' ');
  content = content
    .replace(/提醒一下我|提醒一下|提醒我|叫我|喊我|记得|别忘了|别忘记/g, ' ')
    .replace(/[，。、,；;！!？?~～\s]+/g, ' ')
    .trim()
    .slice(0, 80);

  return { due, content: content || '他交代的事', dueText: formatDueLabel(due, now) };
}
