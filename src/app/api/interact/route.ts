// 触摸互动接口：照片 / 头像上的"摸头 / 戳脸 / 牵手 / 抱抱"
// 只回文案 + 轻效果，不往聊天流里插消息（聊天记录不被污染）
import { getCounter, setCounter } from '@/lib/db';
import { getRelationshipState } from '@/lib/relationship';
import { getPsychology, applyPokeEffect } from '@/lib/life';
import { attachmentStyle } from '@/lib/attachment';
import {
  isInteractionKind,
  pickInteractionReply,
  cooldownRemainingMs,
  PER_KIND_COOLDOWN_MS,
} from '@/lib/interactions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LAST_ALL_KEY = 'interact_last_all';
const lastKindKey = (kind: string) => `interact_last_${kind}`;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const kind = String((body as { kind?: unknown })?.kind || '');
  if (!isInteractionKind(kind)) {
    return Response.json({ ok: false, error: '不认识的互动方式' }, { status: 400 });
  }

  // 冷却：同一个动作 90s、全部互动 20s（取较长者）
  const now = Date.now();
  const remain = cooldownRemainingMs(now, getCounter(LAST_ALL_KEY), getCounter(lastKindKey(kind)));
  if (remain > 0) {
    return Response.json({ ok: false, error: '还在冷却中', cooldownMs: remain }, { status: 429 });
  }

  const rel = getRelationshipState();
  const psy = getPsychology();
  const reply = pickInteractionReply(kind, {
    stage: rel.stage,
    mood: rel.mood,
    scene: rel.scene || 'online',
    attachmentStyle: attachmentStyle(),
    psychology: {
      loneliness: psy.loneliness,
      security: psy.security,
      missingUser: psy.missing_user,
      stress: psy.stress,
    },
    lastInteractionAt: rel.last_interaction_at ? new Date(rel.last_interaction_at).getTime() : null,
    nowMs: now,
  });

  const effect = applyPokeEffect(kind);
  setCounter(LAST_ALL_KEY, now);
  setCounter(lastKindKey(kind), now);

  return Response.json({
    ok: true,
    text: reply.text,
    effectNote: reply.effectNote,
    applied: effect.applied,
    cooldownMs: PER_KIND_COOLDOWN_MS,
  });
}