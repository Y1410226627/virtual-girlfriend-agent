// 通用工具函数

export function clamp(v: number, min: number, max: number): number {
  const n = Number(v);
  if (Number.isNaN(n)) return min; // NaN → min；±Infinity 交给下面的 Math.min/max 收敛到边界
  return Math.min(max, Math.max(min, n));
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 本地时区的 YYYY-MM-DD */
export function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function localTimeStr(d: Date = new Date()): string {
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${mi}`;
}

export function localHour(d: Date = new Date()): number {
  return d.getHours();
}

export function hoursSince(iso: string | null | undefined): number {
  if (!iso) return 999;
  const h = (Date.now() - new Date(iso).getTime()) / 3600000;
  return isFinite(h) ? h : 999; // 非 ISO 脏数据不能让上层拿到 NaN
}

export function daysSince(iso: string | null | undefined): number {
  if (!iso) return 999;
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}

/**
 * 两个时间点相差的「自然日」数：按本地日历日计算，忽略时分秒（同一天=0，昨天=1）。
 * 用各自日历日的 UTC 零点相减，跨月/跨年/夏令时都不会错位；任一为非法时间返回 0。
 * 与数据库里其它 localDateStr 的口径一致（本机无夏令时，此写法对任何时区都稳妥）。
 */
export function calendarDaysBetween(from: string | Date, to: string | Date = new Date()): number {
  const a = from instanceof Date ? from : new Date(from);
  const b = to instanceof Date ? to : new Date(to);
  if (!isFinite(a.getTime()) || !isFinite(b.getTime())) return 0;
  const av = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const bv = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bv - av) / 86400000);
}

export function minutesSince(iso: string | null | undefined): number {
  if (!iso) return 99999;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

/** 中文友好时间：今天 14:30 / 昨天 22:10 / 10月3日 09:12 */
export function humanTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = localTimeStr(d);
  if (sameDay) return `今天 ${hm}`;
  const y = new Date();
  y.setDate(y.getDate() - 1); // 日历日回退（不能用固定 86400000ms，夏令时/跨月会错）
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export function cnDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** 从 unknown 异常里取可读的消息（catch 块统一用它代替 `e: any`） */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : String(e);
}

/** 从 LLM 输出里稳健地抽取 JSON 对象（含多种修复策略） */
export function parseJsonLoose(text: string): unknown {
  if (!text) return null;
  let t = String(text).trim();

  // ```json ... ``` 包裹
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1]!.trim();

  const candidates: string[] = [];
  candidates.push(t);
  const balanced = firstBalancedObject(t);
  if (balanced) candidates.push(balanced);

  // 针对模型偶发的 "{{...}}"（双大括号）等情况做修复
  for (const c of [...candidates]) {
    const trimmed = c.trim();
    if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
      candidates.push(trimmed.slice(1, -1));
    }
    if (trimmed.startsWith('{') && trimmed.endsWith('}}')) {
      candidates.push(trimmed.slice(0, -1));
    }
    candidates.push(trimmed.replace(/,\s*([}\]])/g, '$1'));
    candidates.push(
      trimmed
        .replace(/[“”]/g, '"')
        .replace(/,\s*([}\]])/g, '$1')
    );
  }

  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object') return v;
    } catch {
      /* 继续尝试下一种修复 */
    }
  }
  return null;
}

/** 括号配对：取出第一个完整平衡的 JSON 对象 */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // 未闭合：返回从 start 到结尾（可能被 max_tokens 截断）
  if (depth > 0) {
    let tail = text.slice(start);
    // 尝试补齐被截断的括号
    const openObj = (tail.match(/{/g) || []).length - (tail.match(/}/g) || []).length;
    const openArr = (tail.match(/\[/g) || []).length - (tail.match(/]/g) || []).length;
    for (let i = 0; i < openArr; i++) tail += ']';
    for (let i = 0; i < openObj; i++) tail += '}';
    return tail.replace(/,\s*([}\]])/g, '$1');
  }
  return null;
}

export function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * 长消息头尾保留：约 40% 头 + 60% 尾，中间用 … 省略（结果总长不超过 max，含省略号本身）。
 * 用于历史对话注入 Prompt：早期铺垫与最新落点都可保留，避免只截头丢掉结论。
 * 极端短文本（max 很小）退化为"只留头"或纯省略号，绝不越界。
 */
export function truncateMiddle(s: string, max = 800): string {
  const t = String(s || '');
  const n = Math.floor(max);
  if (!t || n <= 0) return '';
  if (t.length <= n) return t;
  const ell = '…';
  if (n <= ell.length) return ell; // n=1：只剩省略号
  const budget = n - ell.length;
  if (budget < 2) return t.slice(0, budget) + ell; // n=2：头 1 + 省略号
  const headLen = Math.max(1, Math.round(budget * 0.4));
  const tailLen = Math.max(1, budget - headLen);
  return t.slice(0, headLen) + ell + t.slice(t.length - tailLen);
}

/** 简单哈希（用于本地 embedding 兜底） */
export function hashString(str: string, seed = 0): number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 随机延迟（毫秒），模拟真人打字 */
export function typingDelayMs(text: string): number {
  const base = Math.min(2200, 500 + text.length * 22);
  return base + Math.random() * 900;
}