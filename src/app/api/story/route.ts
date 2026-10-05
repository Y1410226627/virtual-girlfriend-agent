// 纪念册：把你们之间的大事件聚合成时间轴 + 她的日记（只读）
import { dbAll, DEFAULT_USER_ID } from '@/lib/db';
import { errMsg } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** agent_diaries 只读列（该表可能尚未迁移，查询需容错） */
interface AgentDiaryRow {
  date: string;
  content: string;
}

export async function GET() {
  try {
    // 里程碑：阶段跃迁 / 回退 / 重要时刻 / 冲突 / 修复（kind 取值以 lib 里的实际写入为准）
    const milestones = dbAll(
      `SELECT kind, summary, created_at, stage_at_time
       FROM relationship_logs
       WHERE user_id = ? AND kind IN ('stage_up','stage_down','milestone','conflict','repair')
       ORDER BY created_at DESC
       LIMIT 200`,
      DEFAULT_USER_ID
    );

    // 情感银行里的大额流水：|delta| >= 15，最近 50 条
    const bigBank = dbAll(
      `SELECT delta, kind, behavior, reason, created_at
       FROM emotional_bank
       WHERE user_id = ? AND ABS(delta) >= 15
       ORDER BY created_at DESC
       LIMIT 50`,
      DEFAULT_USER_ID
    );

    // 纪念日 / 约定
    const events = dbAll(
      `SELECT title, event_date, repeat_yearly, kind
       FROM events
       WHERE user_id = ?
       ORDER BY event_date ASC`,
      DEFAULT_USER_ID
    );

    // 最近的日常摘要
    const summaries = dbAll(
      `SELECT date, summary
       FROM daily_summaries
       WHERE user_id = ?
       ORDER BY date DESC
       LIMIT 30`,
      DEFAULT_USER_ID
    );

    // 她的日记：agent_diaries 表由另一批次负责迁移，此刻可能还不存在——必须容错，绝不能 500
    let diaries: AgentDiaryRow[] = [];
    try {
      diaries = dbAll<AgentDiaryRow>(
        `SELECT date, content
         FROM agent_diaries
         WHERE user_id = ?
         ORDER BY date DESC
         LIMIT 30`,
        DEFAULT_USER_ID
      );
    } catch {
      diaries = [];
    }

    return Response.json({ milestones, bigBank, events, summaries, diaries });
  } catch (e) {
    return Response.json({ error: errMsg(e) }, { status: 500 });
  }
}