// 关系页：状态 / 阶段 / 昵称 / 纪念日 / 事件 / 关系日志 / 冲突
import { dbAll, dbGet, dbRun, DEFAULT_USER_ID, getSetting, setSetting } from '@/lib/db';
import { detectScene } from '@/lib/scene';
import { getRelationshipState, saveRelationshipState, logRelationship, getPersona, setPersonaField, setUserName, checkStageTransition } from '@/lib/relationship';
import { listConflicts } from '@/lib/conflict';
import { stageOf, stageListForUi } from '@/lib/stages';
import { listBankEntries, bankStats } from '@/lib/emotionalBank';
import { nowIso, round1, daysSince, localDateStr, cnDate } from '@/lib/utils';
import { listDailySummaries } from '@/lib/memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const rel = getRelationshipState();
  const stage = stageOf(rel.stage);
  return Response.json({
    relationship: {
      ...rel,
      stageName: stage.name,
      stageCore: stage.core,
      stageMin: stage.min,
      stageMax: stage.max,
      scene: rel.scene || 'online',
      sceneMode: getSetting('scene_mode') || 'auto',
      sceneReason: rel.scene_reason || '',
      intimacy: round1(rel.intimacy),
      trust: round1(rel.trust),
      emotional_balance: round1(rel.emotional_balance),
      unresolved_tension: round1(rel.unresolved_tension),
      repair_credit: round1(rel.repair_credit),
      daysInStage: Math.round(daysSince(rel.stage_entered_at) * 10) / 10,
      capSinceDays: rel.stage_cap_since ? Math.round(daysSince(rel.stage_cap_since) * 10) / 10 : null,
      dwellDays: Number(getSetting('stage_dwell_days') || 3),
    },
    stages: stageListForUi(),
    persona: getPersona(),
    user: { name: getSetting('user_name') || '', profile: getSetting('user_profile') || '' },
    logs: dbAll(
      'SELECT * FROM relationship_logs WHERE user_id = ? ORDER BY id DESC LIMIT 80',
      DEFAULT_USER_ID
    ),
    conflicts: listConflicts(20),
    bank: { stats: bankStats(), recent: listBankEntries(40) },
    events: dbAll('SELECT * FROM events WHERE user_id = ? ORDER BY event_date ASC', DEFAULT_USER_ID),
    memories: dbAll(
      "SELECT * FROM memories WHERE user_id = ? AND type IN ('relationship','attachment') AND status = 'active' ORDER BY id DESC LIMIT 40",
      DEFAULT_USER_ID
    ),
    summaries: listDailySummaries(20),
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || '');

  if (action === 'set_nickname') {
    const s = getRelationshipState();
    const old = s.nickname;
    s.nickname = String(body.nickname || '').trim() || null;
    saveRelationshipState(s);
    logRelationship('nickname', `昵称更新：${s.nickname || '（清空）'}`, old, s.nickname, '用户设置');
    return Response.json({ ok: true });
  }

  if (action === 'set_anniversary') {
    const s = getRelationshipState();
    const old = s.anniversary;
    s.anniversary = String(body.anniversary || '').trim() || null;
    saveRelationshipState(s);
    logRelationship('milestone', `重要日子：${s.anniversary || '（清空）'}`, old, s.anniversary, '用户设置');
    return Response.json({ ok: true });
  }

  if (action === 'set_persona' || action === 'set_user') {
    if (action === 'set_persona') {
      if (body.agent_name !== undefined) setPersonaField('agent_name', String(body.agent_name));
      if (body.age !== undefined) setPersonaField('age', String(body.age));
      if (body.occupation !== undefined) setPersonaField('occupation', String(body.occupation));
      if (body.self_story !== undefined) setPersonaField('self_story', String(body.self_story));
    } else {
      if (body.user_name !== undefined) setUserName(String(body.user_name));
      if (body.user_profile !== undefined) setSetting('user_profile', String(body.user_profile));
    }
    return Response.json({ ok: true });
  }

  if (action === 'request_stage_talk') {
    // 复用阶段跃迁前置（达顶 + 等待期满足）才会真正置位；不满足则不改库
    const before = getRelationshipState().pending_stage_confirm;
    const s = checkStageTransition(false, 'user_request');
    if (!s.pending_stage_confirm) {
      return Response.json({ ok: true, message: '还没到可以谈这个的阶段' });
    }
    if (!before) logRelationship('milestone', '用户希望推进关系确认对话', null, null, '用户在关系页触发');
    return Response.json({ ok: true, hint: '下次聊天时，她会找机会和你谈一谈你们的关系' });
  }

  if (action === 'request_relationship_talk') {
    const s = getRelationshipState();
    s.pending_relationship_talk = 1;
    saveRelationshipState(s);
    logRelationship('milestone', '用户希望她主动把话说开', null, null, '用户在关系页触发');
    return Response.json({ ok: true });
  }

  if (action === 'set_scene') {
    // 手动指定场景（auto=恢复智能识别）
    const mode = String(body.mode || 'auto');
    if (!['auto', 'online', 'offline'].includes(mode)) return Response.json({ error: '参数错误' }, { status: 400 });
    setSetting('scene_mode', mode);
    const s = getRelationshipState();
    if (mode !== 'auto') {
      s.scene = mode;
      s.scene_reason = '你手动指定了' + (mode === 'offline' ? '线下' : '线上');
      s.scene_updated_at = nowIso();
      saveRelationshipState(s);
    } else {
      // 切回自动：立刻用最后一条消息重新判断一次，避免标签停留在旧的手动值
      const last = dbGet<any>(
        "SELECT content FROM messages WHERE user_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1",
        DEFAULT_USER_ID
      );
      const d = detectScene(String(last?.content || ''), 'online');
      s.scene = d.confidence > 0 ? d.scene : 'online';
      s.scene_reason = d.reason || '已恢复智能识别（下一条消息会重新判断）';
      s.scene_updated_at = nowIso();
      saveRelationshipState(s);
    }
    logRelationship('milestone', `场景设为${mode === 'auto' ? '智能识别' : mode === 'offline' ? '线下相处' : '线上聊天'}`, null, mode, '用户手动设置');
    return Response.json({ ok: true, scene: s.scene, mode });
  }

  if (action === 'add_event') {
    const title = String(body.title || '').trim().slice(0, 60);
    const date = String(body.event_date || '').trim();
    if (!title || !date) return Response.json({ error: '标题和日期不能为空' }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: '日期格式应为 YYYY-MM-DD' }, { status: 400 });
    const KIND_WHITELIST = ['anniversary', 'birthday', 'plan'];
    const kind = KIND_WHITELIST.includes(String(body.kind)) ? String(body.kind) : 'custom';
    const description = body.description ? String(body.description).slice(0, 200) : null;
    dbRun(
      'INSERT INTO events (user_id, title, event_date, repeat_yearly, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      DEFAULT_USER_ID,
      title,
      date,
      body.repeat_yearly ? 1 : 0,
      kind,
      description,
      nowIso()
    );
    return Response.json({ ok: true });
  }

  if (action === 'delete_event') {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: '参数错误' }, { status: 400 });
    const r = dbRun('DELETE FROM events WHERE id = ? AND user_id = ?', id, DEFAULT_USER_ID);
    return Response.json({ ok: r.changes > 0 });
  }

  if (action === 'set_stage') {
    // 调试/体验用：手动设置阶段（会重置阶段计时）
    const stageNum = Number(body.stage);
    if (!Number.isFinite(stageNum)) return Response.json({ error: '参数错误' }, { status: 400 });
    const stage = Math.max(0, Math.min(4, stageNum));
    const s = getRelationshipState();
    const old = s.stage;
    s.stage = stage;
    s.stage_entered_at = nowIso();
    s.stage_cap_since = null;
    s.pending_stage_confirm = 0;
    s.intimacy = Math.max(stageOf(stage).min, Math.min(stageOf(stage).max, s.intimacy));
    saveRelationshipState(s);
    logRelationship('stage_up', `手动调整阶段：${stageOf(old).name} → ${stageOf(stage).name}`, old, stage, '用户手动设置');
    return Response.json({ ok: true });
  }

  return Response.json({ error: '未知操作' }, { status: 400 });
}