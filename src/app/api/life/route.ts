// 她的世界：健康 / 心理 / 位置 / 活动 / 日常事件 / 档案里逐步揭露的信息 / 共享世界
import { dbRun, dbAll, DEFAULT_USER_ID, getSetting, setSetting } from '@/lib/db';
import { nowIso, localDateStr, round1 } from '@/lib/utils';
import {
  ensureLife,
  advanceLife,
  saveWeeklyWorldSnapshot,
  getHealth,
  getPsychology,
  getLocation,
  getActivity,
  getProfileSeed,
  getSharedWorld,
  listLifeLogs,
  listDailyEvents,
  addSharedPlan,
  addSharedRitual,
  addSharedPlace,
  addSharedItem,
  completePlan,
  startIllness,
  revealProfileFields,
  isFieldRevealed,
  whatHappenedSince,
  labelOf,
  getActiveEvent,
  endOngoingEvent,
  setEventExpectedEnd,
} from '@/lib/life';
import { notifyEventEnd } from '@/lib/proactive';
import { ensureScheduler } from '@/lib/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROFILE_FIELDS = [
  'nickname', 'age', 'birthday', 'hometown', 'city', 'family',
  'education', 'job', 'hobbies', 'habits', 'catchphrases', 'fears', 'dreams', 'secrets',
];

export async function GET() {
  ensureScheduler();
  ensureLife();
  advanceLife();
  saveWeeklyWorldSnapshot();
  const h = getHealth();
  const p = getPsychology();
  const loc = getLocation();
  const act = getActivity();
  const seed = getProfileSeed();
  const today = localDateStr();

  const timeline = listLifeLogs(60, `${today}T00:00:00.000Z`)
    .concat(listLifeLogs(60, new Date(Date.now() - 12 * 3600000).toISOString()).filter((l) => l.field === 'daily_event'))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 40);

  const fields = PROFILE_FIELDS.map((f) => ({
    field: f,
    label: labelOf(f),
    value: seed[f] || '',
    revealed: isFieldRevealed(f),
  }));

  return Response.json({
    health: {
      energy: round1(h.energy),
      sleepQuality: round1(h.sleep_quality),
      hunger: round1(h.hunger),
      illness: h.illness,
      illnessDay:
        h.illness !== 'none' && h.illness_start
          ? Math.max(1, Math.round((Date.now() - new Date(h.illness_start).getTime()) / 86400000) + 1)
          : 0,
      cycleEnabled: h.cycle_enabled === 1,
      cycleDay: h.cycle_day,
      exercise: round1(h.exercise),
      updatedAt: h.updated_at,
    },
    psychology: {
      baseEmotion: p.base_emotion,
      stress: round1(p.stress),
      loneliness: round1(p.loneliness),
      missingUser: round1(p.missing_user),
      security: round1(p.security),
      selfWorth: round1(p.self_worth),
      mentalEnergy: round1(p.mental_energy),
      updatedAt: p.updated_at,
    },
    location: { name: loc.current_location, type: loc.location_type, arrivedAt: loc.arrived_at },
    activity: { name: act.current_activity, type: act.activity_type, expectedEnd: act.expected_end_at },
    ongoingEvent: (() => {
      const e = getActiveEvent();
      return e
        ? { id: e.id, activity: e.activity, eventType: e.event_type, startedAt: e.started_at, expectedEnd: e.expected_end_at, mode: e.duration_mode }
        : null;
    })(),
    recently: whatHappenedSince(12),
    timeline,
    events: listDailyEvents(30),
    profile: {
      fields,
      revealedCount: fields.filter((f) => f.revealed && f.value).length,
      filledCount: fields.filter((f) => f.value).length,
    },
    shared: getSharedWorld(),
    weeklySnapshots: dbAll<any>('SELECT week, state_json, created_at FROM world_weekly_snapshots WHERE user_id = ? ORDER BY week DESC LIMIT 8', DEFAULT_USER_ID),
    settings: {
      lifeEnabled: getSetting('life_enabled') === 'true',
      cycleEnabled: getSetting('cycle_enabled') === 'true',
    },
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || '');
  ensureLife();

  if (action === 'simulate_hours') {
    // 把时间往回拨 N 小时，再推进一次（方便你立刻看到她的生活变化）
    const hours = Math.min(72, Math.max(1, Number(body.hours) || 6));
    dbRun(
      'UPDATE agent_health SET updated_at = ? WHERE user_id = ?',
      new Date(Date.now() - hours * 3600000).toISOString(),
      DEFAULT_USER_ID
    );
    const r = advanceLife();
    return Response.json({ ok: true, hours, steps: r.steps, changes: r.changes.slice(-12) });
  }

  if (action === 'set_profile') {
    const updates: Array<[string, string]> = [];
    for (const f of PROFILE_FIELDS) {
      if (body[f] !== undefined) updates.push([f, String(body[f] || '')]);
    }
    for (const [k, v] of updates) dbRun(`UPDATE agent_profile SET ${k} = ?, updated_at = ? WHERE user_id = ?`, v, nowIso(), DEFAULT_USER_ID);
    return Response.json({ ok: true });
  }

  if (action === 'reveal_field') {
    revealProfileFields([String(body.field || '')]);
    return Response.json({ ok: true });
  }

  if (action === 'hide_field') {
    const seed = getProfileSeed();
    const reveal = { ...(seed.reveal || {}) };
    delete reveal[String(body.field || '')];
    dbRun('UPDATE agent_profile SET reveal_status = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(reveal), nowIso(), DEFAULT_USER_ID);
    return Response.json({ ok: true });
  }

  if (action === 'add_plan') {
    addSharedPlan(String(body.content || '').trim());
    return Response.json({ ok: true, shared: getSharedWorld() });
  }
  if (action === 'toggle_plan') {
    completePlan(Number(body.index));
    return Response.json({ ok: true, shared: getSharedWorld() });
  }
  if (action === 'add_ritual') {
    addSharedRitual(String(body.content || '').trim());
    return Response.json({ ok: true, shared: getSharedWorld() });
  }
  if (action === 'add_place') {
    addSharedPlace(String(body.content || '').trim());
    return Response.json({ ok: true, shared: getSharedWorld() });
  }
  if (action === 'add_item') {
    addSharedItem(String(body.content || '').trim());
    return Response.json({ ok: true, shared: getSharedWorld() });
  }

  if (action === 'set_illness') {
    const kind = String(body.kind || '感冒');
    if (kind === 'none') {
      dbRun('UPDATE agent_health SET illness = ?, illness_severity = 0, updated_at = ? WHERE user_id = ?', 'none', nowIso(), DEFAULT_USER_ID);
    } else {
      startIllness(kind, Number(body.days) || 2);
    }
    return Response.json({ ok: true });
  }

  if (action === 'set_cycle') {
    dbRun('UPDATE agent_health SET cycle_enabled = ?, cycle_day = ? WHERE user_id = ?', body.enabled ? 1 : 0, Number(body.day) || 1, DEFAULT_USER_ID);
    setSetting('cycle_enabled', body.enabled ? 'true' : 'false');
    return Response.json({ ok: true });
  }

  if (action === 'end_event') {
    // 控制当前事件什么时候结束：immediate=立即结束（她马上回一条） / smart=按最自然的时长 / manual=手动分钟数
    const mode = String(body.mode || 'immediate');
    const evt = getActiveEvent();
    if (!evt) return Response.json({ ok: false, error: '现在没有进行中的事件' });
    const shape = (e: any) =>
      e ? { id: e.id, activity: e.activity, eventType: e.event_type, startedAt: e.started_at, expectedEnd: e.expected_end_at, mode: e.duration_mode } : null;

    if (mode === 'immediate') {
      endOngoingEvent('immediate');
      const message = await notifyEventEnd(evt, true);
      return Response.json({ ok: true, ended: true, message, event: null });
    }
    if (mode === 'smart' || mode === 'manual') {
      const updated = setEventExpectedEnd(mode, Number(body.minutes) || 0);
      if (!updated) return Response.json({ ok: false, error: '事件已经结束了' });
      return Response.json({ ok: true, ended: false, event: shape(updated) });
    }
    return Response.json({ error: '未知的结束方式' }, { status: 400 });
  }

  return Response.json({ error: '未知操作' }, { status: 400 });
}