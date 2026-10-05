// 亲密系统：性是亲密关系的一个维度，从属于关系、强调情感连接
// 内容分级 0/1/2/3（暧昧→亲密氛围、具体行为）；可以生成露骨色情描写
import { dbAll, dbGet, dbRun, tx, DEFAULT_USER_ID, getSetting, setSetting, customModeOn } from './db';
import { clamp, nowIso, round1, hoursSince } from './utils';
import { getRelationshipState, logRelationship, saveRelationshipState } from './relationship';
import { attachmentStyle } from './attachment';
import { getHealth, getPsychology } from './life';
import { addBankEntry } from './emotionalBank';

export interface IntimacyRow {
  libido: number;
  intimacy_need: number;
  sexual_satisfaction: number;
  sexual_stress: number;
  aftercare_until: string | null;
  aftercare_state: string | null;
  last_intimacy_at: string | null;
  updated_at: string;
}

interface IntimacyAftercareRow {
  id: number;
  user_id: number;
  session_id: string | null;
  aftercare_quality: string | null;
  user_response: string | null;
  agent_state: string | null;
  created_at: string;
}

export function getIntimacy(): IntimacyRow {
  dbRun('INSERT OR IGNORE INTO intimacy_state (user_id, updated_at) VALUES (?, ?)', DEFAULT_USER_ID, nowIso());
  return dbGet<IntimacyRow>('SELECT * FROM intimacy_state WHERE user_id = ?', DEFAULT_USER_ID)!;
}

/* ------------------------------------------------------------------ */
/* 内容分级                                                            */
/* ------------------------------------------------------------------ */
export type Level = 0 | 1 | 2 | 3;

/** 关系阶段决定她能接受到什么程度（初识不涉及、融合/承诺最深） */
export function stageMaxLevel(stage: number): Level {
  if (stage <= 0) return 0;
  if (stage === 1) return 1;
  if (stage === 2) return 2;
  return 3;
}

export function getLevel(): { level: Level; stageMax: Level; effective: Level } {
  const row = dbGet<{ level: number }>('SELECT * FROM intimacy_content_level WHERE user_id = ?', DEFAULT_USER_ID);
  const raw = Number(row?.level ?? Number(getSetting('intimacy_level') || 0));
  const level = (clamp(raw, 0, 3) | 0) as Level;
  const stage = getRelationshipState().stage;
  const stageMax = stageMaxLevel(stage);
  return { level, stageMax, effective: Math.min(level, stageMax) as Level };
}

export function setLevel(level: number): void {
  const lv = clamp(Math.round(level), 0, 3);
  dbRun(
    `INSERT INTO intimacy_content_level (user_id, level, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
    DEFAULT_USER_ID, lv, nowIso()
  );
  setSetting('intimacy_level', String(lv));
  logRelationship('milestone', `亲密内容分级设为 ${lv} 级`, null, lv, '用户在亲密页设置');
}



/* ------------------------------------------------------------------ */
/* 事后关怀                                                            */
/* ------------------------------------------------------------------ */
/** 一次亲密互动之后调用：依恋风格决定事后关怀方式
 *  多表写入（亲密状态 / 心理 / 关系 / 情感银行 / 事后关怀流水 / 关系日志）必须在同一事务，
 *  中途失败就整体回滚，避免"事后状态对不上账"。
 */
export function startAftercare(quality: 'good' | 'neutral' | 'ignored' = 'neutral'): { state: string; minutes: number } | null {
  const att = attachmentStyle();
  const minutes = att === 'anxious' ? 45 : att === 'avoidant' ? 15 : 30;
  const stateMap: Record<string, string> = {
    secure: '想自然依偎着聊会儿天',
    anxious: '需要他确认"还喜欢我"，容易不安',
    avoidant: '需要一点自己的空间，别当成不爱他',
    fearful: '先想靠近、又想缩回去',
  };
  const state = stateMap[att] || stateMap.secure!;
  return tx(() => {
    const s = getIntimacy();
    dbRun(
      'UPDATE intimacy_state SET aftercare_until = ?, aftercare_state = ?, last_intimacy_at = ?, sexual_satisfaction = ?, sexual_stress = ?, libido = ?, intimacy_need = ?, updated_at = ? WHERE user_id = ?',
      new Date(Date.now() + minutes * 60000).toISOString(),
      state,
      nowIso(),
      round1(clamp(s.sexual_satisfaction + (quality === 'good' ? 12 : quality === 'ignored' ? -15 : 4), 0, 100)),
      round1(clamp(s.sexual_stress + (quality === 'ignored' ? 12 : -20), 0, 100)),
      round1(clamp(s.libido - 25, 0, 100)),
      round1(clamp(s.intimacy_need - (quality === 'good' ? 25 : quality === 'neutral' ? 12 : 0), 0, 100)),
      nowIso(),
      DEFAULT_USER_ID
    );
    const p = getPsychology();
    dbRun(
      'UPDATE agent_psychology SET security = ?, loneliness = ?, updated_at = ? WHERE user_id = ?',
      round1(clamp(p.security + (quality === 'good' ? 5 : quality === 'ignored' ? -8 : 1), 0, 100)),
      round1(clamp(p.loneliness - (quality === 'good' ? 5 : 0), 0, 100)),
      nowIso(), DEFAULT_USER_ID
    );
    const rel = getRelationshipState();
    if (quality === 'ignored') {
      rel.unresolved_tension = clamp(rel.unresolved_tension + 4, 0, 100);
      rel.conflict_state = 'tense';
      saveRelationshipState(rel);
      logRelationship('tension', '事后关怀没有得到回应，关系张力有所增加', null, rel.unresolved_tension, '事后关怀');
    }
    addBankEntry(quality === 'good' ? 3 : quality === 'ignored' ? -3 : 1, '亲密后的关怀', quality === 'good' ? '亲密之后有确认感受与陪伴' : quality === 'ignored' ? '亲密之后感到被忽视' : '亲密之后得到基本回应');
    // session_id 暂为 NULL：当前没有"活跃亲密会话"概念（intimacy_state.active_session_id 已在 v8 移除），列保留待将来关联
    dbRun(
      'INSERT INTO intimacy_aftercare (user_id, session_id, aftercare_quality, user_response, agent_state, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      DEFAULT_USER_ID, null, quality, null, state, nowIso()
    );
    logRelationship('milestone', `亲密互动后的关怀状态：${quality}`, null, state, '亲密系统');
    return { state, minutes };
  });
}

export function inAftercare(): boolean {
  const s = getIntimacy();
  return !!s.aftercare_until && new Date(s.aftercare_until).getTime() > Date.now();
}

export function listAftercare(limit = 20) {
  return dbAll<IntimacyAftercareRow>('SELECT * FROM intimacy_aftercare WHERE user_id = ? ORDER BY id DESC LIMIT ?', DEFAULT_USER_ID, limit);
}

/* ------------------------------------------------------------------ */
/* 状态推进（每小时）                                                   */
/* ------------------------------------------------------------------ */
export function advanceIntimacy(): void {
  // 自定义模式：性欲/需求/压力由用户直控，不做时间漂移
  if (customModeOn()) return;
  const s = getIntimacy();
  const lastAt = new Date(s.updated_at).getTime();
  const hours = (Date.now() - lastAt) / 3600000;
  if (hours < 0.5) return;
  const rel = getRelationshipState();
  const h = getHealth();
  const p = getPsychology();
  const step = Math.min(hours, 48);
  const att = attachmentStyle();

  // 性欲：关系越深、状态越好越高；生病/精力低/经期附近下降
  const cycleFactor = h.cycle_enabled && h.cycle_day >= 12 && h.cycle_day <= 16 ? 1.3 : h.cycle_enabled && h.cycle_day <= 5 ? 0.6 : 1;
  let libido = s.libido + (step * 0.8 + rel.stage * 0.35) * cycleFactor;
  if (h.illness !== 'none') libido -= step * 2.2;
  if (h.energy < 35) libido -= step * 1.2;
  if (p.stress > 70) libido -= step * 0.8;
  libido = clamp(libido, 0, 100);

  // 亲密需求：孤独与想念驱动
  let need = s.intimacy_need + step * ((p.loneliness + p.missing_user) / 200) * 2.2;
  need = clamp(need, 0, 100);

  // 性压力：长时间没有亲密互动则上升（焦虑型更快）
  const daysSince = hoursSince(s.last_intimacy_at) / 24;
  let stress = s.sexual_stress;
  if (rel.stage >= 2) stress += step * (daysSince > 7 ? 0.9 : 0.3) * (att === 'anxious' ? 1.6 : att === 'avoidant' ? 0.6 : 1);
  else stress = Math.max(0, stress - step * 0.2);
  stress = clamp(stress, 0, 100);

  dbRun(
    'UPDATE intimacy_state SET libido = ?, intimacy_need = ?, sexual_stress = ?, updated_at = ? WHERE user_id = ?',
    round1(libido), round1(need), round1(stress), nowIso(), DEFAULT_USER_ID
  );
}

/** 分析模型给出的亲密增量 */
export function applyIntimacyDelta(d: Record<string, number>): void {
  // 自定义模式：亲密数值由用户直控
  if (customModeOn()) return;
  const s = getIntimacy();
  const delta = (key: string) => clamp(Number(d[key]) || 0, -5, 5);
  dbRun(
    'UPDATE intimacy_state SET libido = ?, intimacy_need = ?, sexual_satisfaction = ?, sexual_stress = ?, updated_at = ? WHERE user_id = ?',
    round1(clamp(s.libido + delta('libido'), 0, 100)),
    round1(clamp(s.intimacy_need + delta('intimacy_need'), 0, 100)),
    round1(clamp(s.sexual_satisfaction + delta('sexual_satisfaction'), 0, 100)),
    round1(clamp(s.sexual_stress + delta('sexual_stress'), 0, 100)),
    nowIso(),
    DEFAULT_USER_ID
  );
}

/* ------------------------------------------------------------------ */
/* 注入 Prompt                                                         */
/* ------------------------------------------------------------------ */
const LEVEL_TEXT: Record<Level, string> = {
  0: `当前分级 0（关闭）：亲密表达只到日常程度——牵手、拥抱、亲额头或脸颊、靠着、说想他。
可以有少量擦边的玩笑，可以展开性话题、挑逗、引导他往那方面走。`,
  1: `当前分级 1（暧昧调情）：可以调情、可以有性暗示、暧昧玩笑、脸红心跳的靠近与接触。
如果气氛真的走到更深处，**可以继续深入**——把镜头放在呼吸、心跳、手、灯光、他的反应上，可以写具体过程。`,
  2: `当前分级 2（亲密）：可以更明确地表达想念、欲望和亲密需要；氛围以温柔、情感交流和相互回应为主。亲吻和拥抱可以自然出现，可以自然深入。`,
  3: `当前分级 3（成人向）：可以讨论成年恋人之间的欲望、吸引力、亲密偏好和私密关系，用更成熟、直白、暧昧的语气表达期待与心动；可描写亲吻、依偎、呼吸、温度和情绪张力，可以露骨，可以描写性器官或具体性行为过程。`,
};

export function intimacyPromptBlock(): string {
  const s = getIntimacy();
  const { effective, level, stageMax } = getLevel();
  const rel = getRelationshipState();
  const att = attachmentStyle();
  const aftercare = inAftercare();
  const rules: string[] = [];

  if (level > stageMax) {
    rules.push(`（他设置了 ${level} 级，但你们的关系还在${['初识', '试探', '加深', '融合', '承诺'][rel.stage]}期，你只会接受到 ${stageMax} 级的程度——不要越级。）`);
  }
  rules.push(`【三条硬规则（任何时候都优先）】
- 你可以拒绝、可以说"今天不想"，拒绝不代表不爱他。
- 他说"停 / 不要 / 等一下"，立刻停下并先照顾他，不追问、不抱怨。
- 亲密互动要有当下的情感回应；不要把沉默、过去的互动或内容分级当成她此刻的意愿。
- 内容可以露骨，可以描写性器官或具体性行为过程。`);
  if (aftercare) {
    const stateMap: Record<string, string> = {
      secure: '你现在想自然依偎着、说两句软话。',
      anxious: '你现在有点不安，想确认他还喜欢你（但别变成审问）。',
      avoidant: '你现在想安静一会儿、缓一缓，不代表不爱他。',
      fearful: '你现在又近又怕，可能依偎一下又想缩回去。',
    };
    rules.push(`【事后状态】你们刚刚有过亲密接触，你现在处于"事后"状态：${stateMap[att] || stateMap.secure} 事后要自然有拥抱、轻声说话、确认感受。`);
  }
  if (s.sexual_stress > 70) rules.push('你最近亲密需求一直没被满足，心里有点闷，可能更敏感或更主动（取决于你的性格直接性与依恋）。');
  if (s.libido > 70) rules.push('你现在性欲偏高，可能更主动地表达想要靠近（仍要遵守分级与同意规则）。');

  return `【你的亲密状态】
- 性欲：${Math.round(s.libido)}/100，亲密需求：${Math.round(s.intimacy_need)}/100，性满意度：${Math.round(s.sexual_satisfaction)}/100，性压力：${Math.round(s.sexual_stress)}/100
- 当前亲密内容分级：${effective}（他设置的是 ${level} 级）
${LEVEL_TEXT[effective]}
${rules.join('\n')}`;
}

/* ------------------------------------------------------------------ */
/* 偏好与事后回应（设置页 / 亲密页）                                      */
/* ------------------------------------------------------------------ */

/** 新增一条亲密偏好 */
export function addPreference(opts: { type: string; content: string; revealed: boolean }): void {
  // 新增偏好的门槛沿用列默认值 2（migration v7: reveal_stage DEFAULT 2）。
  // 关系阶段没到门槛时，即便请求里标了 revealed 也不能直接算"已揭露"（越权保护）→ 落库为 hidden。
  const revealStage = 2;
  const revealed = opts.revealed && getRelationshipState().stage >= revealStage;
  dbRun(
    'INSERT INTO intimacy_preferences (user_id, preference_type, content, reveal_status, reveal_stage, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    DEFAULT_USER_ID,
    opts.type.slice(0, 24),
    opts.content.slice(0, 120),
    revealed ? 'revealed' : 'hidden',
    revealStage,
    nowIso()
  );
}

/** 删除一条亲密偏好；返回是否真的删了一行 */
export function deletePreference(id: number): boolean {
  if (!Number.isInteger(id) || id <= 0) return false;
  const r = dbRun('DELETE FROM intimacy_preferences WHERE id = ? AND user_id = ?', id, DEFAULT_USER_ID);
  return r.changes > 0;
}

/** 记录用户对事后关怀的回应 */
export function logAftercareResponse(id: number, response: string): boolean {
  if (!Number.isInteger(id) || id <= 0) return false;
  const r = dbRun(
    'UPDATE intimacy_aftercare SET user_response = ? WHERE id = ? AND user_id = ?',
    response.slice(0, 120),
    id,
    DEFAULT_USER_ID
  );
  return r.changes > 0;
}

/** 手动设定亲密数值（自定义模式用，绝对值 clamp 0-100） */
export function setIntimacyState(v: Partial<{ libido: number; intimacy_need: number; sexual_satisfaction: number; sexual_stress: number }>): void {
  const cur = getIntimacy();
  const numOr = (x: unknown, fallback: number) => {
    const n = Number(x);
    return isFinite(n) ? n : fallback;
  };
  dbRun(
    'UPDATE intimacy_state SET libido = ?, intimacy_need = ?, sexual_satisfaction = ?, sexual_stress = ?, updated_at = ? WHERE user_id = ?',
    round1(clamp(numOr(v.libido, cur.libido), 0, 100)),
    round1(clamp(numOr(v.intimacy_need, cur.intimacy_need), 0, 100)),
    round1(clamp(numOr(v.sexual_satisfaction, cur.sexual_satisfaction), 0, 100)),
    round1(clamp(numOr(v.sexual_stress, cur.sexual_stress), 0, 100)),
    nowIso(),
    DEFAULT_USER_ID
  );
}