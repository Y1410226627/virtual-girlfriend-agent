// 同场感知（v16 · §3.4/§3.5）：人在同一空间，就会看见、听见、记住。
//
// 设计要点：
// - detectCohabitants(hostId)：找出「此刻与 host 在同一空间的人」——
//   ① 其他 status='girlfriend' 的伴侣：agent_location.current_location 与 host 相同者（复用 life-core.getLocation 读取）；
//   ② host 的 cast（她身边的人）：室友/家人天然「在家即在」——简化假设：**全部视为在场**，
//      不按地点过滤（cast 没有独立的 agent_location 行，做真实位置模型成本远超收益）；
//   ③ 排除：closed 的伴侣；host 自己。
// - ensurePresenceGroup(hostId, member)：host 与某一在场者开启/复用共处群（origin='presence'）。
//   member 是 cast（未升格）时「见面即认识」：自动生成伴侣行并**直接置 acquaintance**
//   （跳过候选待处理——已经当面认识了，不该再弹「发现区待处理」），initPanels 幂等补面板。
// - endPresenceGroup(groupId)：结束共处群（status='ended'）+ 触发共域记忆写入（writeSharedMemories，
//   见 group.ts：每群每人只写一条，幂等）。
// - 并发纪律：所有写操作走 withGroupLock（key 前缀 'g:'，与伴侣会话锁隔离的叶子锁）。
//   建群阶段的「查重 + 创建」在 withGroupLock(hostId) 内串行（key 与真实群 id 同命名空间，
//   偶发撞号只会带来无害的额外串行，不会产生逻辑错误）。
// - 表域纪律：groups/group_members/group_messages/companions 是全局表 → 一律 db* 原生；
//   伴侣域读写（host 私聊摘要、cast）在 withCompanion 作用域内用 cAll/cGet。
import { dbAll, dbGet, dbRun, cAll, DEFAULT_USER_ID } from './db';
import { withCompanion } from './companion-context';
import { nowIso } from './utils';
import { getLocation } from './life-core';
import { getCast } from './life-shared';
import { getCompanion, displayNameOf, initPanels } from './companion';
import { generateCandidateFromCast } from './candidate-gen';
import { logCompanionEvent } from './pursuit';
import { withGroupLock } from './group-run';
import { validateMemberStatuses, writeSharedMemories } from './group';
import type { GroupRow, CompanionRow } from './types';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */
/** 一个「此刻在场」的人（伴侣或她身边的人） */
export interface Cohabitant {
  kind: 'companion' | 'cast';
  /** kind='companion' 时的伴侣 id */
  id?: number;
  name: string;
  role: string;
  note?: string;
}

/** ensurePresenceGroup 的成员入参 */
export interface PresenceMemberInput {
  kind: 'companion' | 'cast';
  /** kind='companion' 时必填 */
  id?: number;
  /** kind='cast' 时必填（host 的 cast 名） */
  name?: string;
  role?: string;
  note?: string;
}

export interface EnsurePresenceResult {
  ok: boolean;
  code?: string;
  error?: string;
  groupId?: number;
  /** true=本次新建群；false=复用既有共处群 */
  created?: boolean;
  /** 成员最终落到的伴侣 id（cast 升格后即为新伴侣行 id） */
  memberId?: number;
}

export interface EndPresenceResult {
  ok: boolean;
  code?: string;
  error?: string;
  /** 本次写入的共域记忆条数（每群每人最多 1 条） */
  memoriesWritten: number;
}

function asId(v: unknown): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function truncate(s: string, n: number): string {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/* ------------------------------------------------------------------ */
/* detectCohabitants                                                   */
/* ------------------------------------------------------------------ */
/**
 * 找出「此刻与 host 在同一空间的人」。
 * 纯 SQL 读取（无写入、无 LLM），可每轮私聊调用而不构成性能问题。
 */
export function detectCohabitants(hostId: number): Cohabitant[] {
  const hid = asId(hostId);
  const host = hid ? getCompanion(hid) : null;
  if (!host || host.status === 'closed') return [];

  const out: Cohabitant[] = [];

  // ① 其他伴侣：status='girlfriend'（天然排除 closed）且地点字段与 host 相同
  const hostLocation = withCompanion(hid, () => getLocation().current_location);
  const others = dbAll<CompanionRow>(
    "SELECT * FROM companions WHERE status = 'girlfriend' AND id != ? ORDER BY id ASC",
    hid
  );
  for (const row of others) {
    const oid = asId(row.id);
    if (!oid || oid === hid) continue;
    let loc: string;
    try {
      loc = withCompanion(oid, () => getLocation().current_location);
    } catch {
      continue; // 位置面板缺失 → 视为不在场（不阻塞其他在场者）
    }
    if (loc !== hostLocation) continue;
    out.push({
      kind: 'companion',
      id: oid,
      name: displayNameOf(oid, row.name),
      role: '伴侣',
    });
  }

  // ② 她身边的人（cast）：室友/家人天然「在家即在」——简化假设，全部视为在场（见文件头注释）
  const cast = withCompanion(hid, () => getCast());
  for (const m of cast) {
    if (!m.name) continue;
    if (m.name === host.name) continue; // 排除 host 自己（cast 里同名同人的极端情况）
    out.push({ kind: 'cast', name: m.name, role: m.role || '朋友', note: m.note || undefined });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* ensurePresenceGroup                                                 */
/* ------------------------------------------------------------------ */
/** cast 名 → 已存在的非 closed 伴侣行（去空格 + 忽略大小写的归一化匹配） */
function companionByName(name: string): CompanionRow | null {
  const row = dbGet<CompanionRow>(
    "SELECT * FROM companions WHERE lower(replace(name, ' ', '')) = lower(replace(?, ' ', '')) AND status != 'closed' ORDER BY id ASC LIMIT 1",
    String(name ?? '').trim()
  );
  return row ?? null;
}

/** 开局上下文：host 最近 3 条私聊（user/assistant，各截 80 字）→ 一条 system 群消息。
 *  「她瞄到了你们在聊什么」——共处群的成员就在旁边，开局让她知道此前的私聊氛围。
 *  没有任何私聊历史时不写（空上下文没有意义）。 */
function insertOpeningContext(gid: number, hostId: number, hostName: string, now: string): void {
  const recent = withCompanion(hostId, () =>
    cAll<{ role: string; content: string }>(
      "SELECT role, content FROM messages WHERE companion_id = ? AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 3"
    )
  );
  if (!recent.length) return;
  const lines = recent
    .reverse() // 回到时间正序
    .map((m) => (m.role === 'user' ? `他说：${truncate(m.content, 80)}` : `${hostName}：${truncate(m.content, 80)}`));
  const content = `（此前你们在旁边看到/听到了一些：\n${lines.join('\n')}）`;
  dbRun(
    `INSERT INTO group_messages (group_id, companion_id, speaker_type, speaker_name, content, reaction, round, created_at)
     VALUES (?, NULL, 'system', NULL, ?, NULL, 0, ?)`,
    gid,
    content,
    now
  );
  dbRun('UPDATE groups SET last_message_at = ?, updated_at = ? WHERE id = ?', now, now, gid);
}

/**
 * host 与某一在场者开启/复用共处群（origin='presence', host_companion_id=hostId）。
 * - 已有 active 的共处群 → 直接复用（并把成员补进群，保证「成员 = host + member」不变量）；
 * - 否则新建群，并写入开局上下文（host 最近私聊摘要的 system 消息）；
 * - member 是 cast 且尚未升格：见面即认识 → generateCandidateFromCast 生成伴侣行后
 *   直接置 status='acquaintance'、is_discovered=1、pending=0（跳过候选待处理）+ initPanels；
 * - member 是 cast 但已有同名伴侣行 → 直接复用该行（不再重复生成）。
 */
export async function ensurePresenceGroup(hostId: number, member: PresenceMemberInput): Promise<EnsurePresenceResult> {
  const hid = asId(hostId);
  const host = hid ? getCompanion(hid) : null;
  if (!host) return { ok: false, code: 'COMPANION_NOT_FOUND', error: '主伴侣不存在' };
  if (host.status === 'closed') return { ok: false, code: 'COMPANION_CLOSED', error: '该伴侣已关闭' };
  if (!member || (member.kind !== 'companion' && member.kind !== 'cast')) {
    return { ok: false, code: 'INVALID_INPUT', error: '成员类型不合法' };
  }

  const hostName = displayNameOf(hid, host.name);

  // —— 解析成员（在锁外做可能的 LLM 生成；写库统一在锁内） ——
  let memberId = 0;
  let memberName = '';
  if (member.kind === 'companion') {
    memberId = asId(member.id);
    const row = memberId ? getCompanion(memberId) : null;
    if (!row) return { ok: false, code: 'COMPANION_NOT_FOUND', error: '成员不存在' };
    if (memberId === hid) return { ok: false, code: 'INVALID_INPUT', error: '不能和自己共处' };
    const v = validateMemberStatuses([memberId]);
    if (!v.ok) return { ok: false, code: v.code, error: v.error };
    memberName = displayNameOf(memberId, row.name);
  } else {
    const castName = String(member.name ?? '').trim().slice(0, 24);
    if (!castName) return { ok: false, code: 'INVALID_INPUT', error: '成员名字不能为空' };
    // cast 名单里补齐 role/note（API 只传 name 时仍能生成完整角色卡）
    const known = withCompanion(hid, () => getCast()).find((c) => c.name === castName);
    const role = String(member.role ?? known?.role ?? '朋友').trim().slice(0, 20);
    const note = String(member.note ?? known?.note ?? '').trim().slice(0, 120);

    const existing = companionByName(castName);
    if (existing) {
      // 已升格过：复用该伴侣行（避免 dedupe 冲突 / 重复角色）
      memberId = asId(existing.id);
      const v = validateMemberStatuses([memberId]);
      if (!v.ok) return { ok: false, code: v.code, error: v.error };
      memberName = displayNameOf(memberId, existing.name);
    } else {
      // 见面即认识：生成伴侣行（LLM 润色 / 模板兜底），跳过候选待处理直接置 acquaintance
      const gen = await generateCandidateFromCast(
        hid,
        { name: castName, role, note },
        { kind: 'cast', ownerName: hostName }
      );
      if (!gen.ok) {
        return { ok: false, code: gen.code, error: gen.error };
      }
      memberId = asId(gen.row.id);
      dbRun(
        "UPDATE companions SET status = 'acquaintance', is_discovered = 1, pending = 0, updated_at = ? WHERE id = ?",
        nowIso(),
        memberId
      );
      initPanels(memberId); // 幂等补状态行（relationship/persona/生活面板），让她立刻可聊天
      logCompanionEvent(memberId, 'meet', `线下见面，当场认识了${castName}（${role}）`, {
        reason: 'presence_cohabitation',
        meta: { host: hid },
      });
      memberName = castName;
    }
  }

  // —— 查重 + 建/复用群（写操作统一在群锁内串行） ——
  return withGroupLock(hid, async (): Promise<EnsurePresenceResult> => {
    const now = nowIso();
    const existingGroup = dbGet<GroupRow>(
      "SELECT * FROM groups WHERE origin = 'presence' AND host_companion_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
      hid
    );

    if (existingGroup) {
      const gid = asId(existingGroup.id);
      // 补齐成员（复用时 member 可能与首次不同，保证「成员 = host + member」不变量）
      dbRun('INSERT OR IGNORE INTO group_members (group_id, companion_id, joined_at) VALUES (?, ?, ?)', gid, hid, now);
      dbRun('INSERT OR IGNORE INTO group_members (group_id, companion_id, joined_at) VALUES (?, ?, ?)', gid, memberId, now);
      dbRun('UPDATE groups SET updated_at = ? WHERE id = ?', now, gid);
      return { ok: true, groupId: gid, created: false, memberId };
    }

    const res = dbRun(
      `INSERT INTO groups (user_id, name, topic, status, origin, host_companion_id, created_at, updated_at)
       VALUES (?, ?, '线下共处', 'active', 'presence', ?, ?, ?)`,
      DEFAULT_USER_ID,
      truncate(`和${hostName}、${memberName}的线下时光`, 30),
      hid,
      now,
      now
    );
    const gid = asId(res.lastInsertRowid);
    dbRun('INSERT OR IGNORE INTO group_members (group_id, companion_id, joined_at) VALUES (?, ?, ?)', gid, hid, now);
    dbRun('INSERT OR IGNORE INTO group_members (group_id, companion_id, joined_at) VALUES (?, ?, ?)', gid, memberId, now);
    insertOpeningContext(gid, hid, hostName, now);
    return { ok: true, groupId: gid, created: true, memberId };
  });
}

/* ------------------------------------------------------------------ */
/* endPresenceGroup                                                    */
/* ------------------------------------------------------------------ */
/**
 * 结束共处群（status='ended'）并写入共域记忆（每群每人一条，幂等——重复调用 memoriesWritten=0）。
 * 结束后该群不再被 ensurePresenceGroup 复用；下次共处会开启新群、累积新的共域记忆。
 */
export async function endPresenceGroup(groupId: number): Promise<EndPresenceResult> {
  const gid = asId(groupId);
  const group = gid ? dbGet<GroupRow>('SELECT * FROM groups WHERE id = ?', gid) : null;
  if (!group) return { ok: false, code: 'GROUP_NOT_FOUND', error: '群不存在', memoriesWritten: 0 };
  return withGroupLock(gid, async (): Promise<EndPresenceResult> => {
    const now = nowIso();
    dbRun("UPDATE groups SET status = 'ended', updated_at = ? WHERE id = ?", now, gid);
    const memoriesWritten = writeSharedMemories(gid);
    return { ok: true, memoriesWritten };
  });
}

/* ------------------------------------------------------------------ */
/* 便捷读取（API/UI 用）                                               */
/* ------------------------------------------------------------------ */
/** host 当前 active 的共处群 id（无则 null） */
export function activePresenceGroupId(hostId: number): number | null {
  const row = dbGet<{ id: number }>(
    "SELECT id FROM groups WHERE origin = 'presence' AND host_companion_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
    asId(hostId)
  );
  return row ? asId(row.id) : null;
}
