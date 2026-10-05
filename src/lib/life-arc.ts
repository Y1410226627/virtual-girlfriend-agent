// 生活系统 · 跨天剧情线（Life Arc）与她的日记：后台静默任务
// 由 life.ts 拆分而来（原样搬移，行为不变）
import { dbAll, dbGet, dbRun, DEFAULT_USER_ID, getCounter, setCounter } from './db';
import { clamp, nowIso, localDateStr, errMsg } from './utils';
import { chatJson, type ChatMessage } from './llm';
import { getHealth, getPsychology, logLife, type LifeLogRow, type DailyEventRow } from './life-core';
import { getCast } from './life-shared';

/* ------------------------------------------------------------------ */
/* Life Arc：跨天剧情线（她这几天正在忙的一件事）                        */
/* ------------------------------------------------------------------ */
export interface LifeArcRow {
  id: number;
  user_id: number;
  title: string;
  description: string;
  status: string;
  progress: number;
  planned_days: number;
  meta_json: string | null;
  started_at: string;
  updated_at: string;
}

export function getActiveArc(): LifeArcRow | null {
  const row = dbGet<LifeArcRow>(
    "SELECT * FROM life_arcs WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
    DEFAULT_USER_ID
  );
  return row || null;
}

/**
 * 生活线"第 N 天"：按 started_at 起经过的时间推导（floor(已过毫秒/一天) + 1），
 * 与基于节流推进的 progress 解耦——即使后台没推进，读取侧也随时间自洽；上限为 planned_days。
 */
export function lifeArcDay(
  arc: Pick<LifeArcRow, 'started_at' | 'planned_days'>,
  nowMs: number = Date.now()
): number {
  const planned = Math.max(1, Number(arc.planned_days) || 1);
  const startMs = new Date(arc.started_at).getTime();
  if (!Number.isFinite(startMs)) return 1;
  const elapsed = Math.max(0, nowMs - startMs);
  const day = Math.floor(elapsed / 86400000) + 1;
  return Math.min(planned, Math.max(1, day));
}

function seasonOf(d: Date = new Date()): string {
  const m = d.getMonth() + 1;
  if (m >= 3 && m <= 5) return '春天';
  if (m >= 6 && m <= 8) return '夏天';
  if (m >= 9 && m <= 11) return '秋天';
  return '冬天';
}

/** 用模型生成一条新的生活线；解析失败/字段不合法则放弃（返回是否成功） */
async function generateLifeArc(): Promise<boolean> {
  try {
    const h = getHealth();
    const p = getPsychology();
    // 用当前的 cast（用户可能改过名字/关系），不写死默认角色
    const cast = getCast();
    const castLine = cast.length ? `，身边有${cast.map((c) => `${c.role || '朋友'}${c.name}`).join('、')}` : '';
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是「她」的生活编剧。她是一个大一女生${castLine}。
请为她设计一条接下来几天正在忙的生活线（一个跨天的小目标 / 小事件），要求生活化、真实、不狗血、不夸张，符合普通大学生日常。
可以结合她当前的状态（精力 ${Math.round(h.energy)}/100，情绪「${p.base_emotion}」，季节：${seasonOf()}）自然一点。
选题方向举例：期末周复习某一科、社团准备演出、学车、手工做一个礼物、家里打电话说起的事、运动减肥计划、给朋友准备生日、整理旧物、参加比赛、追一部剧……
不要写生死、绝症、重大意外这类沉重剧情。
只输出 JSON：
{"title":"不超过12个字","description":"不超过60个字，一句话说清她在忙什么","planned_days":3~7}`,
      },
      { role: 'user', content: '请为我设计这条生活线，只输出 JSON。' },
    ];
    const raw = await chatJson<{ title?: string; description?: string; planned_days?: number }>(messages, {
      maxTokens: 300,
      temperature: 0.9,
      thinking: false,
    });
    if (!raw || typeof raw !== 'object') return false;
    const title = String(raw.title || '').trim();
    const description = String(raw.description || '').trim();
    if (!title || title.length > 12) return false;
    const days = Math.round(clamp(Number(raw.planned_days) || 5, 3, 7));
    const now = nowIso();
    dbRun(
      'INSERT INTO life_arcs (user_id, title, description, status, progress, planned_days, meta_json, started_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
      DEFAULT_USER_ID, title, description.slice(0, 60), 'active', days, JSON.stringify({ source: 'llm' }), now, now
    );
    // 新建当天不推进，明天才算"第 2 天"
    setCounter('life_arc_progress_day', Math.floor(Date.now() / 86400000));
    logLife('life_arc', '', title, '开始了新的生活线');
    return true;
  } catch (e) {
    console.warn('[life] life_arc 生成失败:', errMsg(e));
    return false;
  }
}

/**
 * 推进生活线：6 小时检查一次；有 active 则每天最多推进一天，到期结束并记一条日常事件；
 * 无 active 且距上次生成 ≥3 天则用模型生成一条（无论成败都更新 last_gen）。
 * 全程静默，失败不影响主流程。
 */
export async function tickLifeArc(): Promise<void> {
  try {
    const now = Date.now();
    if (now - getCounter('life_arc_check_at') < 6 * 3600000) return;
    setCounter('life_arc_check_at', now);

    const arc = getActiveArc();
    if (arc) {
      const todayNum = Math.floor(now / 86400000);
      if (getCounter('life_arc_progress_day') !== todayNum) {
        setCounter('life_arc_progress_day', todayNum);
        const next = arc.progress + 1;
        if (next >= arc.planned_days) {
          dbRun("UPDATE life_arcs SET status = 'finished', progress = ?, updated_at = ? WHERE id = ?", next, nowIso(), arc.id);
          // 用现有日常事件写入方式记一条（她能自然聊起"那件事告一段落"）
          dbRun(
            'INSERT INTO agent_daily_events (user_id, event_type, content, impact_json, created_at) VALUES (?, ?, ?, ?, ?)',
            DEFAULT_USER_ID, '生活', `她最近在忙的事告一段落：${arc.title}`, JSON.stringify({ note: 'life_arc_finished' }), nowIso()
          );
          logLife('life_arc', arc.title, '已完成', '生活线告一段落');
        } else {
          dbRun('UPDATE life_arcs SET progress = ?, updated_at = ? WHERE id = ?', next, nowIso(), arc.id);
        }
      }
      return;
    }

    // 没有进行中的生活线：距上次生成 ≥3 天才考虑再生成（避免频繁打扰模型）
    if (now - getCounter('life_arc_last_gen') >= 3 * 86400000) {
      await generateLifeArc(); // 成败都更新 last_gen
      setCounter('life_arc_last_gen', now);
    }
  } catch (e) {
    console.warn('[life] tickLifeArc 失败:', errMsg(e));
  }
}

/* ------------------------------------------------------------------ */
/* 她的日记：为本机最近 7 天内"有生活痕迹但还没日记"的日子补写           */
/* ------------------------------------------------------------------ */
// 日记硬约束：出现这些词说明"她"把 AI/系统设定写进了日记，视为失败重试。
// 匹配要点（避免误杀正常日记）：
// - 英文/ASCII 词（AI）用词边界匹配：像 "aim" / "rain" / "wait" 里夹着的 "ai" 不会被误判。
// - 中文词用"独立词"匹配（左右都不是中文表意字符）：把禁用词嵌在更长词里的正常表达
//   （"系统解剖学" / "消化系统" / "虚拟现实"）不会被误判。
// 说明：本函数是"提示词已要求不出现这些词"之外的兜底网；误杀会让当天日记被静默卡住、
// 反复重试写不出，因此优先避免误杀，对中文采取独立词匹配。
const DIARY_FORBIDDEN_ASCII = /\bAI\b/i;
const CJK_CHAR = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
const DIARY_FORBIDDEN_CN = new RegExp(
  `(?<![${CJK_CHAR}])(人工智能|系统|用户|对话|程序|模型|虚拟)(?![${CJK_CHAR}])`
);

/** 日记正文是否命中"禁止出现"的破壁词（独立词匹配，避免误杀正常中文日记） */
export function hasForbiddenDiaryTerm(text: string): boolean {
  return DIARY_FORBIDDEN_ASCII.test(text) || DIARY_FORBIDDEN_CN.test(text);
}

/** 写某一天的日记；成功返回 true */
async function generateDiary(date: string): Promise<boolean> {
  try {
    const events = dbAll<DailyEventRow>(
      "SELECT event_type, content FROM agent_daily_events WHERE user_id = ? AND date(created_at, 'localtime') = ? ORDER BY id ASC",
      DEFAULT_USER_ID, date
    );
    const sum = dbGet<{ summary: string }>('SELECT summary FROM daily_summaries WHERE user_id = ? AND date = ?', DEFAULT_USER_ID, date);
    const logs = dbAll<LifeLogRow>(
      "SELECT field, new_value, reason FROM life_state_logs WHERE user_id = ? AND date(created_at, 'localtime') = ? AND field IN ('activity', 'illness', 'care') ORDER BY id ASC",
      DEFAULT_USER_ID, date
    );
    if (!events.length && !sum && !logs.length) return true; // 没有素材，跳过不算失败

    const eventText = events.map((e) => `- ${e.content}`).join('\n');
    const logText = logs.map((l) => `- ${l.new_value}${l.reason ? `（${l.reason}）` : ''}`).join('\n');
    const material = [
      `日期：${date}`,
      eventText ? `【那天发生的小事】\n${eventText}` : '',
      logText ? `【那天的活动】\n${logText}` : '',
      sum?.summary ? `【那天的概况】\n${sum.summary}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const castNames = getCast().map((c) => c.name).join('、');
    const castHint = castNames ? `和身边人（${castNames}等）发生的小事` : '和身边人发生的小事';
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是「她」本人，现在在写这一天（${date}）的私人日记。用第一人称、口语、像真的随手记下来。
要求：
- 100~200 字，有生活细节：吃了什么、天气怎么样、当时的小情绪、${castHint}。
- 自然、有细微的情绪起伏，不要流水账、不要总结中心思想、不要故作深沉。
- 绝对不能出现"AI""人工智能""系统""用户""对话""程序""模型""虚拟"这类词。
- 关于他可以提到也可以不提——随缘，自然最重要，不要硬塞。
- 不要标题、不要日期标注、不要 markdown。
只输出 JSON：{"content": "日记正文"}`,
      },
      { role: 'user', content: `${material}\n\n请写这一天的日记，只输出 JSON。` },
    ];

    const raw = await chatJson<{ content?: string }>(messages, {
      maxTokens: 500,
      temperature: 0.95,
      thinking: false,
    });
    const content = String(raw?.content || '').trim();
    if (content.length < 20) return false;
    if (hasForbiddenDiaryTerm(content)) return false; // 违反硬约束 → 当作失败重试

    const now = nowIso();
    dbRun(
      `INSERT INTO agent_diaries (user_id, date, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      DEFAULT_USER_ID, date, content.slice(0, 800), now, now
    );
    return true;
  } catch (e) {
    console.warn('[life] 日记生成失败:', errMsg(e));
    return false;
  }
}

/**
 * 补齐日记：30 分钟检查一次，每次最多 2 天；失败则 30 分钟后再试（同每日摘要的重试思路）。
 * 全程静默。
 */
export async function ensureDailyDiaries(): Promise<void> {
  try {
    const now = Date.now();
    if (getCounter('diary_retry_after') > now) return;
    if (now - getCounter('diary_check_at') < 30 * 60 * 1000) return;
    setCounter('diary_check_at', now);

    const today = localDateStr();
    const start = localDateStr(new Date(now - 6 * 86400000));
    // 最近 7 天内：有日常事件或每日摘要、但还没有日记的日子，按正序补齐
    const missing = dbAll<{ d: string }>(
      `SELECT d FROM (
         SELECT date(created_at, 'localtime') AS d FROM agent_daily_events
         WHERE user_id = ? AND date(created_at, 'localtime') >= ? AND date(created_at, 'localtime') <= ?
         UNION
         SELECT date AS d FROM daily_summaries
         WHERE user_id = ? AND date >= ? AND date <= ?
       )
       WHERE d NOT IN (SELECT date FROM agent_diaries WHERE user_id = ?)
       ORDER BY d ASC LIMIT 2`,
      DEFAULT_USER_ID, start, today,
      DEFAULT_USER_ID, start, today,
      DEFAULT_USER_ID
    );
    if (!missing.length) return;

    for (const row of missing) {
      const ok = await generateDiary(row.d);
      if (!ok) {
        setCounter('diary_retry_after', Date.now() + 30 * 60 * 1000);
        return;
      }
    }
  } catch (e) {
    console.warn('[life] ensureDailyDiaries 失败:', errMsg(e));
  }
}