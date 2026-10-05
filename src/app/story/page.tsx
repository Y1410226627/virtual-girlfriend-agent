'use client';

import { useMemo, useState } from 'react';
import { useApi, PageHeader, Card, Loading, ErrorBox, fmtTime, Chip } from '@/components/ui';

interface Milestone {
  kind: string;
  summary: string;
  created_at: string;
}

interface BigBank {
  delta: number;
  behavior: string | null;
  reason: string | null;
  created_at: string;
}

interface StoryEvent {
  title: string;
  event_date: string;
  repeat_yearly: boolean | number;
}

interface DailySummary {
  date: string;
  summary: string;
}

interface Diary {
  date: string;
  content: string;
}

interface StoryResponse {
  milestones: Milestone[];
  bigBank: BigBank[];
  events: StoryEvent[];
  summaries: DailySummary[];
  diaries: Diary[];
}

/** 时间轴上每个节点按 kind 给不同的小图标与颜色 */
function kindStyle(kind: string, delta = 0) {
  switch (kind) {
    case 'stage_up':
      return { icon: '💗', ring: 'bg-rose-400' };
    case 'stage_down':
      return { icon: '💔', ring: 'bg-ink-300' };
    case 'milestone':
      return { icon: '🎉', ring: 'bg-peach-400' };
    case 'conflict':
      return { icon: '⚡', ring: 'bg-sky-400' };
    case 'repair':
      return { icon: '🤝', ring: 'bg-rose-300' };
    case 'bank':
      // 情感银行：存入（正）偏暖，支出（负）偏冷
      return { icon: '💰', ring: delta >= 0 ? 'bg-rose-400' : 'bg-sky-400' };
    default:
      return { icon: '🌸', ring: 'bg-rose-300' };
  }
}

/** 她的日记列表：长文本可折叠 / 展开 */
function DiaryList({ diaries }: { diaries: Diary[] }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});

  if (diaries.length === 0) {
    return <p className="dim">她还不好意思把日记给你看。过些天再来吧。</p>;
  }

  return (
    <div className="space-y-3">
      {diaries.map((d, i) => {
        const text = String(d.content || '');
        const isOpen = !!open[i];
        const long = text.length > 140;
        return (
          <div key={`${d.date}-${i}`} className="rounded-2xl accent-soft px-4 py-3">
            <Chip tone="plain">{d.date}</Chip>
            <p className={`mt-2 whitespace-pre-wrap text-sm leading-relaxed ink-2 ${long && !isOpen ? 'line-clamp-4' : ''}`}>
              {text}
            </p>
            {long ? (
              <button
                className="btn-ghost mt-2 !px-2.5 !py-1 text-xs"
                onClick={() => setOpen((s) => ({ ...s, [i]: !isOpen }))}
              >
                {isOpen ? '收起' : '展开'}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default function StoryPage() {
  const { data, loading, error, reload } = useApi<StoryResponse>('/api/story');

  // 里程碑 + 大额情感流水，按时间倒序合并成一条时间轴
  const timeline = useMemo(() => {
    const a = (data?.milestones || []).map((m) => ({
      key: `m-${m.created_at}-${m.summary}`,
      kind: String(m.kind || ''),
      delta: 0,
      at: m.created_at,
      summary: String(m.summary || ''),
    }));
    const b = (data?.bigBank || []).map((e) => {
      const delta = Number(e.delta) || 0;
      return {
        key: `b-${e.created_at}-${delta}`,
        kind: 'bank',
        delta,
        at: e.created_at,
        summary: String(e.behavior || e.reason || `情感余额 ${delta > 0 ? '+' : ''}${delta}`),
      };
    });
    return [...a, ...b].sort(
      (x, y) => new Date(y.at).getTime() - new Date(x.at).getTime()
    );
  }, [data]);

  if (loading && !data) return <Loading text="正在翻开你们的纪念册…" />;
  // 仅初次加载就失败才整页替换；已有数据时用顶部横幅提示，保留已加载内容可继续查看
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />;

  const events = data?.events || [];
  const summaries = data?.summaries || [];
  const diaries = data?.diaries || [];

  return (
    <div className="pb-10">
      {error ? <ErrorBox message={error} onRetry={reload} /> : null}
      <PageHeader title="纪念册" desc="你们之间发生过的重要时刻。" />

      <div className="grid gap-4 px-5 pt-2 md:grid-cols-2 md:px-8">
        {/* 时间轴 */}
        <Card title="时间轴" className="md:col-span-2">
          {timeline.length === 0 ? (
            <p className="dim">时间轴还空着——从今天开始，慢慢会有故事的。</p>
          ) : (
            <div className="max-h-[460px] overflow-y-auto pr-1">
              <div className="relative">
                {/* 左侧淡粉竖线 */}
                <span className="pointer-events-none absolute left-[11px] top-2 bottom-2 w-px accent-soft" aria-hidden />
                <div className="space-y-4">
                  {timeline.map((it) => {
                    const st = kindStyle(it.kind, it.delta);
                    return (
                      <div key={it.key} className="relative flex gap-3">
                        <span
                          className={`relative z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${st.ring} text-xs leading-none text-white shadow-bubble`}
                          aria-hidden
                        >
                          {st.icon}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[11px] ink-3">{fmtTime(it.at)}</div>
                          <div className="mt-0.5 break-words text-sm leading-relaxed ink-2">{it.summary}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </Card>

        {/* 纪念日 */}
        <Card title="纪念日">
          {events.length === 0 ? (
            <p className="dim">还没有记下的日子。去「关系」页添加属于你们的纪念日吧。</p>
          ) : (
            <div className="space-y-2">
              {events.map((e, i) => (
                <div
                  key={`${e.event_date}-${e.title}-${i}`}
                  className="flex items-center justify-between gap-3 rounded-2xl border line surf px-3.5 py-2.5"
                >
                  <div className="min-w-0 truncate text-xs font-medium ink-1">{e.title}</div>
                  <div className="shrink-0 text-[11px] ink-3">
                    {e.event_date}
                    {e.repeat_yearly ? ' · 每年' : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* 最近的日常 */}
        <Card title="最近的日常">
          {summaries.length === 0 ? (
            <p className="dim">还没有摘要。等你们聊过一整天，第二天就会自动生成。</p>
          ) : (
            <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
              {summaries.map((s, i) => (
                <div key={`${s.date}-${i}`} className="rounded-2xl accent-soft px-3.5 py-2.5">
                  <Chip tone="plain">{s.date}</Chip>
                  <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed ink-2">{s.summary}</p>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* 她的日记 */}
        <Card title="她的日记" className="md:col-span-2">
          <DiaryList diaries={diaries} />
        </Card>
      </div>
    </div>
  );
}