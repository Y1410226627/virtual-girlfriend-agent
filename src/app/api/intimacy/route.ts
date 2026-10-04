// 亲密系统：状态 / 内容分级 / 偏好 / 事后关怀
import { dbRun, DEFAULT_USER_ID } from '@/lib/db';
import { nowIso, round1 } from '@/lib/utils';
import {
  getIntimacy,
  getLevel,
  setLevel,
  listAftercare,
  inAftercare,
} from '@/lib/intimacy';
import { ensureLife, listPreferences, revealPreferences } from '@/lib/life';
import { ensureScheduler } from '@/lib/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  ensureScheduler();
  ensureLife();
  const s = getIntimacy();
  const lv = getLevel();
  return Response.json({
    state: {
      libido: round1(s.libido),
      intimacyNeed: round1(s.intimacy_need),
      sexualSatisfaction: round1(s.sexual_satisfaction),
      sexualStress: round1(s.sexual_stress),
      lastIntimacyAt: s.last_intimacy_at,
      aftercareState: s.aftercare_state,
      aftercareUntil: s.aftercare_until,
      inAftercare: inAftercare(),
    },
    level: lv,
    preferences: listPreferences(true).map((p: any) => ({
      id: p.id,
      type: p.preference_type,
      content: p.content,
      revealed: p.reveal_status === 'revealed',
    })),
    aftercare: listAftercare(20),
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || '');
  ensureLife();

  if (action === 'set_level') {
    setLevel(Number(body.level));
    return Response.json({ ok: true, level: getLevel() });
  }

  if (action === 'reveal_preference') {
    revealPreferences([String(body.type || '')]);
    return Response.json({ ok: true, preferences: listPreferences(true) });
  }

  if (action === 'add_preference') {
    const type = String(body.type || 'custom').slice(0, 24);
    const content = String(body.content || '').trim();
    if (!content) return Response.json({ error: '内容不能为空' }, { status: 400 });
    dbRun(
      'INSERT INTO intimacy_preferences (user_id, preference_type, content, reveal_status, created_at) VALUES (?, ?, ?, ?, ?)',
      DEFAULT_USER_ID, type, content.slice(0, 120), body.revealed ? 'revealed' : 'hidden', nowIso()
    );
    return Response.json({ ok: true, preferences: listPreferences(true) });
  }

  if (action === 'delete_preference') {
    dbRun('DELETE FROM intimacy_preferences WHERE id = ? AND user_id = ?', Number(body.id), DEFAULT_USER_ID);
    return Response.json({ ok: true, preferences: listPreferences(true) });
  }

  if (action === 'log_aftercare_response') {
    dbRun(
      'UPDATE intimacy_aftercare SET user_response = ? WHERE id = ? AND user_id = ?',
      String(body.response || '').slice(0, 120), Number(body.id), DEFAULT_USER_ID
    );
    return Response.json({ ok: true });
  }

  return Response.json({ error: '未知操作' }, { status: 400 });
}