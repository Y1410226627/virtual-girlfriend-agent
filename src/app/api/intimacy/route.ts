// 亲密系统：状态 / 内容分级 / 偏好 / 事后关怀
import { tx } from '@/lib/db';
import { round1, errMsg } from '@/lib/utils';
import {
  getIntimacy,
  getLevel,
  setLevel,
  listAftercare,
  inAftercare,
  addPreference,
  deletePreference,
  logAftercareResponse,
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
    preferences: listPreferences(true).map((p) => ({
      id: p.id,
      type: p.preference_type,
      content: p.content,
      revealed: p.reveal_status === 'revealed',
    })),
    aftercare: listAftercare(20),
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '');
    ensureLife();

    if (action === 'set_level') {
      const level = Number(body.level);
      if (!Number.isInteger(level) || level < 0 || level > 3) return Response.json({ error: '参数错误' }, { status: 400 });
      // 写表 + setSetting + log 用同一事务包住，避免半写入
      tx(() => setLevel(level));
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
      addPreference({ type, content, revealed: !!body.revealed });
      return Response.json({ ok: true, preferences: listPreferences(true) });
    }

    if (action === 'delete_preference') {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) return Response.json({ error: '参数错误' }, { status: 400 });
      return Response.json({ ok: deletePreference(id), preferences: listPreferences(true) });
    }

    if (action === 'log_aftercare_response') {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) return Response.json({ error: '参数错误' }, { status: 400 });
      return Response.json({ ok: logAftercareResponse(id, String(body.response || '')) });
    }

    return Response.json({ error: '未知操作' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: errMsg(e) }, { status: 500 });
  }
}