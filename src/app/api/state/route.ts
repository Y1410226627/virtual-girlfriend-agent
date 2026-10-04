// 全量状态快照（供各页面读取）
import { getAllSettings, getCounter, dbAll, DEFAULT_USER_ID, numSetting, maskSettingsForClient } from '@/lib/db';
import { getRelationshipState, getPersona } from '@/lib/relationship';
import { stageOf, stageListForUi } from '@/lib/stages';
import { personalityMap, signalProgress } from '@/lib/personality';
import { getAttachmentState } from '@/lib/attachment';
import { listBankEntries, bankStats } from '@/lib/emotionalBank';
import { listConflicts, openConflictCount } from '@/lib/conflict';
import { memoryStats } from '@/lib/memory';
import { messageCount } from '@/lib/engine';
import { proactiveStatus } from '@/lib/proactive';
import { embeddingMode } from '@/lib/llm';
import { ATTACHMENT_STYLES, attachmentStyleOf } from '@/lib/types';
import { round1, daysSince, hoursSince } from '@/lib/utils';
import { ensureScheduler } from '@/lib/scheduler';
import { STICKERS } from '@/lib/stickers';
import { ensureLife, getActivity, getHealth, getLocation, getPsychology, getActiveEvent } from '@/lib/life';
import { getIntimacy, getLevel, inAftercare } from '@/lib/intimacy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  ensureScheduler();
  const rel = getRelationshipState();
  const att = getAttachmentState();
  const stage = stageOf(rel.stage);
  const persona = getPersona();
  const settings = getAllSettings();

  return Response.json({
    persona,
    user: { name: settings.user_name || '', profile: settings.user_profile || '' },
    relationship: {
      ...rel,
      intimacy: round1(rel.intimacy),
      trust: round1(rel.trust),
      emotional_balance: round1(rel.emotional_balance),
      unresolved_tension: round1(rel.unresolved_tension),
      repair_credit: round1(rel.repair_credit),
      stageName: stage.name,
      stageEn: stage.en,
      stageCore: stage.core,
      stageMin: stage.min,
      stageMax: stage.max,
      daysInStage: Math.round(daysSince(rel.stage_entered_at) * 10) / 10,
      hoursSinceInteraction: Math.round(hoursSince(rel.last_interaction_at) * 10) / 10,
      openConflicts: openConflictCount(),
      scene: rel.scene || 'online',
      sceneMode: settings.scene_mode || 'auto',
      sceneReason: rel.scene_reason || '',
    },
    personality: { values: personalityMap(), signals: signalProgress() },
    attachment: {
      ...att,
      anxiety: round1(att.anxiety),
      avoidance: round1(att.avoidance),
      styleLabel: ATTACHMENT_STYLES[attachmentStyleOf(Number(att.anxiety), Number(att.avoidance))] || att.style,
    },
    bank: {
      balance: round1(rel.emotional_balance),
      repairCredit: round1(rel.repair_credit),
      tension: round1(rel.unresolved_tension),
      stats: bankStats(),
      recent: listBankEntries(20),
    },
    conflicts: listConflicts(10),
    memory: memoryStats(),
    counters: { turns: getCounter('turn_count'), messages: messageCount() },
    proactive: proactiveStatus(),
    stages: stageListForUi(),
    events: dbAll('SELECT * FROM events WHERE user_id = ? ORDER BY event_date ASC', DEFAULT_USER_ID),
    settings: maskSettingsForClient(settings),
    embeddingMode: embeddingMode(),
    stickers: STICKERS,
    life: (() => {
      try {
        ensureLife();
        const h = getHealth();
        const p = getPsychology();
        const l = getLocation();
        const a = getActivity();
        const evt = getActiveEvent();
        return {
          activity: a.current_activity,
          activityType: a.activity_type,
          location: l.current_location,
          energy: round1(h.energy),
          hunger: round1(h.hunger),
          emotion: p.base_emotion,
          illness: h.illness,
          atHome: l.location_type === 'home',
          ongoingEvent: evt
            ? { id: evt.id, activity: evt.activity, eventType: evt.event_type, startedAt: evt.started_at, expectedEnd: evt.expected_end_at, mode: evt.duration_mode }
            : null,
        };
      } catch {
        return null;
      }
    })(),
    intimacy: (() => {
      try {
        const s = getIntimacy();
        const lv = getLevel();
        return {
          libido: round1(s.libido),
          need: round1(s.intimacy_need),
          satisfaction: round1(s.sexual_satisfaction),
          stress: round1(s.sexual_stress),
          level: lv.effective,
          levelSet: lv.level,
          inAftercare: inAftercare(),
        };
      } catch {
        return null;
      }
    })(),
  });
}