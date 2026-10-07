'use client';

import { colorOf, type GroupMemberLite } from './shared';
import { statusLabelOf, STATUS_TONE } from '@/components/companions/shared';
import { Chip } from '@/components/ui';

/**
 * 成员多选：从「认识及以上」的角色中选 2–6 名入群。
 * 已选中的卡片高亮显示专属色；达到上限后其余不可选。
 */
export function GroupMemberPicker({
  members,
  selected,
  max,
  onToggle,
}: {
  members: GroupMemberLite[];
  selected: number[];
  max: number;
  onToggle: (id: number) => void;
}) {
  const selectedSet = new Set(selected);
  const full = selected.length >= max;

  if (!members.length) {
    return <div className="dim">还没有可入群的角色。先去通讯录认识一些人吧。</div>;
  }

  return (
    <div className="grid gap-2.5 md:grid-cols-2">
      {members.map((m) => {
        const on = selectedSet.has(m.id);
        const disabled = !on && full;
        return (
          <button
            key={m.id}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onToggle(m.id)}
            className={`card-tight flex items-center gap-3 text-left transition ${
              on ? 'ring-2' : ''
            } ${disabled ? 'opacity-40' : 'hover:shadow-soft'}`}
            style={on ? { boxShadow: `0 0 0 2px ${colorOf(m.id)}33`, borderColor: colorOf(m.id) } : undefined}
          >
            <span
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-lg text-white"
              style={{ backgroundColor: colorOf(m.id) }}
              aria-hidden
            >
              {(m.name || '她').slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-medium ink-1">{m.name}</span>
                {m.status ? (
                  <Chip tone={STATUS_TONE[m.status] ?? 'plain'}>{statusLabelOf(m.status)}</Chip>
                ) : null}
                {on ? <span className="chip">已选</span> : null}
              </span>
              <span className="dim mt-0.5 block truncate">
                {m.age > 0 ? `${m.age} 岁` : ''}
                {m.identity ? ` · ${m.identity}` : ''}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
