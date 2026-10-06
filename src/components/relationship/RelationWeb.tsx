'use client';

import { useApi, Card, Bar, Chip, Loading, ErrorBox } from '@/components/ui';
import { relationStateLabel, type RelationEdge } from '@/components/companions/shared';

interface RelationsData {
  relations: RelationEdge[];
}

const STATE_TONE: Record<string, string> = {
  ally: 'rose',
  friendly: 'rose',
  neutral: 'plain',
  rival: 'plain',
  jealous: 'plain',
};

/** 伴侣关系网：谁与谁友好 / 吃醋（-100..100），自取 /api/relations */
export function RelationWeb() {
  const { data, loading, error, reload } = useApi<RelationsData>('/api/relations');
  const relations = data?.relations ?? [];

  if (loading && !data) return <Loading text="正在读伴侣关系网…" />;
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />;

  return (
    <Card title="伴侣关系网">
      <div className="dim mb-3">
        她和她之间，也会互相打量：关系值偏正（≥40）时彼此友好、会为你高兴；偏负（≤-40）时会吃醋、暗中较劲。
      </div>
      {error ? <ErrorBox message={error} onRetry={reload} /> : null}

      {relations.length ? (
        <ul className="space-y-2.5">
          {relations.map((r) => (
            <li key={r.id} className="rounded-2xl surf border line px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium ink-1">
                  {r.a_name ?? `#${r.a_id}`} <span className="ink-3">↔</span> {r.b_name ?? `#${r.b_id}`}
                </span>
                <Chip tone={STATE_TONE[r.state] ?? 'plain'}>{relationStateLabel(r.state)}</Chip>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <div className="flex-1">
                  {/* 关系值 -100..100 映射到 0..100 显示 */}
                  <Bar value={r.value} min={-100} max={100} tone={r.value >= 0 ? 'rose' : 'gray'} height={8} />
                </div>
                <span className={`w-12 text-right text-xs ${r.value >= 0 ? 'acc' : 'ink-2'}`}>{Math.round(r.value)}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="dim">还没有伴侣之间的互动记录。群聊和活动会让她们彼此熟悉或较劲。</div>
      )}
    </Card>
  );
}
