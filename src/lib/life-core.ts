// 生活系统 · 核心层：表初始化 / 基础读写 / 日志 / 手动直控状态 / 生病与生理周期
// 由 life.ts 拆分而来（原样搬移，行为不变）
import { dbRun, DEFAULT_USER_ID, getSetting, setSetting, setCounter, customModeOn, cRun, cGet, cAll } from './db';
import { clamp, nowIso, round1, safeJson } from './utils';
import { logRelationship, getPersona } from './relationship';
import { cId, ck } from './companion-context';

/* ------------------------------------------------------------------ */
/* 表初始化                                                            */
/* ------------------------------------------------------------------ */
/** 她身边的人：默认两位角色（cast 为空时播种，性质上只播一次） */
export const DEFAULT_CAST: Array<{ name: string; role: string; note: string }> = [
  { name: '小夏', role: '室友', note: '同一个宿舍，爱睡懒觉，常一起点外卖' },
  { name: '阿悦', role: '闺蜜', note: '隔壁班，从高中就认识，爱拉着她逛街' },
];

export function ensureLife(): void {
  const now = nowIso();
  // v14 起这些单行状态表主键为 companion_id → 显式写入 companion_id（T01：主女友=1），
  // 否则 INSERT OR IGNORE 因主键缺省会被 rowid 自增成新行（重复行）。
  cRun('INSERT OR IGNORE INTO agent_health (companion_id, user_id, updated_at) VALUES (?, ?, ?)', DEFAULT_USER_ID, now);
  cRun('INSERT OR IGNORE INTO agent_psychology (companion_id, user_id, updated_at) VALUES (?, ?, ?)', DEFAULT_USER_ID, now);
  cRun('INSERT OR IGNORE INTO agent_location (companion_id, user_id, current_location, location_type, arrived_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', DEFAULT_USER_ID, '家', 'home', now, now);
  cRun('INSERT OR IGNORE INTO agent_activity (companion_id, user_id, current_activity, activity_type, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', DEFAULT_USER_ID, '发呆', 'idle', now, now);
  cRun('INSERT OR IGNORE INTO agent_profile (companion_id, user_id, reveal_status, updated_at) VALUES (?, ?, ?, ?)', DEFAULT_USER_ID, '{}', now);
  cRun(
    'INSERT OR IGNORE INTO shared_world (companion_id, user_id, shared_places_json, shared_plans_json, shared_rituals_json, shared_items_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    DEFAULT_USER_ID, '[]', '[]', '[]', '[]', now
  );
  // 她身边的人：只在"从未播种过"时种一次（用户把 cast 清空/删光后，重启不该被种回来）。
  // T02 收尾（extended fix）：播种标记按伴侣私有命名空间，否则主女友播过之后，新伴侣会被误判
  // "已播种"而永远没有默认 cast。主女友沿用无后缀键（向后兼容既有库）。
  if (getSetting(ck('cast_seeded')) !== '1') {
    setSetting(ck('cast_seeded'), '1');
    const worldRow = cGet<{ cast_json: string | null }>('SELECT cast_json FROM shared_world WHERE companion_id = ?');
    if (!worldRow || !worldRow.cast_json || safeJson<CastMember[]>(worldRow.cast_json, []).length === 0) {
      dbRun('UPDATE shared_world SET cast_json = ?, updated_at = ? WHERE companion_id = ?', JSON.stringify(DEFAULT_CAST), nowIso(), cId());
    }
  }
  cRun('INSERT OR IGNORE INTO intimacy_state (companion_id, user_id, updated_at) VALUES (?, ?, ?)', DEFAULT_USER_ID, now);
  cRun('INSERT OR IGNORE INTO intimacy_content_level (companion_id, user_id, level, updated_at) VALUES (?, ?, 0, ?)', DEFAULT_USER_ID, now);
  // 只在"从未播种过"时种一次：用户删掉自己的偏好后，重启不该被种回来。
  // 同理按伴侣私有命名空间，保证新伴侣也有出厂偏好。
  if (getSetting(ck('prefs_seeded')) !== '1') {
    setSetting(ck('prefs_seeded'), '1');
    if (!cGet('SELECT id FROM intimacy_preferences WHERE companion_id = ? LIMIT 1')) {
      seedPreferences();
    }
  }
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */
export interface HealthRow {
  energy: number; sleep_quality: number; hunger: number; illness: string;
  illness_start: string | null; illness_duration_days: number | null; illness_severity: number;
  cared_count: number; cycle_enabled: number; cycle_day: number; cycle_length: number;
  exercise: number; last_meal_at: string | null; woke_at: string | null; updated_at: string;
}
export interface PsychRow {
  base_emotion: string; stress: number; loneliness: number; missing_user: number;
  security: number; self_worth: number; mental_energy: number; updated_at: string;
}
export interface LocationRow { current_location: string; location_type: string; arrived_at: string | null; expected_leave_at: string | null; updated_at: string }
export interface ActivityRow { current_activity: string; activity_type: string; started_at: string | null; expected_end_at: string | null; updated_at: string }

export function getHealth(): HealthRow {
  let row = cGet<HealthRow>('SELECT * FROM agent_health WHERE companion_id = ?');
  if (!row) {
    ensureLife();
    row = cGet<HealthRow>('SELECT * FROM agent_health WHERE companion_id = ?');
  }
  return row!;
}
export function getPsychology(): PsychRow {
  let row = cGet<PsychRow>('SELECT * FROM agent_psychology WHERE companion_id = ?');
  if (!row) {
    ensureLife();
    row = cGet<PsychRow>('SELECT * FROM agent_psychology WHERE companion_id = ?');
  }
  return row!;
}
export function getLocation(): LocationRow {
  let row = cGet<LocationRow>('SELECT * FROM agent_location WHERE companion_id = ?');
  if (!row) {
    ensureLife();
    row = cGet<LocationRow>('SELECT * FROM agent_location WHERE companion_id = ?');
  }
  return row!;
}
export function getActivity(): ActivityRow {
  let row = cGet<ActivityRow>('SELECT * FROM agent_activity WHERE companion_id = ?');
  if (!row) {
    ensureLife();
    row = cGet<ActivityRow>('SELECT * FROM agent_activity WHERE companion_id = ?');
  }
  return row!;
}
/** 档案字段的三态揭露状态：auto=按关系阶段自动判断 / revealed=已告诉他 / hidden=永不自动揭露 */
export type RevealState = 'auto' | 'revealed' | 'hidden';

/** 兼容旧数据：true→revealed，false/缺失/非法→auto */
export function normalizeRevealMap(raw: unknown): Record<string, RevealState> {
  const out: Record<string, RevealState> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === 'revealed' || v === 'hidden' || v === 'auto') out[k] = v;
      else if (v === true) out[k] = 'revealed';
      else if (v === false) out[k] = 'auto';
    }
  }
  return out;
}

/** agent_profile 行（SELECT *；各字段均为 TEXT） */
export interface ProfileSeed {
  reveal: Record<string, RevealState>;
  [field: string]: string | null | Record<string, RevealState>;
}

export function getProfileSeed(): ProfileSeed {
  const row = cGet<Record<string, string | null>>('SELECT * FROM agent_profile WHERE companion_id = ?');
  if (!row) return { reveal: {} };
  return { ...row, reveal: normalizeRevealMap(safeJson<unknown>(row.reveal_status, {})) };
}

export interface CastMember { name: string; role: string; note: string }

/** life_state_logs 行 */
export interface LifeLogRow { id: number; field: string; old_value: string | null; new_value: string | null; reason: string | null; created_at: string }
/** agent_daily_events 行 */
export interface DailyEventRow { id: number; event_type: string; content: string; impact_json: string | null; created_at: string }

export function listLifeLogs(limit = 60, sinceIso?: string) {
  return sinceIso
    ? cAll<LifeLogRow>('SELECT * FROM life_state_logs WHERE companion_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?', sinceIso, limit)
    : cAll<LifeLogRow>('SELECT * FROM life_state_logs WHERE companion_id = ? ORDER BY id DESC LIMIT ?', limit);
}
export function listDailyEvents(limit = 30, sinceIso?: string) {
  return sinceIso
    ? cAll<DailyEventRow>('SELECT * FROM agent_daily_events WHERE companion_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?', sinceIso, limit)
    : cAll<DailyEventRow>('SELECT * FROM agent_daily_events WHERE companion_id = ? ORDER BY id DESC LIMIT ?', limit);
}
/** 日常事件真实总数（接口返回最多 30 条明细时，用真实总数给前端显示"共 N 条"） */
export function countDailyEvents(): number {
  const row = cGet<{ c: number }>('SELECT COUNT(*) AS c FROM agent_daily_events WHERE companion_id = ?');
  return Number(row?.c || 0);
}

/* ------------------------------------------------------------------ */
/* 手动直控状态（"她的世界"页）                                          */
/* ------------------------------------------------------------------ */

/** 手动设定她此刻的身体数值（绝对值，clamp 0-100，cycle_day 1-60） */
export function setHealthStates(h: Partial<HealthRow> & { cycle_day?: number }): void {
  const cur = getHealth();
  const numOr = (v: unknown, fallback: number) => {
    const n = Number(v);
    return isFinite(n) ? n : fallback;
  };
  dbRun(
    'UPDATE agent_health SET energy = ?, sleep_quality = ?, hunger = ?, exercise = ?, cycle_day = ?, updated_at = ? WHERE companion_id = ?',
    round1(clamp(numOr(h.energy, cur.energy), 0, 100)),
    round1(clamp(numOr(h.sleep_quality, cur.sleep_quality), 0, 100)),
    round1(clamp(numOr(h.hunger, cur.hunger), 0, 100)),
    round1(clamp(numOr(h.exercise, cur.exercise), 0, 100)),
    Math.round(clamp(numOr(h.cycle_day, cur.cycle_day), 1, 60)),
    nowIso(),
    cId()
  );
}

/** 手动设定她此刻的心理数值（绝对值，clamp 0-100） */
export function setPsychologyStates(p: Partial<PsychRow>): void {
  const cur = getPsychology();
  const numOr = (v: unknown, fallback: number) => {
    const n = Number(v);
    return isFinite(n) ? n : fallback;
  };
  dbRun(
    'UPDATE agent_psychology SET stress = ?, loneliness = ?, missing_user = ?, security = ?, self_worth = ?, mental_energy = ?, updated_at = ? WHERE companion_id = ?',
    round1(clamp(numOr(p.stress, cur.stress), 0, 100)),
    round1(clamp(numOr(p.loneliness, cur.loneliness), 0, 100)),
    round1(clamp(numOr(p.missing_user, cur.missing_user), 0, 100)),
    round1(clamp(numOr(p.security, cur.security), 0, 100)),
    round1(clamp(numOr(p.self_worth, cur.self_worth), 0, 100)),
    round1(clamp(numOr(p.mental_energy, cur.mental_energy), 0, 100)),
    nowIso(),
    cId()
  );
}

/** 手动设定档案字段（昵称/年龄/职业/故事等） */
export function setProfileField(field: string, value: string): void {
  dbRun(`UPDATE agent_profile SET ${field} = ?, updated_at = ? WHERE companion_id = ?`, value, nowIso(), cId());
}

/**
 * 把档案字段设为"永不自动揭露"。
 * 三态后必须显式写 'hidden'：旧实现是删除记录（= 'auto'），到阶段照样会说出来，用户点"设为未说"无效。
 */
export function hideProfileField(field: string): void {
  const seed = getProfileSeed();
  const reveal = { ...(seed.reveal || {}) };
  reveal[String(field || '')] = 'hidden';
  dbRun('UPDATE agent_profile SET reveal_status = ?, updated_at = ? WHERE companion_id = ?', JSON.stringify(reveal), nowIso(), cId());
}

/** 直接结束病程（不经历康复过程） */
export function clearIllness(): void {
  dbRun('UPDATE agent_health SET illness = ?, illness_severity = 0, updated_at = ? WHERE companion_id = ?', 'none', nowIso(), cId());
}

/** 设定生理期开关与当前天数 */
export function setCycle(enabled: boolean, day: number): void {
  dbRun('UPDATE agent_health SET cycle_enabled = ?, cycle_day = ? WHERE companion_id = ?', enabled ? 1 : 0, Math.round(clamp(day, 1, 60)), cId());
}

/**
 * 只切换生理期开关。
 * 重新开启（此前是关闭状态）视为新周期开始，cycle_day 重置为 1——
 * 否则关闭数周后再打开会显示"第 28 天"，intimacy.ts 的周期系数也会按错误天数生效。
 */
export function setCycleEnabled(enabled: boolean): void {
  const cur = getHealth();
  if (enabled && cur.cycle_enabled !== 1) {
    dbRun('UPDATE agent_health SET cycle_enabled = 1, cycle_day = 1 WHERE companion_id = ?', cId());
    return;
  }
  dbRun('UPDATE agent_health SET cycle_enabled = ? WHERE companion_id = ?', enabled ? 1 : 0, cId());
}

/**
 * 写一条生活状态日志。
 * occurredAt：这件事"实际发生"的时间（历史回放时传对应的模拟时刻），默认现在。
 * 缺少它会让离线多天回放产生的日志全部落在"今天"，时间线读起来是错的。
 */
export function logLife(field: string, oldV: unknown, newV: unknown, reason: string, occurredAt?: string) {
  cRun(
    'INSERT INTO life_state_logs (companion_id, user_id, field, old_value, new_value, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    DEFAULT_USER_ID, field, String(oldV ?? ''), String(newV ?? ''), reason, occurredAt || nowIso()
  );
}

/* ------------------------------------------------------------------ */
/* 生病 / 生理周期                                                      */
/* ------------------------------------------------------------------ */
/**
 * 开始一段病程。
 * startedAt：发病"实际发生"的时间（历史回放时传模拟时刻），默认现在。
 */
export function startIllness(kind = '感冒', days = 2, startedAt?: string): void {
  const h = getHealth();
  const at = startedAt || nowIso();
  dbRun(
    'UPDATE agent_health SET illness = ?, illness_start = ?, illness_duration_days = ?, illness_severity = ?, energy = ?, updated_at = ? WHERE companion_id = ?',
    kind, at, round1(days), 40, clamp(h.energy - 25, 5, 100), at, cId()
  );
  // 记录发病时间戳：短期内不再重复触发（门限判定见 life-sim）
  setCounter(ck('illness_last_at'), new Date(at).getTime() || Date.now());
  logLife('illness', h.illness, kind, `生病了（预计 ${round1(days)} 天）`, at);
  logRelationship('milestone', `她的状态：开始${kind}（预计 ${round1(days)} 天恢复）`, null, kind, '健康系统');
}

/**
 * 一次"被关心"事件：关怀的全部效果都收敛到这里（单一入口，避免双路径重复加成）。
 * 合并了原 careBoost 的效果 + 原 applyInteractionEffects 里 caredForHer 的额外加成：
 * cared_count+1、病程加速、security+8、self_worth+6、loneliness-12、missing_user-6，并写一条 care 生活日志。
 * 自定义模式（模式 B）冻结自动数值 → no-op。
 */
export function applyCareEvent(kind: 'illness' | 'sick' | 'care' = 'care'): void {
  if (customModeOn()) return;
  const h = getHealth();
  dbRun('UPDATE agent_health SET cared_count = cared_count + 1, updated_at = ? WHERE companion_id = ?', nowIso(), cId());
  if (h.illness !== 'none') {
    // 被关心 → 恢复加快（最多提前 40%）
    const dur = h.illness_duration_days || 2;
    const newDur = Math.max(0.5, dur * 0.85);
    dbRun('UPDATE agent_health SET illness_duration_days = ? WHERE companion_id = ?', round1(newDur), cId());
  }
  const psy = getPsychology();
  dbRun(
    'UPDATE agent_psychology SET security = ?, self_worth = ?, loneliness = ?, missing_user = ?, updated_at = ? WHERE companion_id = ?',
    round1(clamp(psy.security + 8, 0, 100)),
    round1(clamp(psy.self_worth + 6, 0, 100)),
    round1(clamp(psy.loneliness - 12, 0, 100)),
    round1(clamp(psy.missing_user - 6, 0, 100)),
    nowIso(),
    cId()
  );
  logLife('care', kind, '被关心', '用户关心行为加速恢复、提升安全感');
}

/** 向后兼容别名：旧的关怀入口，内部统一走 applyCareEvent */
export function careBoost(kind: 'illness' | 'sick' | 'care'): void {
  applyCareEvent(kind);
}

/* ------------------------------------------------------------------ */
/* 日常轨迹（按她的身份推导；默认是"大一学生"，与你们的故事一致）        */
/* ------------------------------------------------------------------ */
export function isWeekend(d: Date): boolean {
  const w = d.getDay();
  return w === 0 || w === 6;
}

/* ------------------------------------------------------------------ */
/* 她的身份模板：从 personas.occupation 推导作息 / 事件 / 叙事口径        */
/* ------------------------------------------------------------------ */
export type LifeTemplate = 'student' | 'graduate' | 'worker' | 'intern' | 'freelancer';

/**
 * 从自由文本的身份描述识别生活模板（未知 → student，与旧默认一致）。
 * 判定顺序：研究生 / 实习 / 自由职业 先于"上班/工作"，学生放最后兜底。
 */
export function lifeTemplate(occupation?: string | null): LifeTemplate {
  const t = String(occupation || '');
  if (!t.trim()) return 'student';
  if (/研究生|硕士|博士|读研|直博|phd|master/i.test(t)) return 'graduate';
  if (/实习/.test(t)) return 'intern';
  if (/自由职业|自由撰稿|自由插画|独立开发|个体|接单/.test(t)) return 'freelancer';
  if (/上班|工作|职场|打工人|白领|职员|公务员|老师|教师|医生|护士|工程师|程序员|销售|会计|律师|设计师|运营/.test(t)) return 'worker';
  if (/大一|大二|大三|大四|大学生|学生|在读|高中|本科|大学|学校|读书|考研/.test(t)) return 'student';
  return 'student';
}

/** 当前身份模板（读 personas.occupation） */
export function currentLifeTemplate(): LifeTemplate {
  return lifeTemplate(getPersona().occupation);
}

/** 模板的中文描述（给生活线 / 叙事 prompt 用；student 保持"大一女生"与旧默认等价） */
export function lifeTemplateLabel(t: LifeTemplate): string {
  switch (t) {
    case 'graduate': return '在读研究生';
    case 'worker': return '上班族';
    case 'intern': return '实习生';
    case 'freelancer': return '自由职业者';
    default: return '大一女生';
  }
}

/* ------------------------------------------------------------------ */
/* 亲密偏好的默认播种（供 ensureLife 首次调用）                          */
/* ------------------------------------------------------------------ */
export function seedPreferences(): void {
  const now = nowIso();
  const items: Array<[string, string, string, number]> = [
    ['atmosphere', '喜欢安静、灯光柔和的环境，说话要慢', 'hidden', 2],
    ['style', '更喜欢温柔和慢慢来，不喜欢太急', 'hidden', 1],
    ['address', '被叫亲昵称呼会觉得害羞', 'hidden', 2],
    ['place', '喜欢被摸头发', 'hidden', 2],
    ['aftercare', '结束后想被抱着说会儿话，不要马上去做别的', 'hidden', 2],
  ];
  for (const [type, content, status, revealStage] of items) {
    cRun(
      'INSERT INTO intimacy_preferences (companion_id, user_id, preference_type, content, reveal_status, reveal_stage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      DEFAULT_USER_ID, type, content, status, revealStage, now
    );
  }
}