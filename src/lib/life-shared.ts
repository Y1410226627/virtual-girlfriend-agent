// 生活系统 · 共享世界层：共享地点/约定/仪式/物品、她身边的人、亲密度偏好、档案揭露
// 由 life.ts 拆分而来（原样搬移，行为不变）
import { dbAll, dbGet, dbRun, DEFAULT_USER_ID } from './db';
import { nowIso, safeJson } from './utils';
import { getRelationshipState } from './relationship';
import { logLife, getProfileSeed, type CastMember } from './life-core';

/** shared_world 里的条目（地点 / 仪式 / 物品） */
interface SharedEntry { content?: string; title?: string; created_at?: string }
/** shared_world 里的计划（多 status / done_at） */
interface SharedPlan extends SharedEntry { status?: string; done_at?: string | null }

export function getSharedWorld() {
  const row = dbGet<{
    shared_places_json: string | null;
    shared_plans_json: string | null;
    shared_rituals_json: string | null;
    shared_items_json: string | null;
    cast_json: string | null;
  }>('SELECT * FROM shared_world WHERE user_id = ?', DEFAULT_USER_ID);
  return {
    places: safeJson<SharedEntry[]>(row?.shared_places_json, []),
    plans: safeJson<SharedPlan[]>(row?.shared_plans_json, []),
    rituals: safeJson<SharedEntry[]>(row?.shared_rituals_json, []),
    items: safeJson<SharedEntry[]>(row?.shared_items_json, []),
    cast: safeJson<CastMember[]>(row?.cast_json, []),
  };
}

/** 她身边的人（具名社会关系）：规整化后返回 */
export function getCast(): CastMember[] {
  const arr = getSharedWorld().cast;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({
      name: String(c.name ?? '').trim(),
      role: String(c.role ?? '').trim(),
      note: String(c.note ?? '').trim(),
    }))
    .filter((c) => c.name);
}

/** 设定她身边的人（整组替换 [{name, role, note}]，已在路由侧做校验） */
export function setCast(cast: CastMember[]): void {
  dbRun('UPDATE shared_world SET cast_json = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(cast), nowIso(), DEFAULT_USER_ID);
}

/* ------------------------------------------------------------------ */
/* 共享世界                                                            */
/* ------------------------------------------------------------------ */
export function addSharedPlan(content: string, status = 'planning'): void {
  const w = getSharedWorld();
  const plans = w.plans || [];
  if (plans.some((p) => (p.content || p.title) === content)) return;
  plans.push({ content, status, created_at: nowIso() });
  dbRun('UPDATE shared_world SET shared_plans_json = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(plans), nowIso(), DEFAULT_USER_ID);
  logLife('shared_plan', '', content, '新的共同约定');
}

export function addSharedRitual(content: string): void {
  const w = getSharedWorld();
  const rituals = w.rituals || [];
  if (rituals.some((p) => (p.content || p.title) === content)) return;
  rituals.push({ content, created_at: nowIso() });
  dbRun('UPDATE shared_world SET shared_rituals_json = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(rituals), nowIso(), DEFAULT_USER_ID);
  logLife('shared_ritual', '', content, '新的共同仪式');
}

export function addSharedPlace(content: string): void {
  const w = getSharedWorld();
  const places = w.places || [];
  if (places.some((p) => (p.content || p.title) === content)) return;
  places.push({ content, created_at: nowIso() });
  dbRun('UPDATE shared_world SET shared_places_json = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(places), nowIso(), DEFAULT_USER_ID);
  logLife('shared_place', '', content, '共同地点');
}

export function addSharedItem(content: string): void {
  const value = String(content || '').trim().slice(0, 120);
  if (!value) return;
  const w = getSharedWorld();
  const items = w.items || [];
  if (items.some((item) => (item.content || item.title) === value)) return;
  items.push({ content: value, created_at: nowIso() });
  dbRun('UPDATE shared_world SET shared_items_json = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(items), nowIso(), DEFAULT_USER_ID);
  logLife('shared_item', '', value, '共同物品或共同记忆');
}

export function completePlan(index: number): void {
  const w = getSharedWorld();
  const plans = w.plans || [];
  if (!plans[index]) return;
  plans[index].status = plans[index].status === 'done' ? 'planning' : 'done';
  plans[index].done_at = plans[index].status === 'done' ? nowIso() : null;
  dbRun('UPDATE shared_world SET shared_plans_json = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(plans), nowIso(), DEFAULT_USER_ID);
}

/* ------------------------------------------------------------------ */
/* 个人信息：按关系阶段逐步揭露                                          */
/* ------------------------------------------------------------------ */
export const FIELD_STAGE: Record<string, number> = {
  nickname: 0, age: 0, city: 0, hobbies: 0,
  // 名字与生日：用户填了就该能说出来（原来没登记 → 永远"未揭露"，成了死数据）
  name: 1, birthday: 2,
  hometown: 1, education: 1, job: 1, habits: 1, catchphrases: 1,
  family: 2, dreams: 2,
  fears: 3,
  secrets: 4,
};

export function labelOf(field: string): string {
  const map: Record<string, string> = {
    name: '名字', nickname: '昵称', age: '年龄', birthday: '生日',
    hometown: '家乡', city: '现居城市', family: '家庭', education: '专业/学校', job: '工作',
    hobbies: '爱好', habits: '小习惯', catchphrases: '口头禅', fears: '害怕的事', dreams: '梦想', secrets: '小秘密',
  };
  return map[field] || field;
}

/** 分析模型判定"这轮揭露了哪些个人信息"后写入状态 */
/** 某个字段现在算不算"已经告诉过他"（显式揭露 或 关系阶段到了） */
export function isFieldRevealed(field: string): boolean {
  const seed = getProfileSeed();
  if (seed.reveal?.[field] === true) return true;
  const minStage = FIELD_STAGE[field];
  if (minStage === undefined) return false;
  return getRelationshipState().stage >= minStage;
}

export function revealProfileFields(fields: string[]): void {
  if (!fields || !fields.length) return;
  const seed = getProfileSeed();
  const reveal = { ...(seed.reveal || {}) };
  for (const f of fields) {
    if (!(f in FIELD_STAGE)) continue;
    if (reveal[f]) continue;
    reveal[f] = true;
    logLife('profile_reveal', f, '已揭露', '在对话中自然说出');
  }
  dbRun('UPDATE agent_profile SET reveal_status = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(reveal), nowIso(), DEFAULT_USER_ID);
}

/* ------------------------------------------------------------------ */
/* 亲密偏好（逐步揭露）                                                 */
/* ------------------------------------------------------------------ */
/** intimacy_preferences 行 */
interface IntimacyPreferenceRow {
  id: number; preference_type: string; content: string;
  reveal_status: string; reveal_stage: number; created_at: string;
}

export function listPreferences(includeHidden = false) {
  return includeHidden
    ? dbAll<IntimacyPreferenceRow>('SELECT * FROM intimacy_preferences WHERE user_id = ? ORDER BY id', DEFAULT_USER_ID)
    : dbAll<IntimacyPreferenceRow>("SELECT * FROM intimacy_preferences WHERE user_id = ? AND reveal_status = 'revealed' ORDER BY id", DEFAULT_USER_ID);
}

export function revealPreferences(types: string[]): void {
  if (!types || !types.length) return;
  const stage = getRelationshipState().stage;
  for (const t of types) {
    // 逐行按各自的门槛判定（原来按类型取第一行的 reveal_stage 批量改，同类型多行时门槛判定错位）
    const rows = dbAll<IntimacyPreferenceRow>(
      "SELECT id, reveal_stage FROM intimacy_preferences WHERE user_id = ? AND preference_type = ? AND reveal_status != 'revealed'",
      DEFAULT_USER_ID,
      t
    );
    for (const p of rows) {
      if (stage < Number(p.reveal_stage || 0)) continue;
      dbRun("UPDATE intimacy_preferences SET reveal_status = 'revealed' WHERE id = ?", p.id);
    }
  }
}