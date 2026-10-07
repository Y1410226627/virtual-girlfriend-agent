// 伴侣域服务（T03）：通讯录 roster、创建/认识、资料页聚合、暂不(optOut)、攻略(optIn)、
// 晋升(promote)、面板初始化(initPanels)、删除。
//
// initPanels 是本任务最关键的正确性点（T02 实测缺口）：db.ts 的 seed() 只为主女友 companion 1
// 播了状态行；非主女友必须由 initPanels 幂等补种，否则聊天管线（getRelationshipState /
// getAttachmentState 行缺失即抛错）无法为其它伴侣工作。
import { dbAll, dbGet, dbRun, cGet, cRun, tx, DEFAULT_USER_ID } from './db';
import { PRIMARY_COMPANION_ID, withCompanion } from './companion-context';
import { nowIso, round1 } from './utils';
import { DIMENSIONS, type CompanionRow, type RelationshipState } from './types';
import { getPersona, getRelationshipState } from './relationship';
import { ensureLife } from './life';
import { stageOf } from './stages';
import {
  logCompanionEvent,
  markGirlfriend,
  resolveConfession,
  progressOf,
  canConfess,
  inCooldown,
  statusLabel,
  type PursuitProgress,
} from './pursuit';
import { dedupeHash, AGE_MIN } from './candidate-gen';
import { listRelationsFor, applyDelta, type RelationEdge } from './companion-relations';

export { AGE_MIN };

/** 带 companion_id 的全部表（删除伴侣时按 companion_id 清空） */
const COMPANION_SCOPED_TABLES = [
  'personas',
  'messages',
  'memories',
  'relationship_logs',
  'emotional_bank',
  'events',
  'personality_signals',
  'personality_logs',
  'attachment_signals',
  'attachment_logs',
  'conflict_logs',
  'proactive_messages',
  'turn_effects',
  'agent_daily_events',
  'life_state_logs',
  'intimacy_preferences',
  'intimacy_aftercare',
  'ongoing_events',
  'life_arcs',
  'conversation_turns',
  'message_generations',
  'analysis_jobs',
  'turn_operations',
  'agent_diaries',
  'relationship_state',
  'personality_state',
  'attachment_state',
  'personality_snapshots',
  'daily_summaries',
  'agent_profile',
  'agent_health',
  'agent_psychology',
  'agent_location',
  'agent_activity',
  'shared_world',
  'intimacy_state',
  'intimacy_content_level',
  'world_weekly_snapshots',
] as const;

function normalizeId(id: number): number {
  const n = Math.trunc(Number(id));
  return Number.isFinite(n) && n > 0 ? n : PRIMARY_COMPANION_ID;
}

/* ------------------------------------------------------------------ */
/* 请求解析                                                            */
/* ------------------------------------------------------------------ */
/** 解析请求中的 companionId：查询参数 `?companionId=` 或请求头 `X-Companion-Id`，缺省 1。 */
export function resolveCompanionId(req: Request): number {
  try {
    const url = new URL(req.url);
    const raw = url.searchParams.get('companionId') ?? req.headers.get('X-Companion-Id') ?? '';
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  } catch {
    /* 兜底到主女友 */
  }
  return PRIMARY_COMPANION_ID;
}

/**
 * T02 收尾 D2：把一个 API 路由的整段处理逻辑放到"请求所指伴侣"的上下文里执行。
 * 所有按 companion_id 隔离的读写路由统一用它包裹，使路由内部对 cId()/cAll/cGet/cRun
 * 的调用自动落到正确伴侣，而无需逐个改 SQL。
 * 用法：`return withRequestCompanion(req, () => Response.json(listRoster()));`
 */
export function withRequestCompanion<T>(req: Request, fn: () => T): T {
  return withCompanion(resolveCompanionId(req), fn);
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */
export function getCompanion(id: number): CompanionRow | null {
  return dbGet<CompanionRow>('SELECT * FROM companions WHERE id = ?', normalizeId(id)) ?? null;
}

/**
 * 需要后台推进（生活 / 亲密 / 日记 / 剧情线 / 主动消息）的伴侣 id 列表（T02 收尾 §3.8）。
 * 规则：所有 status='girlfriend' 的伴侣，并**始终包含主女友 id=1**（即便其状态异常也保证既有数据被推进）；
 * 按 id 升序 → c1 先跑、行为可预测。
 *
 * 零回归要点：主女友（id=1）在无 cId() 上下文时即默认目标，故其推进结果与"仅推进主女友"的旧行为逐字段一致。
 */
export function listAdvanceableCompanions(): number[] {
  const rows = dbAll<{ id: number }>(
    "SELECT id FROM companions WHERE status = 'girlfriend' OR is_primary = 1 ORDER BY id ASC"
  );
  const ids = rows
    .map((r) => Math.trunc(Number(r.id)))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.includes(PRIMARY_COMPANION_ID)) ids.unshift(PRIMARY_COMPANION_ID);
  return ids;
}

/** 显示名：她自命名（personas.agent_name）优先，其次通讯录名（companions.name） */
export function displayNameOf(id: number, fallback: string): string {
  const name = withCompanion(id, () => getPersona().agent_name);
  return name && name.trim() ? name.trim() : fallback;
}

export interface RosterEntry {
  id: number;
  name: string;
  displayName: string;
  age: number;
  gender: string;
  identity: string | null;
  personality_tags: string[];
  portrait_desc: string | null;
  avatar_url: string | null;
  intro: string | null;
  status: string;
  statusLabel: string;
  attraction: number;
  is_primary: number;
  is_discovered: number;
  pending: number;
  pursue_opt_in: number;
  reject_count: number;
  cooldown_until: string | null;
  established_at: string | null;
  closed_at: string | null;
  last_active_at: string | null;
  updated_at: string;
  unread: number;
  isPendingCandidate: boolean;
  /** 来历：'cast'（她的室友/同事/朋友等身边人）| 'auto'（交往中自动识别）| 'random'（陌生人）| null（主女友/老数据） */
  origin_kind: string | null;
  /** 通过哪位伴侣认识（介绍人 id） */
  origin_companion_id: number | null;
  /** 介绍人的显示名（UI 用；无来历则为 null） */
  origin_from_name: string | null;
  /** 一句话来历描述（UI 直接展示） */
  origin_label: string | null;
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((x) => String(x)).slice(0, 8) : [];
  } catch {
    return [];
  }
}

/** 未读角标：她（assistant）尚未被读的消息数（read_at IS NULL） */
export function unreadCount(id: number): number {
  return withCompanion(id, () => {
    const r = cGet<{ c: number }>(
      "SELECT COUNT(*) AS c FROM messages WHERE companion_id = ? AND role = 'assistant' AND read_at IS NULL"
    );
    return Number(r?.c ?? 0);
  });
}

export function toRosterEntry(row: CompanionRow): RosterEntry {
  return {
    id: Number(row.id),
    name: row.name,
    displayName: displayNameOf(Number(row.id), row.name),
    age: Number(row.age),
    gender: row.gender,
    identity: row.identity,
    personality_tags: parseTags(row.personality_tags),
    portrait_desc: row.portrait_desc,
    avatar_url: row.avatar_url,
    intro: row.intro,
    status: row.status,
    statusLabel: statusLabel(row.status),
    attraction: round1(Number(row.attraction ?? 0)),
    is_primary: Number(row.is_primary),
    is_discovered: Number(row.is_discovered),
    pending: Number(row.pending),
    pursue_opt_in: Number(row.pursue_opt_in),
    reject_count: Number(row.reject_count),
    cooldown_until: row.cooldown_until,
    established_at: row.established_at,
    closed_at: row.closed_at,
    last_active_at: row.last_active_at,
    updated_at: row.updated_at,
    unread: unreadCount(Number(row.id)),
    isPendingCandidate: Number(row.pending) === 1,
    ...originFieldsOf(row),
  };
}

/** 来历字段（UI 展示用）：谁介绍、怎么认识 */
function originFieldsOf(row: CompanionRow): {
  origin_kind: string | null;
  origin_companion_id: number | null;
  origin_from_name: string | null;
  origin_label: string | null;
} {
  const kind = row.origin_kind ?? null;
  const fromId = row.origin_companion_id == null ? null : Number(row.origin_companion_id);
  const fromName = fromId && getCompanion(fromId) ? displayNameOf(fromId, '她') : null;
  const role = row.identity ? String(row.identity) : '朋友';
  const label =
    kind === 'cast' && fromName
      ? `通过${fromName}认识 · 她的${role}`
      : kind === 'auto'
        ? fromName
          ? `${fromName}常提到的人`
          : '交往中注意到的人'
        : kind === 'random'
          ? '偶然遇见'
          : null;
  return { origin_kind: kind, origin_companion_id: fromId, origin_from_name: fromName, origin_label: label };
}

export interface RosterView {
  primary: RosterEntry | null;
  girlfriends: RosterEntry[];
  pursuing: RosterEntry[];
  acquaintances: RosterEntry[];
  pending: RosterEntry[];
  closed: RosterEntry[];
}

/** 通讯录：按 status 分组（主女友 / 女友 / 追求中 / 认识的人 / 待处理发现区 / 已关闭） */
export function listRoster(): RosterView {
  const rows = dbAll<CompanionRow>('SELECT * FROM companions ORDER BY is_primary DESC, id ASC');
  const view: RosterView = { primary: null, girlfriends: [], pursuing: [], acquaintances: [], pending: [], closed: [] };
  for (const row of rows) {
    const entry = toRosterEntry(row);
    if (Number(row.pending) === 1 && Number(row.is_discovered) !== 1) {
      view.pending.push(entry);
      continue;
    }
    if (row.status === 'closed') {
      view.closed.push(entry);
      continue;
    }
    if (Number(row.is_primary) === 1) {
      view.primary = entry;
      continue;
    }
    if (row.status === 'girlfriend') {
      view.girlfriends.push(entry);
      continue;
    }
    if (row.status === 'pursuing' || row.status === 'ambiguous' || row.status === 'cold' || row.status === 'rejected') {
      view.pursuing.push(entry);
      continue;
    }
    view.acquaintances.push(entry);
  }
  return view;
}

/* ------------------------------------------------------------------ */
/* 面板初始化（幂等）                                                   */
/* ------------------------------------------------------------------ */
/**
 * 为某个伴侣幂等补种「全套空面板」（只建结构、不拷任何主女友数据）：
 *   relationship_state / attachment_state / personality_state / personas +
 *   复用既有 ensure*（life 作用域）补 agent_* / shared_world / intimacy_* 等。
 * 记忆与回合账本保持空（后续自然累积）；用户画像走全局 settings，不复制。
 * 重复调用不产生重复行、不覆盖已有数据；对主女友（=1）调用亦零变化。
 */
export function initPanels(companionId: number): void {
  const id = normalizeId(companionId);
  const row = getCompanion(id);
  if (!row) return;
  const now = nowIso();
  withCompanion(id, () => {
    // 关系状态（PK = companion_id）；已存在则保留（= 晋升时点的攻略值）
    if (!cGet<{ companion_id: number }>('SELECT companion_id FROM relationship_state WHERE companion_id = ?')) {
      cRun(
        `INSERT OR IGNORE INTO relationship_state
           (companion_id, user_id, intimacy, trust, mood, stage, stage_entered_at, stage_cap_since, pending_stage_confirm,
            pending_relationship_talk, conflict_state, last_conflict_at, nickname, anniversary,
            last_interaction_at, streak_days, emotional_balance, repair_credit, unresolved_tension, updated_at)
         VALUES (?, ?, 0, 0, '好奇', 0, ?, NULL, 0, 0, 'none', NULL, NULL, NULL, NULL, 0, 0, 0, 0, ?)`,
        DEFAULT_USER_ID,
        now,
        now
      );
    }
    // 依恋状态：30 / 30 / secure
    cRun(
      'INSERT OR IGNORE INTO attachment_state (companion_id, user_id, anxiety, avoidance, style, updated_at) VALUES (?, ?, 30, 30, ?, ?)',
      DEFAULT_USER_ID,
      'secure',
      now
    );
    // 人格 6 维，各 50
    for (const d of DIMENSIONS) {
      cRun(
        `INSERT OR IGNORE INTO personality_state
           (companion_id, user_id, dimension, value, solidified, last_adjusted_turn, updated_at)
         VALUES (?, ?, ?, 50, 0, 0, ?)`,
        DEFAULT_USER_ID,
        d.key,
        now
      );
    }
    // personas 行：由 companions 角色卡写入 agent_name/age/occupation/self_story
    if (!cGet<{ id: number }>('SELECT id FROM personas WHERE companion_id = ? LIMIT 1')) {
      cRun(
        'INSERT INTO personas (companion_id, user_id, agent_name, age, occupation, self_story, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        DEFAULT_USER_ID,
        row.name,
        String(row.age),
        row.identity ?? null,
        row.intro ?? null,
        now,
        now
      );
    }
    // 生活 / 亲密等：复用既有 ensure*（以本伴侣作用域幂等补种，不重写）
    ensureLife();
  });
}

/** 该伴侣是否已具备聊天所需的最小面板（relationship_state 是否已建） */
export function hasPanels(companionId: number): boolean {
  const id = normalizeId(companionId);
  return withCompanion(id, () => {
    const r = cGet<{ companion_id: number }>('SELECT companion_id FROM relationship_state WHERE companion_id = ?');
    return !!r;
  });
}

/* ------------------------------------------------------------------ */
/* 创建 / 认识                                                          */
/* ------------------------------------------------------------------ */
export interface CreateCompanionInput {
  name: string;
  age: number;
  gender?: string;
  identity?: string;
  personality_tags?: string[];
  portrait_desc?: string;
  intro?: string;
  first_meet_scene?: string;
  gen_seed?: string;
  /** 创建后即进入「攻略」=1；否则默认为手动认识的普通人 */
  pursue?: boolean;
}

export type CompanionResult =
  | { ok: true; companion: CompanionRow }
  | { ok: false; code: string; error: string; existingId?: number };

/** 手动创建/认识一名伴侣（成年校验 + 去重 + 幂等补种面板） */
export function createCompanion(input: CreateCompanionInput): CompanionResult {
  const name = String(input?.name ?? '').trim().slice(0, 24);
  if (!name) return { ok: false, code: 'INVALID_INPUT', error: '名字不能为空' };
  const age = Math.trunc(Number(input?.age));
  if (!Number.isFinite(age) || age < AGE_MIN) {
    return { ok: false, code: 'AGE_RESTRICTED', error: '伴侣角色必须年满 18 岁' };
  }
  if (age > 99) return { ok: false, code: 'INVALID_INPUT', error: '年龄不合法' };

  const identity = input.identity ? String(input.identity).slice(0, 60) : null;
  const portrait = input.portrait_desc ? String(input.portrait_desc).slice(0, 300) : null;
  const hash = dedupeHash(name, identity, portrait);
  const dup = dbGet<{ id: number }>('SELECT id FROM companions WHERE dedupe_hash = ?', hash);
  if (dup) return { ok: false, code: 'DUPLICATE', error: '同名同身份的角色已存在', existingId: Number(dup.id) };

  const tags = Array.isArray(input.personality_tags)
    ? input.personality_tags.slice(0, 8).map((t) => String(t).slice(0, 12))
    : [];
  const pursue = !!input.pursue;
  const now = nowIso();

  const res = dbRun(
    `INSERT INTO companions
       (user_id, name, age, gender, identity, personality_tags, portrait_desc, intro, first_meet_scene,
        gen_seed, dedupe_hash, status, attraction, is_primary, is_discovered, pending, pursue_opt_in,
        reject_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, 0, ?, 0, ?, ?)`,
    DEFAULT_USER_ID,
    name,
    age,
    input.gender ? String(input.gender).slice(0, 12) : 'female',
    identity,
    JSON.stringify(tags),
    portrait,
    input.intro ? String(input.intro).slice(0, 400) : null,
    input.first_meet_scene ? String(input.first_meet_scene).slice(0, 120) : null,
    input.gen_seed ? String(input.gen_seed).slice(0, 64) : null,
    hash,
    pursue ? 'acquaintance' : 'stranger',
    pursue ? 1 : 0,
    now,
    now
  );
  const id = Number(res.lastInsertRowid);
  initPanels(id); // 让该角色立刻可聊天（空面板；幂等）
  logCompanionEvent(id, 'meet', `认识了新的人：${name}`, { reason: pursue ? 'manual+pursue' : 'manual' });
  const companion = getCompanion(id);
  if (!companion) return { ok: false, code: 'DB_ERROR', error: '伴侣写入失败' };
  return { ok: true, companion };
}

/* ------------------------------------------------------------------ */
/* 暂不 / 攻略 / 晋升                                                   */
/* ------------------------------------------------------------------ */
/** 「暂不」：保留为认识的人（pursue_opt_in=0，无亲密、无主动） */
export function optOut(companionId: number): CompanionResult {
  const id = normalizeId(companionId);
  const row = getCompanion(id);
  if (!row) return { ok: false, code: 'COMPANION_NOT_FOUND', error: '伴侣不存在' };
  dbRun(
    `UPDATE companions
        SET pursue_opt_in = 0, pending = 0, is_discovered = 1,
            status = CASE WHEN status IN ('girlfriend', 'closed') THEN status ELSE 'acquaintance' END,
            updated_at = ?
      WHERE id = ?`,
    nowIso(),
    id
  );
  logCompanionEvent(id, 'meet', '暂不攻略，保留为认识的人', { oldValue: row.status, newValue: 'acquaintance', reason: 'opt_out' });
  return { ok: true, companion: getCompanion(id)! };
}

/** 「攻略」：进入追求期并把候选人纳入通讯录（幂等补种面板） */
export function pursueOptIn(companionId: number): CompanionResult {
  const id = normalizeId(companionId);
  const row = getCompanion(id);
  if (!row) return { ok: false, code: 'COMPANION_NOT_FOUND', error: '伴侣不存在' };
  // 仅在「陌生人」时提升为认识；已处于暧昧/追求中等更靠后的状态不做回退。
  dbRun(
    `UPDATE companions
        SET pursue_opt_in = 1, pending = 0, is_discovered = 1,
            status = CASE WHEN status = 'stranger' THEN 'acquaintance' ELSE status END,
            updated_at = ?
      WHERE id = ?`,
    nowIso(),
    id
  );
  if (!hasPanels(id)) initPanels(id);
  logCompanionEvent(id, 'pursue', '决定攻略这名角色', { oldValue: row.status, newValue: 'acquaintance', reason: 'opt_in' });
  return { ok: true, companion: getCompanion(id)! };
}

/** 晋升为女友：状态置 girlfriend + established_at + 初始化全套面板（幂等） */
/** 晋升时的「来历」联动：她是某位伴侣身边的人（室友/同事/朋友）→ 两人天然是熟人，
 *  建立一条正向初始关系边（+25），让她俩在关系网里一开始就认识，而不是陌生人（0）。
 *  关系值写入仍只经 applyDelta（其内部经 applyRelationshipDelta 唯一好感写点）。 */
function linkOriginRelation(id: number): void {
  const row = getCompanion(id);
  if (!row) return;
  const from = Number(row.origin_companion_id ?? 0);
  if (!Number.isFinite(from) || from <= 0 || from === id) return;
  if (!getCompanion(from)) return;
  if (listRelationsFor(id).some((e) => Number(e.a_id) === from || Number(e.b_id) === from)) return; // 幂等：已有关系边就不重复加
  applyDelta(from, id, 25, `同源相识：她是「${displayNameOf(from, '她')}」身边的人`);
}

export function promote(companionId: number): CompanionResult {
  const id = normalizeId(companionId);
  const row = getCompanion(id);
  if (!row) return { ok: false, code: 'COMPANION_NOT_FOUND', error: '伴侣不存在' };
  markGirlfriend(id);
  initPanels(id);
  linkOriginRelation(id);
  return { ok: true, companion: getCompanion(id)! };
}

export interface PursueOutcome {
  ok: boolean;
  accepted: boolean;
  status: string;
  code?: string;
  reject_count?: number;
  cooldown_until?: string | null;
  companion?: CompanionRow;
}

/** 表白/晋升确认：达标 → 晋升（并初始化面板）；未达标 → 被拒（冷却 / 永久关闭） */
export function confess(companionId: number): PursueOutcome {
  const id = normalizeId(companionId);
  const row = getCompanion(id);
  if (!row) return { ok: false, accepted: false, status: 'closed', code: 'COMPANION_NOT_FOUND' };
  if (row.status === 'girlfriend') {
    return { ok: true, accepted: true, status: 'girlfriend', code: 'ALREADY_GIRLFRIEND', companion: row };
  }
  const res = resolveConfession(id);
  if (res.accepted) {
    initPanels(id);
    linkOriginRelation(id);
  }
  return {
    ok: true,
    accepted: res.accepted,
    status: res.status,
    code: res.code,
    reject_count: res.reject_count,
    cooldown_until: res.cooldown_until,
    companion: getCompanion(id)!,
  };
}

/* ------------------------------------------------------------------ */
/* 资料页                                                              */
/* ------------------------------------------------------------------ */
export interface CompanionProfile {
  companion: CompanionRow | null;
  roster: RosterEntry | null;
  persona: { agent_name: string | null; age: string | null; occupation: string | null; self_story: string | null } | null;
  relationship: {
    intimacy: number;
    trust: number;
    mood: string;
    stage: number;
    stageName: string;
    conflict_state: string;
    emotional_balance: number;
    last_interaction_at: string | null;
  } | null;
  pursuit: PursuitProgress | null;
  events: unknown[];
  relations: RelationEdge[];
}

export function profilePage(companionId: number): CompanionProfile {
  const id = normalizeId(companionId);
  const row = getCompanion(id);
  if (!row) {
    return { companion: null, roster: null, persona: null, relationship: null, pursuit: null, events: [], relations: [] };
  }
  const persona = withCompanion(id, () => getPersona());
  const rel: RelationshipState | null = withCompanion(id, () => {
    try {
      return getRelationshipState();
    } catch {
      return null;
    }
  });
  return {
    companion: row,
    roster: toRosterEntry(row),
    persona,
    relationship: rel
      ? {
          intimacy: round1(rel.intimacy),
          trust: round1(rel.trust),
          mood: rel.mood,
          stage: rel.stage,
          stageName: stageOf(rel.stage).name,
          conflict_state: rel.conflict_state,
          emotional_balance: round1(rel.emotional_balance),
          last_interaction_at: rel.last_interaction_at,
        }
      : null,
    pursuit: progressOf(id),
    events: dbAll('SELECT * FROM companion_events WHERE companion_id = ? ORDER BY id DESC LIMIT 30', id),
    relations: listRelationsFor(id),
  };
}

/* ------------------------------------------------------------------ */
/* 删除                                                                */
/* ------------------------------------------------------------------ */
/** 删除一名非主女友伴侣及其全部伴侣域数据（主女友不可删） */
export function deleteCompanion(companionId: number): { ok: boolean; code?: string; error?: string } {
  const id = normalizeId(companionId);
  const row = getCompanion(id);
  if (!row) return { ok: false, code: 'COMPANION_NOT_FOUND', error: '伴侣不存在' };
  if (Number(row.is_primary) === 1) return { ok: false, code: 'PERMISSION_PRIMARY', error: '不能删除主女友' };
  tx(() => {
    // 先清掉依赖 memory_id 的向量，避免留下孤儿
    dbRun('DELETE FROM memory_embeddings WHERE memory_id IN (SELECT id FROM memories WHERE companion_id = ?)', id);
    for (const t of COMPANION_SCOPED_TABLES) dbRun(`DELETE FROM ${t} WHERE companion_id = ?`, id);
    dbRun('DELETE FROM companion_relations WHERE a_id = ? OR b_id = ?', id, id);
    dbRun('DELETE FROM companion_events WHERE companion_id = ?', id);
    dbRun('DELETE FROM group_members WHERE companion_id = ?', id);
    dbRun('DELETE FROM activity_participants WHERE companion_id = ?', id);
    dbRun('DELETE FROM companions WHERE id = ?', id);
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 便捷视图 / 错误码映射                                                */
/* ------------------------------------------------------------------ */
export { canConfess, inCooldown, progressOf };

/** 语义错误码 → HTTP 状态（沿用既有 API 风格：{ error } / { error, code }） */
export function httpStatusForCode(code: string | undefined): number {
  switch (code) {
    case 'COMPANION_NOT_FOUND':
      return 404;
    case 'AGE_RESTRICTED':
      return 400;
    case 'INVALID_INPUT':
      return 400;
    case 'PERMISSION_ONLY_GIRLFRIEND':
    case 'PERMISSION_PRIMARY':
      return 403;
    case 'PURSUIT_REJECTED_COOLDOWN':
    case 'COMPANION_CLOSED':
    case 'DUPLICATE':
    case 'PENDING_LIMIT':
      return 409;
    default:
      return 400;
  }
}
