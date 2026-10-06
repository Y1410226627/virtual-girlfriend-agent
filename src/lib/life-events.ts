// 生活系统 · 可控事件层：她开始做一件事，用户可以控制它什么时候结束、到期她会主动来说
// 由 life.ts 拆分而来（原样搬移，行为不变）
import { dbGet, dbRun, DEFAULT_USER_ID, boolSetting, cGet, cRun } from './db';
import { cId } from './companion-context';
import { clamp, nowIso, localTimeStr, round1 } from './utils';
import { getHealth, getPsychology, getActivity, getLocation, logLife, isWeekend } from './life-core';

/* ------------------------------------------------------------------ */
/* 可控事件：她开始做一件事，用户可以控制它什么时候结束、到期她会主动来说 */
/* ------------------------------------------------------------------ */
export interface OngoingEventRow {
  id: number;
  user_id: number;
  activity: string;
  event_type: string;
  started_at: string;
  expected_end_at: string | null;
  duration_mode: string;
  notified_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** 活动名 → 事件类型 */
export function eventTypeOf(activity: string): string {
  const a = String(activity || '');
  if (/睡|午休|小憩|打盹|眯一会|躺下休息/.test(a)) return 'sleep';
  // 注意顺序：做饭/洗碗/买菜 必须在 meal 之前判断，否则"做饭"会被当成"吃了一顿"
  if (/收拾|打扫|洗衣服|做饭|家务|整理|晾|洗碗|买菜|清理/.test(a)) return 'chore';
  if (/吃|饭|餐|外卖|夜宵/.test(a)) return 'meal';
  if (/洗澡|洗漱|冲澡|洗头|泡澡/.test(a)) return 'shower';
  if (/运动|跑步|健身|瑜伽|游泳|打球|跳绳|锻炼|拉伸/.test(a)) return 'sport';
  if (/游戏|开黑|排位|下棋|打牌/.test(a)) return 'game';
  if (/聊天|视频|通话|打电话|聚会|串门|下午茶|约会/.test(a)) return 'social';
  if (/化妆|护肤|面膜|泡脚|敷|美甲|梳洗|洗脸|吹头发/.test(a)) return 'care';
  if (/上课|考试|开会|自习|写作业|写论文|工作|加班|学习|复习|背单词|网课|看文献/.test(a)) return 'focus';
  if (/出门|逛街|超市|商场|买东西|散步|遛|朋友|电影院|取快递|拿快递|逛逛/.test(a)) return 'out';
  if (/收拾|打扫|洗衣服|做饭|家务|整理|晾|洗碗|买菜|清理/.test(a)) return 'chore';
  if (/回家|路上|地铁|公交|打车|通勤|去学校|出发|赶车/.test(a)) return 'commute';
  if (/看剧|看电|看书|刷|听歌|躺|休息|发呆|放空|追剧/.test(a)) return 'leisure';
  return 'other';
}

/** 事件类型 → 作息推进用的 activity_type（沿用原有词汇） */
export function activityTypeOfEvent(eventType: string): string {
  switch (eventType) {
    case 'sleep': return 'sleep';
    case 'meal': return 'meal';
    case 'shower': return 'shower';
    case 'focus': return 'class';
    case 'out': return 'out';
    case 'sport': return 'out';
    case 'chore': return 'chores';
    case 'commute': return 'commute';
    case 'leisure': return 'leisure';
    case 'game': return 'leisure';
    case 'social': return 'leisure';
    case 'care': return 'leisure';
    default: return 'idle';
  }
}

/** 事件结束后的自然过渡状态（等作息推进自然接上） */
const POST_EVENT_ACTIVITY: Record<string, string> = {
  sleep: '刚睡醒，还迷迷糊糊的',
  meal: '刚吃完饭，很满足',
  shower: '刚洗完澡，头发还潮着',
  focus: '刚忙完，松了口气',
  out: '刚回来，还在缓',
  commute: '刚到，缓一口气',
  chore: '刚干完活，歇一会儿',
  leisure: '刚结束，还沉浸在里面的感觉',
  sport: '刚运动完，出了一身汗',
  game: '刚打完一局，手还有点酸',
  social: '刚聊完天，心情不错',
  care: '刚收拾好自己，清清爽爽的',
  other: '刚忙完，正在歇口气',
};

/**
 * 可控事件进行中的"额外影响"：每 0.5 小时一步，叠加在作息漂移之上。
 * 睡一觉要能明显回精力，吃一顿要明显回饥饿，洗澡要放松，忙起来要消耗——让事件真的改变她的状态。
 */
export const EVENT_DRIFT: Record<
  string,
  { energy?: number; hunger?: number; sleepQ?: number; me?: number; stress?: number; loneliness?: number }
> = {
  sleep: { energy: 12, hunger: -1, sleepQ: 3, me: 8, stress: -2, loneliness: -1 },
  meal: { energy: 3, hunger: 40, me: 3, loneliness: -2 },
  shower: { energy: 3, sleepQ: 2, me: 2, stress: -2 },
  focus: { energy: -1, me: -5, stress: 1.5, loneliness: 1 },
  out: { energy: -1, hunger: -2, me: -1.5, stress: 0.5, loneliness: -2 },
  sport: { energy: -4, hunger: -4, sleepQ: 1, me: 2, stress: -4, loneliness: -1 },
  game: { energy: -2, me: -2, stress: -1.5, loneliness: -1 },
  social: { energy: -1, me: 3, stress: -2, loneliness: -3 },
  care: { energy: -1, sleepQ: 0.5, me: 2, stress: -1.5 },
  chore: { energy: -1.5, hunger: -1, me: -2, stress: 0.5 },
  commute: { energy: -1, me: -1 },
  leisure: { energy: 1.5, sleepQ: 0.5, me: 2, stress: -1.5, loneliness: -1 },
  other: { energy: -0.5, me: -1 },
};

/** 按"等效步数"（每步 0.5 小时）直接结算某个事件的影响（立即结束时用） */
export function applyEventEffects(eventType: string, steps: number): void {
  const eff = EVENT_DRIFT[eventType] ?? EVENT_DRIFT.other!;
  const n = Math.max(0, Math.floor(steps));
  if (n <= 0) return;
  const h = getHealth();
  const p = getPsychology();
  dbRun(
    'UPDATE agent_health SET energy = ?, hunger = ?, sleep_quality = ?, updated_at = ? WHERE companion_id = ?',
    round1(clamp(h.energy + (eff.energy || 0) * n, 0, 100)),
    round1(clamp(h.hunger + (eff.hunger || 0) * n, 0, 100)),
    round1(clamp(h.sleep_quality + (eff.sleepQ || 0) * n, 0, 100)),
    nowIso(),
    cId()
  );
  dbRun(
    'UPDATE agent_psychology SET mental_energy = ?, stress = ?, loneliness = ?, updated_at = ? WHERE companion_id = ?',
    round1(clamp(p.mental_energy + (eff.me || 0) * n, 0, 100)),
    round1(clamp(p.stress + (eff.stress || 0) * n, 0, 100)),
    round1(clamp(p.loneliness + (eff.loneliness || 0) * n, 0, 100)),
    nowIso(),
    cId()
  );
}

/**
 * 立即结束时的"等效时长"结算：按用户指定的总时长回填影响，
 * 减去事件真实已经流逝的那部分（那部分已由作息推进结算过），避免重复计算。
 */
export function applyEventEffectsAsIf(evt: OngoingEventRow, assumeMinutes: number): number {
  const started = new Date(evt.started_at).getTime();
  const actualMin = isFinite(started) ? Math.max(0, (Date.now() - started) / 60000) : 0;
  const extraMin = Math.max(0, assumeMinutes - actualMin);
  const steps = Math.floor(extraMin / 30);
  if (steps <= 0) return 0;
  applyEventEffects(evt.event_type, steps);
  logLife('event', evt.activity, `按 ${Math.round(assumeMinutes / 60 * 10) / 10} 小时结算`, '立即结束：按指定等效时长结算影响');
  return steps;
}

function isoAfter(from: Date, minutes: number): string {
  return new Date(from.getTime() + minutes * 60000).toISOString();
}

function clockTarget(from: Date, hour: number, minute: number): Date {
  const t = new Date(from);
  t.setHours(hour, minute, 0, 0);
  if (t.getTime() <= from.getTime() + 60000) t.setDate(t.getDate() + 1);
  return t;
}

/** 解析"预计结束"的文字（30分钟 / 1小时 / 23:30 / 到7点 / 明早 …），识别不了返回 null */
export function parseExpectedEnd(text: string, from: Date = new Date()): string | null {
  const t = String(text || '').trim();
  if (!t) return null;
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:小时|钟头|h|hr)/i);
  if (m) return isoAfter(from, clamp(Number(m[1]) * 60, 5, 720));
  if (/一个?半(?:小时|钟头)/.test(t)) return isoAfter(from, 90);
  if (/半(?:个)?(?:小时|钟头)/.test(t)) return isoAfter(from, 30);
  m = t.match(/(\d+)\s*(?:分钟|分|min)/i);
  if (m) return isoAfter(from, clamp(Number(m[1]), 5, 720));
  if (/一会|马上|很快|几分钟|待会/.test(t)) return isoAfter(from, 15);
  m = t.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (m) return clockTarget(from, Number(m[1]), Number(m[2])).toISOString();
  m = t.match(/到\s*(\d{1,2})\s*[点時时]\s*(半|\d{1,2})?/);
  if (m) return clockTarget(from, Number(m[1]), m[2] === '半' ? 30 : Number(m[2] || 0)).toISOString();
  if (/明早|明天早上/.test(t)) {
    const target = new Date(from);
    target.setDate(target.getDate() + 1);
    target.setHours(7, 30, 0, 0);
    return target.toISOString();
  }
  return null;
}

/** 智能时长：最符合真人自然状态的时长（按事件类型 + 当前时间推导） */
export function smartDurationMinutes(eventType: string, activity = '', from: Date = new Date()): number {
  const hour = from.getHours() + from.getMinutes() / 60;
  switch (eventType) {
    case 'sleep': {
      if (hour >= 21.5 || hour < 4) {
        // 晚上的觉：睡到第二天早上（周末晚一点）
        const target = new Date(from);
        if (hour >= 21.5) target.setDate(target.getDate() + 1);
        const wake = isWeekend(target) ? 9.5 : 7.5;
        target.setHours(Math.floor(wake), Math.round((wake % 1) * 60), 0, 0);
        return Math.round(clamp((target.getTime() - from.getTime()) / 60000, 180, 720));
      }
      if (hour >= 11.5 && hour <= 16.5) return 90; // 午睡
      if (hour < 11.5) return 60;                  // 早上回笼觉
      return 75;                                   // 傍晚打盹
    }
    case 'meal': return /早/.test(activity) ? 25 : 30;
    case 'shower': return 35;
    case 'focus': return /课|考试|开会/.test(activity) ? 90 : 60;
    case 'out': return 120;
    case 'commute': return 35;
    case 'chore': return 40;
    case 'leisure': return 60;
    default: return 40;
  }
}

export function getActiveEvent(): OngoingEventRow | null {
  const row = cGet<OngoingEventRow>(
    'SELECT * FROM ongoing_events WHERE companion_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1'
  );
  return row || null;
}

/** 结束当前事件；活动切到"刚结束"的自然状态（之后作息推进会自然接上） */
export function endOngoingEvent(reason: string, opts: { keepActivity?: boolean } = {}): OngoingEventRow | null {
  const evt = getActiveEvent();
  if (!evt) return null;
  const now = nowIso();
  dbRun('UPDATE ongoing_events SET ended_at = ?, end_reason = ?, updated_at = ? WHERE id = ?', now, reason, now, evt.id);
  if (!opts.keepActivity) {
    const cur = getActivity();
    const post = POST_EVENT_ACTIVITY[evt.event_type] || POST_EVENT_ACTIVITY.other;
    dbRun(
      'UPDATE agent_activity SET current_activity = ?, activity_type = ?, started_at = ?, expected_end_at = NULL, updated_at = ? WHERE companion_id = ?',
      post, evt.event_type === 'sleep' ? 'morning' : 'idle', now, now, cId()
    );
    logLife('activity', cur.current_activity, post, `事件结束（${reason}）：${evt.activity}`);
  }
  return evt;
}

/** 注册一个可控事件（先静默结束上一个未结束的事件）；返回事件行 */
export function registerOngoingEvent(activity: string, opts: { expectedEndText?: string } = {}): OngoingEventRow | null {
  if (!boolSetting('life_enabled', true)) return null;
  const act = String(activity || '').trim();
  if (!act || act.length > 24) return null;
  const active = getActiveEvent();
  // "刚到家/刚睡醒"这类是"已经结束"的状态：不是新事件，但要先把旧事件结束掉
  // （否则会出现"正在做：刚到家"与"你正在「出门」当中"同时注入的矛盾状态）
  if (/^刚/.test(act)) {
    if (active) endOngoingEvent('superseded', { keepActivity: true });
    return null;
  }
  const now = new Date();
  const eventType = eventTypeOf(act);
  if (active) {
    // 同一个事件正在进行（"睡觉" 与 "睡觉/休息" 这种包含关系也算同一个）→ 不重复注册
    const sameAct =
      active.activity === act || active.activity.includes(act) || act.includes(active.activity);
    const fresh = !!active.expected_end_at && new Date(active.expected_end_at).getTime() > now.getTime() + 60000;
    if (sameAct && fresh) return active;
    endOngoingEvent('superseded', { keepActivity: true });
  }
  const expected = parseExpectedEnd(opts.expectedEndText || '', now) || isoAfter(now, smartDurationMinutes(eventType, act, now));
  const iso = now.toISOString();
  const { lastInsertRowid } = cRun(
    'INSERT INTO ongoing_events (companion_id, user_id, activity, event_type, started_at, expected_end_at, duration_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    DEFAULT_USER_ID, act, eventType, iso, expected, 'smart', iso, iso
  );
  logLife('event', '', act, `开始事件：${eventType}，预计 ${localTimeStr(new Date(expected))} 结束`);
  return dbGet<OngoingEventRow>('SELECT * FROM ongoing_events WHERE id = ?', lastInsertRowid) || null;
}

/** 用户设定事件结束：smart=按这类事情最自然的时长重算；manual=手动分钟数 */
export function setEventExpectedEnd(mode: 'smart' | 'manual', minutes = 0): OngoingEventRow | null {
  const evt = getActiveEvent();
  if (!evt) return null;
  const now = new Date();
  let endIso: string;
  if (mode === 'manual') {
    endIso = isoAfter(now, clamp(Math.round(minutes) || 30, 5, 720));
  } else {
    const startMs = new Date(evt.started_at).getTime();
    let endMs = (isFinite(startMs) ? startMs : now.getTime()) + smartDurationMinutes(evt.event_type, evt.activity, new Date(isFinite(startMs) ? startMs : now.getTime())) * 60000;
    if (endMs <= now.getTime() + 5 * 60000) {
      endMs = now.getTime() + smartDurationMinutes(evt.event_type, evt.activity, now) * 60000;
    }
    endIso = new Date(endMs).toISOString();
  }
  dbRun(
    'UPDATE ongoing_events SET expected_end_at = ?, duration_mode = ?, notified_at = NULL, updated_at = ? WHERE id = ?',
    endIso, mode, nowIso(), evt.id
  );
  dbRun('UPDATE agent_activity SET expected_end_at = ?, updated_at = ? WHERE companion_id = ?', endIso, nowIso(), cId());
  return dbGet<OngoingEventRow>('SELECT * FROM ongoing_events WHERE id = ?', evt.id) || null;
}

/** 已到期但还没结束的事件（只读，不改状态；由调用方决定"发提醒"还是"静默结束"） */
export function getExpiredEvent(): OngoingEventRow | null {
  const evt = getActiveEvent();
  if (!evt || !evt.expected_end_at || evt.notified_at) return null;
  const endMs = new Date(evt.expected_end_at).getTime();
  if (!isFinite(endMs) || Date.now() < endMs) return null;
  return evt;
}

/** 到期多久之后就不再打扰（直接静默结束）：睡觉这类长事件给更宽的窗口 */
export function eventLateWindowMinutes(evt: OngoingEventRow): number {
  return evt.event_type === 'sleep' ? 180 : 90;
}

/** 结算一个到期事件：结束 + 记录"已提醒过"（提醒失败时不写，下次 tick 会重试） */
export function settleExpiredEvent(evt: OngoingEventRow, notified: boolean): void {
  endOngoingEvent('expired');
  if (notified) {
    dbRun('UPDATE ongoing_events SET notified_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), evt.id);
  }
}

/* ------------------------------------------------------------------ */
/* 从对话里识别"她开始做某件事"（规则兜底，不依赖后台分析模型）           */
/* ------------------------------------------------------------------ */
const EVENT_INTENT_RULES: Array<{ activity: string; re: RegExp }> = [
  { activity: '睡觉', re: /(我去睡|我先睡|那我睡|我睡了|我睡啦|我睡喽|我要睡|我准备睡|我准备睡了|我也睡|我这就睡|我该睡了|我得睡了|我躺下睡|我上床睡|我睡着|睡着了|沉沉睡去|安心入睡|渐渐入睡|进入梦乡|睡过去了|我去躺了|我先躺了|我躺下了|我上床了|我去床上|我回床上|我钻被窝)/ },
  { activity: '眯一会儿', re: /(我去午休|我去眯|我眯一会|我小睡|我躺一会|我去躺一会|我休息一下|我歇一会|我打个盹)/ },
  { activity: '洗澡', re: /(我去洗澡|我去洗个澡|我先洗|我去冲个澡|我去洗洗|我去洗漱|我要去洗澡|我去冲一下)/ },
  { activity: '吃饭', re: /(我去吃饭|我先去吃饭|我去吃个饭|我去吃点东西|我去吃午饭|我去吃晚饭|我去吃早饭|我吃饭去了|我去食堂吃|我去弄点吃的|我去干饭|我先吃口饭)/ },
  { activity: '出门', re: /(我出门|我出门了|我先出门|我出去了|我去超市|我去买东西|我去逛街|我出发了|我下楼|我去拿个快递|我去取快递|我去买东西|我出去一趟)/ },
  { activity: '上课', re: /(我去上课|我先去上课|我去教室|我得去上课|我要去上课|我上课去|我该去上课了)/ },
  { activity: '自习', re: /(我去自习|我去图书馆|我去写作业|我去复习|我要去自习|我去背单词|我背会单词|我去写论文|我去赶作业)/ },
  { activity: '工作', re: /(我去上班|我先去上班|我去开会|我去加班|我要去开会|我得去开会)/ },
  { activity: '运动', re: /(我去运动|我去跑步|我去健身|我去打球|我去游泳|我去锻炼|我去练|我去跑两圈|我下楼跑|我去做运动|我活动活动)/ },
  { activity: '打游戏', re: /(我去打游戏|我去玩会|我开黑|我去开黑|我打一局|我去排位|我去下棋|我打会游戏|我玩两把)/ },
  { activity: '和朋友聊天', re: /(我去找朋友|我和朋友聊|我去串门|我去聚会|我去和朋友|我跟朋友|我找室友|我去聊天)/ },
  { activity: '遛个弯', re: /(我去遛狗|我去遛弯|我去散步|我下楼走走|我去转转|我去走一走|我出去透透气)/ },
  { activity: '做家务', re: /(我去收拾|我去打扫|我去洗衣服|我去做饭|我收拾一下|我去洗碗|我去买菜|我去晾衣服|我收拾收拾|我去整理)/ },
  { activity: '护肤', re: /(我(先)?去(敷|护肤|泡脚|洗脸|化个妆|吹头发)|我敷个面膜|我先敷|我去收拾一下自己|我洗把脸)/ },
  { activity: '看剧', re: /(我去看剧|我去看电影|我去追剧|我看会剧|我去看个电影|我刷会剧)/ },
  { activity: '看书', re: /(我去看会书|我看会书|我去看书|我看本书|我去读会书)/ },
];

/**
 * 从这一轮对话里识别"她开始做某件事"，并登记成可控事件。
 * 只认她自己第一人称的动作（"你先睡"这类说的是他，不登记）。
 * 返回是否登记成功。
 */
export function detectEventFromConversation(userText: string, assistantText: string): boolean {
  const her = String(assistantText || '');
  const him = String(userText || '');
  if (!her) return false;
  for (const rule of EVENT_INTENT_RULES) {
    const m = rule.re.exec(her);
    if (!m || m.index === undefined) continue;
    // 匹配词前面 4 个字里出现"你"→ 明显在说他（你先睡/你也睡），跳过
    const before = her.slice(Math.max(0, m.index - 4), m.index);
    if (/你/.test(before)) continue;
    applyActivityChange(rule.activity, '');
    return true;
  }
  // 兜底：他让她去做某件事，她答应了（"你先去睡"这类说的是他不算）
  const compliant = /(嗯|好|行|知道|马上|这就|那我去|听你|乖)/.test(her);
  if (compliant) {
    const askedList: Array<{ ask: RegExp; act: string; echo: RegExp; notAbout: RegExp }> = [
      { ask: /(去睡|快睡|睡觉吧|睡吧|早点睡|该睡了|晚安)/, act: '睡觉', echo: /(睡|晚安|困|躺|床|被窝)/, notAbout: /你[^。！？]{0,4}(睡|晚安|躺|床)/ },
      { ask: /(去洗澡|洗个澡|冲个澡|去洗洗)/, act: '洗澡', echo: /洗/, notAbout: /你[^。！？]{0,4}洗/ },
      { ask: /(去吃饭|吃饭去|去吃点东西|去吃点)/, act: '吃饭', echo: /吃/, notAbout: /你[^。！？]{0,4}吃/ },
      { ask: /(去运动|去跑步|运动一下|出去走走|去散步|去遛)/, act: '运动', echo: /(跑|走|运动|遛|动起来)/, notAbout: /你[^。！？]{0,4}(跑|走|运动)/ },
    ];
    for (const a of askedList) {
      if (!a.ask.test(him) || !a.echo.test(her) || a.notAbout.test(her)) continue;
      applyActivityChange(a.act, '');
      return true;
    }
  }
  return false;
}

export function applyLocationChange(newLocation: string, reason: string): void {
  const loc = String(newLocation || '').trim();
  if (!loc || loc.length > 20) return;
  const cur = getLocation();
  if (cur.current_location === loc) return;
  const type = /家|宿舍/.test(loc) ? 'home' : /公司|学校|教室|图书馆|食堂/.test(loc) ? 'school' : /咖啡|店|街|商场|公园|电影院/.test(loc) ? 'out' : 'out';
  dbRun(
    'UPDATE agent_location SET current_location = ?, location_type = ?, arrived_at = ?, expected_leave_at = NULL, updated_at = ? WHERE companion_id = ?',
    loc, type, nowIso(), nowIso(), cId()
  );
  const act = getActivity();
  const newAct = /家|宿舍/.test(loc) ? '刚到家，缓一缓' : `在${loc}`;
  dbRun(
    'UPDATE agent_activity SET current_activity = ?, activity_type = ?, started_at = ?, expected_end_at = NULL, updated_at = ? WHERE companion_id = ?',
    newAct, /家|宿舍/.test(loc) ? 'home' : 'out', nowIso(), nowIso(), cId()
  );
  logLife('location', cur.current_location, loc, reason || '对话里提到');
  if (act.current_activity) logLife('activity', act.current_activity, newAct, reason || '位置变化');
  // 去某处待着也算一件事，可以控制它什么时候结束
  const evt = registerOngoingEvent(newAct, {});
  if (evt?.expected_end_at) {
    dbRun('UPDATE agent_activity SET expected_end_at = ?, updated_at = ? WHERE companion_id = ?', evt.expected_end_at, nowIso(), cId());
  }
}

export function applyActivityChange(newActivity: string, expectedEnd: string): void {
  const act = String(newActivity || '').trim();
  if (!act || act.length > 24) return;
  const cur = getActivity();
  const same = cur.current_activity === act;
  const evt = registerOngoingEvent(act, { expectedEndText: expectedEnd });
  let expectedIso: string | null = null;
  if (evt) expectedIso = evt.expected_end_at;
  else if (!/^刚/.test(act)) expectedIso = parseExpectedEnd(expectedEnd) || isoAfter(new Date(), smartDurationMinutes(eventTypeOf(act), act));
  if (same && cur.expected_end_at === expectedIso) return;
  dbRun(
    'UPDATE agent_activity SET current_activity = ?, activity_type = ?, started_at = ?, expected_end_at = ?, updated_at = ? WHERE companion_id = ?',
    act, activityTypeOfEvent(eventTypeOf(act)), same ? (cur.started_at || nowIso()) : nowIso(), expectedIso, nowIso(), cId()
  );
  if (!same) logLife('activity', cur.current_activity, act, '对话里提到');
}

export function addDailyEvent(type: string, content: string, impact: string): void {
  const c = String(content || '').trim();
  if (c.length < 2) return; // "感冒/失眠/加班/搬家"这类两字小事也值得记下来
  cRun(
    'INSERT INTO agent_daily_events (companion_id, user_id, event_type, content, impact_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    DEFAULT_USER_ID, String(type || '生活').slice(0, 12), c.slice(0, 200), JSON.stringify({ note: String(impact || '').slice(0, 120) }), nowIso()
  );
  logLife('daily_event', '', c.slice(0, 60), '对话中发生的小事');
}