// 关系状态引擎：亲密度 / 信任 / 阶段跃迁 / 回退 / 关系日志
import { dbGet, dbRun, numSetting, DEFAULT_USER_ID, getSetting, setSetting } from './db';
import { clamp, nowIso, daysSince, round1, localDateStr } from './utils';
import { STAGES, stageOf } from './stages';
import type { RelationshipState, RelationshipDelta } from './types';

export function getRelationshipState(): RelationshipState {
  const s = dbGet<RelationshipState>('SELECT * FROM relationship_state WHERE user_id = ?', DEFAULT_USER_ID);
  if (!s) throw new Error('relationship_state 未初始化');
  return s;
}

export function saveRelationshipState(s: RelationshipState): void {
  dbRun(
    `UPDATE relationship_state SET
      intimacy = ?, trust = ?, mood = ?, stage = ?, stage_entered_at = ?, stage_cap_since = ?,
      pending_stage_confirm = ?, pending_relationship_talk = ?, conflict_state = ?, last_conflict_at = ?,
      nickname = ?, anniversary = ?, last_interaction_at = ?, streak_days = ?,
      emotional_balance = ?, repair_credit = ?, unresolved_tension = ?,
      scene = ?, scene_reason = ?, scene_updated_at = ?, updated_at = ?
     WHERE user_id = ?`,
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
    s.user_id
  );
}

export function logRelationship(
  kind: string,
  summary: string,
  oldValue?: any,
  newValue?: any,
  reason?: string
): void {
  dbRun(
    `INSERT INTO relationship_logs (user_id, kind, summary, old_value, new_value, reason, stage_at_time, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const s = getRelationshipState();
  const stage = stageOf(s.stage);

  const oldIntimacy = s.intimacy;
  const oldTrust = s.trust;
  const oldTension = s.unresolved_tension;
  const oldBalance = s.emotional_balance;
  const oldRepair = s.repair_credit;

  // 亲密度受阶段上限约束：未跃迁前不能越过阶段天花板
  s.intimacy = clamp(s.intimacy + (Number(d.intimacy) || 0), stage.min, stage.max);
  s.trust = clamp(s.trust + (Number(d.trust) || 0), 0, 100);
  if (d.mood) s.mood = String(d.mood).slice(0, 12);
  s.emotional_balance = clamp(s.emotional_balance + (Number(d.emotional_balance_delta) || 0), -100, 100);
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
  if (round1(oldBalance) !== round1(s.emotional_balance)) {
    logRelationship(
      'bank',
      `情感余额 ${round1(oldBalance)} → ${round1(s.emotional_balance)}`,
      oldBalance,
      s.emotional_balance,
      reason
    );
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
  const s = getRelationshipState();
  const stage = stageOf(s.stage);
  const now = nowIso();

  // 1) 是否到达天花板
  if (s.intimacy >= stage.max - 0.01) {
    if (!s.stage_cap_since) {
      s.stage_cap_since = now;
      saveRelationshipState(s);
      logRelationship('milestone', `亲密度达到${stage.name}期上限，开始计算阶段跃迁等待期`, null, null, reason);
    }
  } else if (s.stage_cap_since) {
    s.stage_cap_since = null;
    saveRelationshipState(s);
  }

  // 2) 等待期满足 → 标记需要一次关系确认对话
  const dwellDays = Math.max(0, numSetting('stage_dwell_days', 3));
  const cur = getRelationshipState();
  if (
    cur.stage_cap_since &&
    cur.intimacy >= stageOf(cur.stage).max - 0.01 &&
    daysSince(cur.stage_cap_since) >= dwellDays &&
    cur.stage < STAGES.length - 1 &&
    !cur.pending_stage_confirm
  ) {
    cur.pending_stage_confirm = 1;
    saveRelationshipState(cur);
    logRelationship(
      'milestone',
      `等待期已满足，${stageOf(cur.stage).name}期 → ${STAGES[cur.stage + 1].name}期：等待一次关系确认对话`,
      cur.stage,
      cur.stage + 1,
      reason
    );
  }

  // 3) 关系确认 → 升阶
  const latest = getRelationshipState();
  if (relationshipConfirmation && latest.pending_stage_confirm && latest.stage < STAGES.length - 1) {
    const oldStage = latest.stage;
    latest.stage = oldStage + 1;
    latest.stage_entered_at = now;
    latest.stage_cap_since = null;
    latest.pending_stage_confirm = 0;
    latest.pending_relationship_talk = 0;
    latest.mood = '心动';
    // 新阶段的亲密度从新阶段下限开始
    latest.intimacy = clamp(latest.intimacy, STAGES[latest.stage].min, STAGES[latest.stage].max);
    saveRelationshipState(latest);
    logRelationship(
      'stage_up',
      `阶段跃迁：${STAGES[oldStage].name} → ${STAGES[latest.stage].name}`,
      oldStage,
      latest.stage,
      reason || '关系确认对话完成'
    );
    return getRelationshipState();
  }

  // 4) 回退：亲密度跌破下限超过 10，或张力爆表进入危机
  const st = getRelationshipState();
  const def = stageOf(st.stage);
  if (st.stage > 0 && st.intimacy < def.min - 10) {
    const oldStage = st.stage;
    st.stage = oldStage - 1;
    st.stage_entered_at = now;
    st.stage_cap_since = null;
    st.pending_stage_confirm = 0;
    st.mood = '低落';
    saveRelationshipState(st);
    logRelationship(
      'stage_down',
      `关系回退：${STAGES[oldStage].name} → ${STAGES[st.stage].name}`,
      oldStage,
      st.stage,
      reason || '长期负向互动且未修复'
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
  const p = dbGet<any>('SELECT * FROM personas WHERE user_id = ?', DEFAULT_USER_ID);
  return {
    agent_name: p?.agent_name ?? null,
    age: p?.age ?? null,
    occupation: p?.occupation ?? null,
    self_story: p?.self_story ?? null,
  };
}

export function setPersonaField(field: 'agent_name' | 'age' | 'occupation' | 'self_story', value: string): void {
  dbRun(
    `UPDATE personas SET ${field} = ?, updated_at = ? WHERE user_id = ?`,
    value || null,
    nowIso(),
    DEFAULT_USER_ID
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