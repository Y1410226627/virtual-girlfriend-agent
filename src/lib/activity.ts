// 活动引擎（T05 · 线上/线下）。
//
// 设计要点（对齐架构 §3.7 / §3.5 / §3.8）：
// - 线上活动（kind='online'）：**复用群聊引擎**（group.ts 的调度/发言/reaction/收尾）+ 活动模板库
//   （movie/game/nighttalk/co_listen）；场景保持 online；产物 = 群聊记录 + summary。
// - 线下活动（kind='offline'）：复用 scene.ts 的 offline 概念；buildDateSchedule() 生成日程
//   （见面→…→收尾）写入 activity_schedule_items；**轮流聚焦**一名参与者（activities.focus_companion_id，
//   用户可 focus() 切换）——线下互动以引擎「onlySpeakers=[焦点]」硬约束**只有焦点能产出**
//   （非焦点任何轮次都不产出，含 reaction），并在焦点产出后 abort 本轮，真正做到「一次只说一个人」
//   （见 runActivityTurn）；
//   不做真实日历集成；end() 回落 online，并把日程/记录/summary/对好感与伴侣关系的 delta 落库。
// - 场景落点（避免互相污染）：活动进行中把参与者的 relationship_state.scene 强制置 offline
//   （scene_source='activity'），并把原场景记进 activities.meta_json，结束后逐一如实恢复；
//   活动自身场景记在 activities.scene。
// - 数值写入纪律：伴侣关系一律经 companion-relations.applyDelta（其内部经 applyRelationshipDelta()
//   唯一写点落到好感）；**绝不直接改 emotional_balance**；跨伴侣批量写在同一个 tx() 内（applyDelta 可重入）；
//   **不获取伴侣会话锁**（叶子锁原则）。
// - activities / activity_participants / activity_schedule_items 均为【全局表】：用 dbAll/dbGet/dbRun。
import { dbAll, dbGet, dbRun, tx, DEFAULT_USER_ID } from './db';
import { nowIso, safeJson } from './utils';
import { applyDelta } from './companion-relations';
import { getCurrentRun } from './group-run';
import {
  createGroup,
  isGirlfriend,
  listMessages,
  listMemberIds,
  runGroupTurn,
  GROUP_MAX_MEMBERS,
  GROUP_MIN_MEMBERS,
  type GroupTurnOptions,
  type GroupTurnResult,
} from './group';
import type { ActivityRow, ActivityScheduleItemRow, GroupMessageRow } from './types';

/* ------------------------------------------------------------------ */
/* 常量 / 模板                                                         */
/* ------------------------------------------------------------------ */
/** 线上活动模板库（key 存 activities.template_key） */
export const ACTIVITY_TEMPLATES = {
  movie: { label: '一起看电影', topic: '挑一部电影，边看边聊' },
  game: { label: '一起打游戏', topic: '开黑一局，输赢都要嘴硬' },
  nighttalk: { label: '深夜卧谈', topic: '关灯后聊点走心的事' },
  co_listen: { label: '一起听歌', topic: '一人一首，边听边吐槽' },
} as const;
export type ActivityTemplateKey = keyof typeof ACTIVITY_TEMPLATES;

/** 线下「约会日程」模板（见面→…→收尾） */
export const DATE_SCHEDULE_TEMPLATE = ['见面 · 打个招呼', '并肩散步', '找家小店坐下', '一起拍张照', '道别 · 各回各家'];

/** 活动状态标签（UI 用） */
export const ACTIVITY_STATUS_LABEL: Record<string, string> = {
  planned: '待开始',
  ongoing: '进行中',
  ended: '已结束',
  cancelled: '已取消',
};

/** 同场完成时，参与者两两之间的关系增量（+2~+5 区间内取 +3） */
export const ACTIVITY_PAIR_DELTA = 3;
/** 线下被冷落（非焦点）对焦点者的关系增量（-1~-3 区间内取 -2） */
export const ACTIVITY_NEGLECT_DELTA = -2;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */
function asId(v: unknown): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function uniqueIds(ids: unknown[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of ids) {
    const id = asId(raw);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function companionName(id: number): string {
  const row = dbGet<{ name: string }>('SELECT name FROM companions WHERE id = ?', asId(id));
  const name = row?.name ? String(row.name).trim() : '';
  return name || `角色${asId(id)}`;
}

/** 读某伴侣当前场景（缺行返回 'online'） */
function currentSceneOf(cid: number): string {
  const row = dbGet<{ scene: string | null }>('SELECT scene FROM relationship_state WHERE companion_id = ?', asId(cid));
  return row?.scene === 'offline' ? 'offline' : 'online';
}

/**
 * 写某伴侣的场景（relationship_state 是 per-companion 表 → 用 dbRun + 显式 companion_id；
 * 注意 UPDATE 的 companion_id 在 WHERE，不能用 cRun 首参注入）。
 */
function setCompanionScene(cid: number, scene: string, source: string | null, reason: string | null): void {
  const now = nowIso();
  dbRun(
    `UPDATE relationship_state
        SET scene = ?, scene_source = ?, scene_reason = ?, scene_updated_at = ?, updated_at = ?
      WHERE companion_id = ?`,
    scene === 'offline' ? 'offline' : 'online',
    source,
    reason,
    now,
    now,
    asId(cid)
  );
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */
export function getActivity(activityId: number): ActivityRow | null {
  const id = asId(activityId);
  if (!id) return null;
  return dbGet<ActivityRow>('SELECT * FROM activities WHERE id = ?', id) ?? null;
}

export interface ActivityParticipantLite {
  id: number;
  name: string;
  identity: string | null;
  age: number;
}

export function listParticipantIds(activityId: number): number[] {
  const id = asId(activityId);
  if (!id) return [];
  return dbAll<{ companion_id: number }>(
    'SELECT companion_id FROM activity_participants WHERE activity_id = ? ORDER BY id ASC',
    id
  )
    .map((r) => asId(r.companion_id))
    .filter((n) => n > 0);
}

export function listParticipants(activityId: number): ActivityParticipantLite[] {
  return listParticipantIds(activityId).map((cid) => {
    const row = dbGet<{ name: string; identity: string | null; age: number }>(
      'SELECT name, identity, age FROM companions WHERE id = ?',
      cid
    );
    return { id: cid, name: row?.name ? String(row.name) : `角色${cid}`, identity: row?.identity ?? null, age: Number(row?.age ?? 0) };
  });
}

export function listScheduleItems(activityId: number): ActivityScheduleItemRow[] {
  const id = asId(activityId);
  if (!id) return [];
  return dbAll<ActivityScheduleItemRow>(
    'SELECT * FROM activity_schedule_items WHERE activity_id = ? ORDER BY seq ASC, id ASC',
    id
  );
}

export interface ActivitySummaryRow {
  activity: ActivityRow;
  participantIds: number[];
  participantNames: string[];
  scheduleCount: number;
}

export function listActivities(): ActivitySummaryRow[] {
  const rows = dbAll<ActivityRow>(
    'SELECT * FROM activities ORDER BY COALESCE(scheduled_at, created_at) DESC, id DESC'
  );
  return rows.map((a) => {
    const participantIds = listParticipantIds(Number(a.id));
    return {
      activity: a,
      participantIds,
      participantNames: participantIds.map((id) => companionName(id)),
      scheduleCount: listScheduleItems(Number(a.id)).length,
    };
  });
}

export interface ActivityDetail {
  activity: ActivityRow;
  participantIds: number[];
  participants: ActivityParticipantLite[];
  schedule: ActivityScheduleItemRow[];
  groupId: number | null;
  messages: GroupMessageRow[];
}

export function getActivityDetail(activityId: number): ActivityDetail | null {
  const activity = getActivity(activityId);
  if (!activity) return null;
  const aid = Number(activity.id);
  const groupId = activity.group_id == null ? null : Number(activity.group_id);
  return {
    activity,
    participantIds: listParticipantIds(aid),
    participants: listParticipants(aid),
    schedule: listScheduleItems(aid),
    groupId,
    messages: groupId ? listMessages(groupId, 120) : [],
  };
}

/* ------------------------------------------------------------------ */
/* 建活动                                                              */
/* ------------------------------------------------------------------ */
export interface CreateActivityInput {
  kind: 'online' | 'offline';
  templateKey?: string;
  title?: string;
  memberIds: number[];
  groupId?: number | null;
  scheduledAt?: string | null;
  location?: string | null;
}

export interface ActivityOpResult {
  ok: boolean;
  code?: string;
  error?: string;
  activity?: ActivityRow;
}

function validateParticipants(ids: number[]): { ok: true } | { ok: false; code: string; error: string } {
  const notFound = ids.filter((id) => !dbGet<{ id: number }>('SELECT id FROM companions WHERE id = ?', id));
  if (notFound.length) return { ok: false, code: 'COMPANION_NOT_FOUND', error: '有角色不存在' };
  const notGf = ids.filter((id) => !isGirlfriend(id));
  if (notGf.length) return { ok: false, code: 'PERMISSION_ONLY_GIRLFRIEND', error: '只有已晋升为女友的角色才能参加活动' };
  return { ok: true };
}

/**
 * 发起一次活动。
 * - 线上：kind='online'，template_key 取模板库；场景保持 online；复用群聊引擎互动。
 * - 线下：kind='offline'，强制参与者进入 offline 场景（并记忆原场景），生成约会日程，聚焦首位参与者。
 * 参与者 2–6 名已晋升女友（与群聊一致）；活动会挂到一个群（沿用传入 groupId，或按标题新建）。
 */
export function createActivity(input: CreateActivityInput): ActivityOpResult {
  const kind = input?.kind === 'offline' ? 'offline' : input?.kind === 'online' ? 'online' : null;
  if (!kind) return { ok: false, code: 'INVALID_INPUT', error: '活动类型不合法' };

  const ids = uniqueIds(input.memberIds ?? []);
  if (ids.length < GROUP_MIN_MEMBERS) {
    return { ok: false, code: 'INVALID_INPUT', error: `活动至少需要 ${GROUP_MIN_MEMBERS} 名已晋升女友` };
  }
  if (ids.length > GROUP_MAX_MEMBERS) {
    return { ok: false, code: 'GROUP_MEMBER_LIMIT', error: `活动参与者最多 ${GROUP_MAX_MEMBERS} 名` };
  }
  const v = validateParticipants(ids);
  if (!v.ok) return { ok: false, code: v.code, error: v.error };

  // 模板 / 标题 / 话题
  const templateKey = kind === 'online' ? String(input.templateKey ?? 'nighttalk') : input.templateKey ? String(input.templateKey) : null;
  const template =
    templateKey && templateKey in ACTIVITY_TEMPLATES
      ? ACTIVITY_TEMPLATES[templateKey as ActivityTemplateKey]
      : null;
  const title = String(input.title ?? (template?.label || (kind === 'offline' ? '线下约会' : '一起玩'))).trim().slice(0, 40);
  if (!title) return { ok: false, code: 'INVALID_INPUT', error: '活动标题不能为空' };
  const topic = template?.topic ?? (kind === 'offline' ? `${title}：轮流和每个人说说话` : '随便聊聊');

  // 关联的群（沿用传入的，或新建；确保参与者都在群里）
  let groupId = asId(input.groupId ?? 0);
  if (groupId) {
    const g = dbGet<{ id: number }>('SELECT id FROM groups WHERE id = ?', groupId);
    if (!g) return { ok: false, code: 'GROUP_NOT_FOUND', error: '指定的群不存在' };
    const existing = listMemberIds(groupId);
    const toAdd = ids.filter((id) => !existing.includes(id));
    if (existing.length + toAdd.length > GROUP_MAX_MEMBERS) {
      return { ok: false, code: 'GROUP_MEMBER_LIMIT', error: `群成员最多 ${GROUP_MAX_MEMBERS} 名` };
    }
    const now0 = nowIso();
    for (const id of toAdd) {
      dbRun('INSERT OR IGNORE INTO group_members (group_id, companion_id, joined_at) VALUES (?, ?, ?)', groupId, id, now0);
    }
  } else {
    const g = createGroup(title, topic, ids);
    if (!g.ok || !g.group) return { ok: false, code: g.code, error: g.error };
    groupId = Number(g.group.id);
  }

  // 记忆各参与者的原场景，供结束后如实恢复
  const prevScenes: Record<string, string> = {};
  for (const id of ids) prevScenes[String(id)] = currentSceneOf(id);

  const now = nowIso();
  const scene = kind === 'offline' ? 'offline' : 'online';
  const aid = Number(
    dbRun(
      `INSERT INTO activities
         (user_id, group_id, kind, template_key, title, scene, scheduled_at, location, status, focus_companion_id, summary, meta_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ongoing', ?, NULL, ?, ?, ?)`,
      DEFAULT_USER_ID,
      groupId,
      kind,
      templateKey,
      title,
      scene,
      input.scheduledAt ? String(input.scheduledAt).slice(0, 40) : null,
      input.location ? String(input.location).slice(0, 80) : null,
      kind === 'offline' ? ids[0] : null,
      JSON.stringify({ prevScenes, participants: ids }),
      now,
      now
    ).lastInsertRowid
  );

  for (const id of ids) {
    dbRun('INSERT OR IGNORE INTO activity_participants (activity_id, companion_id, joined_at) VALUES (?, ?, ?)', aid, id, now);
  }

  // 线下：强制 offline 场景 + 生成日程
  if (kind === 'offline') {
    tx(() => {
      for (const id of ids) setCompanionScene(id, 'offline', 'activity', `参加线下活动：${title}`);
      buildDateSchedule(aid);
    });
  }

  const activity = getActivity(aid);
  return activity ? { ok: true, activity } : { ok: false, code: 'DB_ERROR', error: '活动写入失败' };
}

/* ------------------------------------------------------------------ */
/* 日程（线下）                                                        */
/* ------------------------------------------------------------------ */
/** 生成/读取线下约会日程（幂等：已有条目则原样返回，不重复插） */
export function buildDateSchedule(activityId: number): ActivityScheduleItemRow[] {
  const aid = asId(activityId);
  if (!aid) return [];
  const existing = listScheduleItems(aid);
  if (existing.length) return existing;
  const now = nowIso();
  let seq = 1;
  for (const title of DATE_SCHEDULE_TEMPLATE) {
    dbRun(
      "INSERT INTO activity_schedule_items (activity_id, seq, title, status, note, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
      aid,
      seq,
      title,
      seq === 1 ? 'current' : 'pending',
      now
    );
    seq++;
  }
  return listScheduleItems(aid);
}

/** 推进日程：把当前项标记 done，下一项标记 current（已是最后一项则不变） */
export function advanceSchedule(activityId: number): ActivityScheduleItemRow[] {
  const aid = asId(activityId);
  if (!aid) return [];
  const items = listScheduleItems(aid);
  const cur = items.find((it) => it.status === 'current');
  if (cur) {
    dbRun("UPDATE activity_schedule_items SET status = 'done' WHERE id = ?", Number(cur.id));
    const next = items.find((it) => Number(it.seq) > Number(cur.seq) && it.status !== 'done');
    if (next) dbRun("UPDATE activity_schedule_items SET status = 'current' WHERE id = ?", Number(next.id));
  } else {
    const pending = items.find((it) => it.status === 'pending');
    if (pending) dbRun("UPDATE activity_schedule_items SET status = 'current' WHERE id = ?", Number(pending.id));
  }
  return listScheduleItems(aid);
}

/* ------------------------------------------------------------------ */
/* 聚焦（线下轮流聚焦）                                                */
/* ------------------------------------------------------------------ */
export function focus(activityId: number, companionId: number): ActivityOpResult {
  const activity = getActivity(activityId);
  if (!activity) return { ok: false, code: 'ACTIVITY_NOT_FOUND', error: '活动不存在' };
  const cid = asId(companionId);
  if (!listParticipantIds(Number(activity.id)).includes(cid)) {
    return { ok: false, code: 'INVALID_INPUT', error: '只能聚焦本活动的参与者' };
  }
  dbRun('UPDATE activities SET focus_companion_id = ?, updated_at = ? WHERE id = ?', cid, nowIso(), Number(activity.id));
  return { ok: true, activity: getActivity(Number(activity.id)) ?? undefined };
}

/* ------------------------------------------------------------------ */
/* 互动（复用群聊引擎）                                                */
/* ------------------------------------------------------------------ */
export interface RunActivityTurnOptions extends Omit<GroupTurnOptions, 'mentions' | 'onlySpeakers'> {
  /** 覆盖 mentions（仅线上生效：默认不强制；线下由 onlySpeakers 接管） */
  mentions?: number[];
}

/**
 * 活动内的一次互动（复用群聊引擎）。
 * - 线上：等同群聊一轮（多角色按调度发言）。
 * - 线下：**只让当前焦点一人产出**——把 onlySpeakers=[焦点] 交给群聊引擎：非空时引擎本轮发言者
 *   只从该名单取（绕过 @提及/轮转/反三连击），**非焦点在任何轮次都不会被选中**（含 reaction）；
 *   焦点产出任意类型消息后立即 abort 本轮 signal，实现「一次只说一个人」。
 *   signal 中止只影响本轮调度，**不会**把 run 标为 cancelled（run 仍为 running）。
 * 需在 withGroupLock(groupId, …) 内调用。
 */
export async function runActivityTurn(
  activityId: number,
  text: string,
  opts: RunActivityTurnOptions = {}
): Promise<GroupTurnResult> {
  const activity = getActivity(activityId);
  if (!activity) {
    return { ok: false, code: 'ACTIVITY_NOT_FOUND', error: '活动不存在', messages: [], run: null, ended: false };
  }
  if (activity.status !== 'ongoing') {
    return { ok: false, code: 'ACTIVITY_ENDED', error: '活动已结束', messages: [], run: null, ended: true };
  }
  const groupId = activity.group_id == null ? 0 : Number(activity.group_id);
  if (!groupId) {
    return { ok: false, code: 'GROUP_NOT_FOUND', error: '活动没有关联的群', messages: [], run: null, ended: false };
  }

  // 线下语义：每一轮只允许「焦点」产出。先解析并校验焦点（空 / 非正整数 / 不在参与者内一律视为无效）。
  const isOffline = activity.kind === 'offline';
  const rawFocus = activity.focus_companion_id == null ? 0 : Math.trunc(Number(activity.focus_companion_id));
  const focusId =
    isOffline && rawFocus > 0 && listParticipantIds(Number(activity.id)).includes(rawFocus) ? rawFocus : 0;

  if (isOffline) {
    if (!focusId) {
      // 防御性（当前 API 不可达，但杜绝退化）：线下没有有效焦点 → 视为「本轮无人可产出」。
      // **绝不**落入下面的普通群聊分支——那会让多角色同时抢话，违反架构 §3.7
      // 「线下轮流聚焦、一次只说一个人」。线下宁可本轮沉默，也不放行多人。
      // 不改 run 状态、不写任何消息，安全收敛。
      return {
        ok: false,
        code: 'NO_FOCUS',
        error: '当前没有有效的聚焦对象，本轮无人发言',
        messages: [],
        run: getCurrentRun(groupId),
        ended: false,
      };
    }
    // 线下：引擎层硬约束「只有焦点能产出」+ 焦点产出任意类型后中止本轮
    const controller = new AbortController();
    const outer = opts.signal;
    if (outer) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const userOnMessage = opts.onMessage;
    let stopped = false;
    return runGroupTurn(groupId, text, {
      ...opts,
      onlySpeakers: [focusId],
      signal: controller.signal,
      onMessage: (m) => {
        userOnMessage?.(m);
        // 任意类型（正式发言 / reaction）都算「焦点已产出」→ 本轮到此为止
        if (!stopped && Number(m.companion_id) === focusId) {
          stopped = true;
          controller.abort();
        }
      },
    });
  }

  const mentions = opts.mentions && opts.mentions.length ? opts.mentions : undefined;
  return runGroupTurn(groupId, text, { ...opts, mentions });
}

/* ------------------------------------------------------------------ */
/* 结束 / 取消                                                         */
/* ------------------------------------------------------------------ */
/** 由群聊记录生成确定性 summary（不依赖 LLM，离线可用） */
export function buildActivitySummary(activity: ActivityRow, messages: GroupMessageRow[]): string {
  const names = listParticipantIds(Number(activity.id)).map((id) => companionName(id));
  const spoken = messages.filter((m) => m.speaker_type === 'companion').length;
  const reactions = messages.filter((m) => m.speaker_type === 'reaction').length;
  const topics = messages.filter((m) => m.speaker_type === 'user').length;
  const who = names.join('、');
  const kindText = activity.kind === 'offline' ? '线下一起' : '线上一起';
  const flavor =
    activity.kind === 'offline'
      ? '从见面到道别，气氛不错。'
      : `${activity.template_key ? (ACTIVITY_TEMPLATES[activity.template_key as ActivityTemplateKey]?.label ?? activity.title) : activity.title}，聊得挺热闹。`;
  return `${who} ${kindText}「${activity.title}」：你和大家说了 ${topics} 句，她们发言 ${spoken} 次、回应 ${reactions} 次。${flavor}`;
}

function restoreScenes(activity: ActivityRow): void {
  const meta = safeJson<{ prevScenes?: Record<string, string> }>(activity.meta_json, {});
  const prev = meta.prevScenes ?? {};
  for (const cid of listParticipantIds(Number(activity.id))) {
    const want = prev[String(cid)] === 'offline' ? 'offline' : 'online';
    setCompanionScene(cid, want, null, null);
  }
}

/** 活动产生的伴侣关系增量（同场完成 + 线下被冷落），全部在 applyDelta 内部的可重入 tx 中完成 */
function applyActivityRelations(activity: ActivityRow): void {
  const ids = listParticipantIds(Number(activity.id));
  // 同场完成：参与者两两 +3
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!;
      const b = ids[j]!;
      try {
        applyDelta(a, b, ACTIVITY_PAIR_DELTA, `共同参加活动：${activity.title}`);
      } catch {
        /* 单对失败不影响其它 */
      }
    }
  }
  // 线下被冷落：非焦点者对焦点者 -2
  if (activity.kind === 'offline' && activity.focus_companion_id) {
    const f = Number(activity.focus_companion_id);
    for (const o of ids) {
      if (o === f) continue;
      try {
        applyDelta(o, f, ACTIVITY_NEGLECT_DELTA, `活动里被偏心对待：${activity.title}`);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 结束活动：落 summary、恢复各参与者原场景、写入关系 delta。
 * 备注：好感闭环只经 applyDelta → applyRelationshipDelta 唯一写点，**不直接改 emotional_balance**。
 */
export function endActivity(activityId: number): ActivityOpResult & { summary?: string } {
  const activity = getActivity(activityId);
  if (!activity) return { ok: false, code: 'ACTIVITY_NOT_FOUND', error: '活动不存在' };
  const aid = Number(activity.id);
  if (activity.status === 'ended') return { ok: true, activity, summary: activity.summary ?? '' };

  const groupId = activity.group_id == null ? 0 : Number(activity.group_id);
  const messages = groupId ? listMessages(groupId, 400) : [];
  const summary = buildActivitySummary(activity, messages);

  const now = nowIso();
  dbRun("UPDATE activities SET status = 'ended', summary = ?, updated_at = ? WHERE id = ?", summary, now, aid);
  restoreScenes(activity);
  applyActivityRelations(activity);

  const updated = getActivity(aid);
  return updated ? { ok: true, activity: updated, summary } : { ok: false, code: 'DB_ERROR', error: '活动更新失败' };
}

/** 取消活动：恢复场景、不写 summary / delta */
export function cancelActivity(activityId: number): ActivityOpResult {
  const activity = getActivity(activityId);
  if (!activity) return { ok: false, code: 'ACTIVITY_NOT_FOUND', error: '活动不存在' };
  const aid = Number(activity.id);
  dbRun("UPDATE activities SET status = 'cancelled', updated_at = ? WHERE id = ?", nowIso(), aid);
  restoreScenes(activity);
  const updated = getActivity(aid);
  return updated ? { ok: true, activity: updated } : { ok: false, code: 'DB_ERROR', error: '活动更新失败' };
}

/* ------------------------------------------------------------------ */
/* 错误码 → HTTP 状态                                                  */
/* ------------------------------------------------------------------ */
export function activityHttpStatus(code: string | undefined): number {
  switch (code) {
    case 'ACTIVITY_NOT_FOUND':
    case 'GROUP_NOT_FOUND':
    case 'COMPANION_NOT_FOUND':
      return 404;
    case 'PERMISSION_ONLY_GIRLFRIEND':
      return 403;
    case 'ACTIVITY_ENDED':
    case 'GROUP_MEMBER_LIMIT':
      return 409;
    default:
      return 400;
  }
}
