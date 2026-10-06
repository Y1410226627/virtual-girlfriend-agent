// 关系状态引擎：亲密度 / 信任 / 阶段跃迁 / 回退 / 关系日志
import { dbRun, cGet, cRun, numSetting, DEFAULT_USER_ID, getSetting, setSetting, customModeOn } from './db';
import { cId } from './companion-context';
import { clamp, nowIso, daysSince, round1, localDateStr, safeJson } from './utils';
import { STAGES, stageOf } from './stages';
import type { RelationshipState, RelationshipDelta } from './types';

interface PersonaRow {
  agent_name: string | null;
  age: string | null;
  occupation: string | null;
  self_story: string | null;
}

export function getRelationshipState(): RelationshipState {
  const s = cGet<RelationshipState>('SELECT * FROM relationship_state WHERE companion_id = ?');
  if (!s) throw new Error('relationship_state 未初始化');
  return s;
}

export function saveRelationshipState(s: RelationshipState): void {
  // UPDATE 的 companion_id 占位符在语法上位于 SET 之后，用 dbRun + 显式 cId()（不能走 cRun 首参注入）
  dbRun(
    `UPDATE relationship_state SET
      intimacy = ?, trust = ?, mood = ?, stage = ?, stage_entered_at = ?, stage_cap_since = ?,
      pending_stage_confirm = ?, pending_relationship_talk = ?, conflict_state = ?, last_conflict_at = ?,
      nickname = ?, anniversary = ?, last_interaction_at = ?, streak_days = ?,
      emotional_balance = ?, repair_credit = ?, unresolved_tension = ?,
      scene = ?, scene_reason = ?, scene_updated_at = ?, updated_at = ?
     WHERE companion_id = ?`,
    s.intimacy,
    s.trust,
    s.mood,
    s.stage,
    s.stage_entered_at,
    s.stage_cap_since,
    s.pending_stage_confirm,
    s.pending_relationship_talk,
    s.conflict_state,
    s.last_conflict_at,
    s.nickname,
    s.anniversary,
    s.last_interaction_at,
    s.streak_days,
    s.emotional_balance,
    s.repair_credit,
    s.unresolved_tension,
    s.scene || 'online',
    s.scene_reason ?? null,
    s.scene_updated_at ?? null,
    nowIso(),
    cId()
  );
}

/* ------------------------------------------------------------------ */
/* 此刻情绪（ad-hoc affect）：与长期指标分家，带时效（P1-16）             */
/* ------------------------------------------------------------------ */
export interface AffectState {
  primary: string;
  /** 效价 -1..1（负向 .. 正向） */
  valence: number;
  /** 唤醒度 0..1（平静 .. 激动） */
  arousal: number;
  cause: string;
  confidence: number;
  /** 过期时间（ISO）；过期即忽略 */
  expiresAt: string;
}

/**
 * 读取此刻情绪；不存在 / 字段无效 / 已过期 → null（过期即忽略，回退长期 mood）。
 * now 作为参数传入便于写确定性测试。
 */
export function getAffectState(now = Date.now()): AffectState | null {
  const row = cGet<{ affect_json: string | null }>(
    'SELECT affect_json FROM relationship_state WHERE companion_id = ?'
  );
  const a = safeJson<Partial<AffectState> | null>(row?.affect_json ?? null, null);
  if (!a || typeof a !== 'object') return null;
  const primary = typeof a.primary === 'string' ? a.primary.trim() : '';
  const expiresAt = typeof a.expiresAt === 'string' ? a.expiresAt : '';
  if (!primary || !expiresAt) return null;
  if (new Date(expiresAt).getTime() <= now) return null;
  return {
    primary: primary.slice(0, 8),
    valence: clamp(Number(a.valence) || 0, -1, 1),
    arousal: clamp(Number(a.arousal) || 0, 0, 1),
    cause: typeof a.cause === 'string' ? a.cause.slice(0, 40) : '',
    confidence: clamp(Number(a.confidence) || 0, 0, 1),
    expiresAt,
  };
}

/** 写入此刻情绪（只动 affect_json 列，不触碰 saveRelationshipState 维护的其余字段） */
export function saveAffectState(a: AffectState): void {
  dbRun(
    'UPDATE relationship_state SET affect_json = ?, updated_at = ? WHERE companion_id = ?',
    JSON.stringify(a),
    nowIso(),
    cId()
  );
}

export function logRelationship(
  kind: string,
  summary: string,
  oldValue?: unknown,
  newValue?: unknown,
  reason?: string
): void {
  cRun(
    `INSERT INTO relationship_logs (companion_id, user_id, kind, summary, old_value, new_value, reason, stage_at_time, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    DEFAULT_USER_ID,
    kind,
    summary,
    oldValue === undefined ? null : JSON.stringify(oldValue),
    newValue === undefined ? null : JSON.stringify(newValue),
    reason || null,
    getRelationshipState().stage,
    nowIso()
  );
}

/** 应用一轮分析得到的关系增量 */
export function applyRelationshipDelta(d: Partial<RelationshipDelta>, reason: string): RelationshipState {
  // 自定义模式：数值不自动变，完全由用户直控
  if (customModeOn()) return getRelationshipState();
  const s = getRelationshipState();
  const stage = stageOf(s.stage);

  const oldIntimacy = s.intimacy;
  const oldTrust = s.trust;
  const oldTension = s.unresolved_tension;
  const oldRepair = s.repair_credit;

  // 亲密度受阶段上限约束：未跃迁前不能越过阶段天花板
  s.intimacy = clamp(s.intimacy + (Number(d.intimacy) || 0), stage.min, stage.max);
  s.trust = clamp(s.trust + (Number(d.trust) || 0), 0, 100);
  if (d.mood) s.mood = String(d.mood).slice(0, 12);
  // 情感余额不在这里改：余额的唯一记账点是 addBankEntry（写流水时一并改余额），
  // 否则会和分析里的显式记账（addBankEntry）重复计算成 2 倍。
  s.unresolved_tension = clamp(
    s.unresolved_tension + (Number(d.unresolved_tension_delta) || 0),
    0,
    100
  );
  s.repair_credit = clamp(s.repair_credit + (Number(d.repair_credit_delta) || 0), 0, 100);

  saveRelationshipState(s);

  if (round1(oldIntimacy) !== round1(s.intimacy)) {
    logRelationship(
      'intimacy',
      `亲密度 ${round1(oldIntimacy)} → ${round1(s.intimacy)}`,
      oldIntimacy,
      s.intimacy,
      reason
    );
  }
  if (round1(oldTrust) !== round1(s.trust)) {
    logRelationship('trust', `信任 ${round1(oldTrust)} → ${round1(s.trust)}`, oldTrust, s.trust, reason);
  }
  if (round1(oldTension) !== round1(s.unresolved_tension)) {
    logRelationship(
      'tension',
      `未解决张力 ${round1(oldTension)} → ${round1(s.unresolved_tension)}`,
      oldTension,
      s.unresolved_tension,
      reason
    );
  }
  if (round1(oldRepair) !== round1(s.repair_credit)) {
    logRelationship('repair', `修复信用 ${round1(oldRepair)} → ${round1(s.repair_credit)}`, oldRepair, s.repair_credit, reason);
  }
  return getRelationshipState();
}

/**
 * 检查阶段跃迁 / 回退：
 * - 升阶：亲密度达到阶段天花板 + 持续 N 天 + 一次"关系确认"对话
 * - 降阶：亲密度跌破下一阶段下限（下降超过 10）且未修复
 */
export function checkStageTransition(relationshipConfirmation = false, reason = ''): RelationshipState {
  // 自定义模式：阶段由用户直控，不做自动跃迁/回退
  if (customModeOn()) return getRelationshipState();
  const s = getRelationshipState();
  const stage = stageOf(s.stage);
  const now = nowIso();
  // 已达顶后的滞回容差：一次小的负向互动不该把"跃迁等待期"清零（否则关系永远攒不满、卡死）
  const CAP_EPS = 2;

  // 1) 是否到达天花板（带滞回：跌到 max-2 以下才算真的掉下来）
  if (s.intimacy >= stage.max - 0.01) {
    if (!s.stage_cap_since) {
      s.stage_cap_since = now;
      saveRelationshipState(s);
      logRelationship('milestone', `亲密度达到${stage.name}期上限，开始计算阶段跃迁等待期`, null, null, reason);
    }
  } else if (s.stage_cap_since && s.intimacy < stage.max - CAP_EPS) {
    s.stage_cap_since = null;
    saveRelationshipState(s);
  }

  // 2) 等待期满足 → 标记需要一次关系确认对话
  const dwellDays = Math.max(0, numSetting('stage_dwell_days', 3));
  const cur = getRelationshipState();
  if (
    cur.stage_cap_since &&
    cur.intimacy >= stageOf(cur.stage).max - CAP_EPS &&
    daysSince(cur.stage_cap_since) >= dwellDays &&
    cur.stage < STAGES.length - 1 &&
    !cur.pending_stage_confirm
  ) {
    cur.pending_stage_confirm = 1;
    saveRelationshipState(cur);
    logRelationship(
      'milestone',
      `等待期已满足，${stageOf(cur.stage).name}期 → ${STAGES[cur.stage + 1]!.name}期：等待一次关系确认对话`,
      cur.stage,
      cur.stage + 1,
      reason
    );
  }

  // 3) 关系确认 → 升阶（升阶前复核：亲密度仍在线、且没有冷战/高张力这类没解决的事）
  const latest = getRelationshipState();
  const upgradeBlocked = latest.unresolved_tension >= 70 || latest.conflict_state === 'cold_war';
  if (
    relationshipConfirmation &&
    latest.pending_stage_confirm &&
    latest.stage < STAGES.length - 1 &&
    latest.intimacy >= stageOf(latest.stage).max - CAP_EPS &&
    !upgradeBlocked
  ) {
    const oldStage = latest.stage;
    latest.stage = oldStage + 1;
    latest.stage_entered_at = now;
    latest.stage_cap_since = null;
    latest.pending_stage_confirm = 0;
    latest.pending_relationship_talk = 0;
    latest.mood = '心动';
    // 新阶段的亲密度从新阶段下限开始
    latest.intimacy = clamp(latest.intimacy, STAGES[latest.stage]!.min, STAGES[latest.stage]!.max);
    saveRelationshipState(latest);
    logRelationship(
      'stage_up',
      `阶段跃迁：${STAGES[oldStage]!.name} → ${STAGES[latest.stage]!.name}`,
      oldStage,
      latest.stage,
      reason || '关系确认对话完成'
    );
    return getRelationshipState();
  }

  // 4) 回退：用不会被钳制的量判定
  //    （原判据 intimacy < min-10 是死代码：applyRelationshipDelta 已把亲密度钳在 [min,max]，永远不成立）
  const st = getRelationshipState();
  const crisis = st.unresolved_tension >= 85 && st.conflict_state === 'cold_war';
  const drained = st.emotional_balance <= -60 && st.trust < 30;
  const settledLongEnough = !st.stage_entered_at || daysSince(st.stage_entered_at) >= 1;
  if (st.stage > 0 && (crisis || drained) && settledLongEnough) {
    const oldStage = st.stage;
    st.stage = oldStage - 1;
    st.stage_entered_at = now;
    st.stage_cap_since = null;
    st.pending_stage_confirm = 0;
    st.mood = '低落';
    // 回退后亲密度同步落到新阶段的合法区间（不能留着上一阶段的高值）
    st.intimacy = clamp(st.intimacy, STAGES[st.stage]!.min, STAGES[st.stage]!.max);
    saveRelationshipState(st);
    logRelationship(
      'stage_down',
      `关系回退：${STAGES[oldStage]!.name} → ${STAGES[st.stage]!.name}`,
      oldStage,
      st.stage,
      reason || (crisis ? '未解决的冷战持续' : '情感账户长期透支')
    );
  }
  return getRelationshipState();
}

/** 连续互动天数（每天首次交互时更新） */
export function touchInteraction(): void {
  const s = getRelationshipState();
  const today = localDateStr();
  const last = s.last_interaction_at ? localDateStr(new Date(s.last_interaction_at)) : null;
  if (last !== today) {
    const yesterday = localDateStr(new Date(Date.now() - 86400000));
    s.streak_days = last === yesterday ? s.streak_days + 1 : 1;
  }
  s.last_interaction_at = nowIso();
  saveRelationshipState(s);
}

/* ------------------------------------------------------------------ */
/* 昵称 / 纪念日 / 人设                                                */
/* ------------------------------------------------------------------ */
export function getPersona(): { agent_name: string | null; age: string | null; occupation: string | null; self_story: string | null } {
  const p = cGet<PersonaRow>('SELECT * FROM personas WHERE companion_id = ?');
  return {
    agent_name: p?.agent_name ?? null,
    age: p?.age ?? null,
    occupation: p?.occupation ?? null,
    self_story: p?.self_story ?? null,
  };
}

/** setPersonaField 允许写入的列白名单（列名会拼进 SQL，运行时兜底防止越权列名） */
const PERSONA_FIELDS: ReadonlySet<string> = new Set(['agent_name', 'age', 'occupation', 'self_story']);

export function setPersonaField(field: 'agent_name' | 'age' | 'occupation' | 'self_story', value: string): void {
  if (!PERSONA_FIELDS.has(field)) throw new Error(`非法的人设字段：${String(field)}`);
  dbRun(
    `UPDATE personas SET ${field} = ?, updated_at = ? WHERE companion_id = ?`,
    value || null,
    nowIso(),
    cId()
  );
}

export function agentName(): string {
  const name = getPersona().agent_name;
  if (name && name.trim()) return name.trim();
  return '她';
}

export function userName(): string {
  const n = getSetting('user_name');
  return n && n.trim() ? n.trim() : '你';
}

export function setUserName(name: string): void {
  setSetting('user_name', name);
  if (name && name.trim()) {
    dbRun('UPDATE users SET name = ? WHERE id = ?', name.trim(), DEFAULT_USER_ID);
  }
}

/* ------------------------------------------------------------------ */
/* 纪念日 / 事件（关系页的"重要日子"）                                    */
/* ------------------------------------------------------------------ */

/** 新增一条关系事件（纪念日/生日/计划） */
export function addEvent(opts: {
  title: string;
  event_date: string;
  repeat_yearly: boolean;
  kind: 'anniversary' | 'birthday' | 'plan' | 'custom';
  description?: string | null;
}): void {
  cRun(
    'INSERT INTO events (companion_id, user_id, title, event_date, repeat_yearly, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    DEFAULT_USER_ID,
    opts.title,
    opts.event_date,
    opts.repeat_yearly ? 1 : 0,
    opts.kind,
    opts.description || null,
    nowIso()
  );
}

/** 删除一条关系事件；返回是否真的删了一行 */
export function deleteEvent(id: number): boolean {
  if (!Number.isInteger(id) || id <= 0) return false;
  const r = cRun('DELETE FROM events WHERE companion_id = ? AND id = ?', id);
  return r.changes > 0;
}