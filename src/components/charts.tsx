'use client';

// 纯 SVG 图表组件（雷达图 / 折线图 / 半圆仪表），无第三方依赖

export function RadarChart({
  data,
  size = 260,
  color = '#F65C8A',
}: {
  data: { label: string; value: number }[];
  size?: number;
  color?: string;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 42;
  // 空数据不渲染底圈，直接给空态
  if (!data.length) {
    return <div className="dim py-8 text-center">还没有足够的数据</div>;
  }
  const clamp = (v: number) => Math.max(0, Math.min(100, Number(v) || 0));
  const n = data.length;
  const angle = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pt = (i: number, ratio: number) => ({
    x: cx + Math.cos(angle(i)) * r * ratio,
    y: cy + Math.sin(angle(i)) * r * ratio,
  });

  const rings = [0.25, 0.5, 0.75, 1];
  const points = data.map((d, i) => pt(i, Math.max(0.02, clamp(d.value) / 100)));
  const poly = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="mx-auto">
      {rings.map((ring, ri) => (
        <polygon
          key={ri}
          points={data.map((_, i) => {
            const p = pt(i, ring);
            return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
          }).join(' ')}
          fill="none"
          style={{ stroke: 'var(--line)' }}
          strokeWidth={1}
          opacity={0.75}
        />
      ))}
      {data.map((_, i) => {
        const p = pt(i, 1);
        return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} style={{ stroke: 'var(--line)' }} strokeWidth={1} opacity={0.7} />;
      })}
      <polygon points={poly} fill={color} fillOpacity={0.22} stroke={color} strokeWidth={2} strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={3} fill={color} />
      ))}
      {data.map((d, i) => {
        const p = pt(i, 1.2);
        return (
          <g key={i}>
            <text
              x={p.x}
              y={p.y}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={10.5}
              style={{ fill: 'var(--ink-2)' }}
            >
              {d.label}
            </text>
            <text
              x={p.x}
              y={p.y + 12}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={10}
              fill={color}
              fontWeight={600}
            >
              {Math.round(clamp(d.value))}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export interface Series {
  name: string;
  color: string;
  points: { t: string; v: number }[];
}

export function LineChart({
  series,
  height = 200,
  min = 0,
  max = 100,
  yTicks = 3,
}: {
  series: Series[];
  height?: number;
  min?: number;
  max?: number;
  yTicks?: number;
}) {
  const width = 560;
  const padL = 30;
  const padR = 12;
  const padT = 12;
  const padB = 22;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const valid = (p: { t: string }) => Number.isFinite(new Date(p.t).getTime());

  const all = series.flatMap((s) => s.points).filter(valid);
  if (!all.length) {
    return <div className="dim py-8 text-center">还没有足够的数据，多聊几天就能看到曲线啦</div>;
  }
  const times = all.map((p) => new Date(p.t).getTime());
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const span = Math.max(1, t1 - t0);
  // max === min 时抬高上界，避免除零
  const yMax = max === min ? min + 1 : max;
  const ticks = Math.max(1, yTicks);

  const xOf = (t: string) => padL + ((new Date(t).getTime() - t0) / span) * innerW;
  const yOf = (v: number) => padT + innerH - ((Math.max(min, Math.min(yMax, v)) - min) / (yMax - min)) * innerH;

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      {Array.from({ length: ticks + 1 }).map((_, i) => {
        const v = min + ((yMax - min) * i) / ticks;
        const y = yOf(v);
        return (
          <g key={i}>
            <line x1={padL} y1={y} x2={width - padR} y2={y} style={{ stroke: 'var(--line)' }} strokeWidth={1} />
            <text x={padL - 6} y={y + 3} fontSize={9} textAnchor="end" style={{ fill: 'var(--ink-3)' }}>
              {Math.round(v)}
            </text>
          </g>
        );
      })}
      {series.map((s) => {
        const pts = s.points.filter(valid);
        if (!pts.length) return null;
        const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.t).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(' ');
        return (
          <g key={s.name}>
            <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {pts.length === 1 ? <circle cx={xOf(pts[0].t)} cy={yOf(pts[0].v)} r={3} fill={s.color} /> : null}
          </g>
        );
      })}
      <text x={padL} y={height - 6} fontSize={9} style={{ fill: 'var(--ink-3)' }}>
        {new Date(t0).toLocaleDateString('zh-CN')}
      </text>
      <text x={width - padR} y={height - 6} fontSize={9} style={{ fill: 'var(--ink-3)' }} textAnchor="end">
        {new Date(t1).toLocaleDateString('zh-CN')}
      </text>
    </svg>
  );
}

export function Gauge({
  value,
  label,
  color = '#F65C8A',
  size = 150,
}: {
  value: number;
  label: string;
  color?: string;
  size?: number;
}) {
  const r = size / 2 - 12;
  const cx = size / 2;
  const cy = size / 2;
  // 中央数字与弧共用同一个 clamp(0,100) 值
  const val = Math.max(0, Math.min(100, Number(value) || 0));
  const pct = val / 100;
  const start = Math.PI;
  const end = Math.PI * 2;
  const a = start + (end - start) * pct;
  const arc = (from: number, to: number, radius: number) => {
    const x1 = cx + Math.cos(from) * radius;
    const y1 = cy + Math.sin(from) * radius;
    const x2 = cx + Math.cos(to) * radius;
    const y2 = cy + Math.sin(to) * radius;
    const large = to - from > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}`;
  };
  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size * 0.62} viewBox={`0 0 ${size} ${size * 0.62}`}>
        <path d={arc(start, end, r)} fill="none" style={{ stroke: 'var(--line)' }} strokeWidth={11} strokeLinecap="round" />
        {pct > 0.001 ? <path d={arc(start, a, r)} fill="none" stroke={color} strokeWidth={11} strokeLinecap="round" /> : null}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize={20} fontWeight={600} fill={color}>
          {Math.round(val)}
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontSize={10} style={{ fill: 'var(--ink-2)' }}>
          {label}
        </text>
      </svg>
    </div>
  );
}

export function StageLadder({
  stages,
  current,
}: {
  stages: { id: number; name: string; en: string; min: number; max: number }[];
  current: number;
}) {
  if (!stages.length) return null;
  // current 未命中任何 id 时，归一化到最接近的合法阶段
  const ids = stages.map((s) => s.id);
  const cur = ids.includes(current)
    ? current
    : ids.reduce((best, id) => (Math.abs(id - current) < Math.abs(best - current) ? id : best), ids[0]);
  return (
    <div className="flex items-stretch gap-1.5">
      {stages.map((s) => {
        const active = s.id === cur;
        const passed = s.id < cur;
        return (
          <div key={s.id} className="flex-1">
            <div
              className={`h-2 rounded-full ${
                active ? 'bg-rose-500' : passed ? 'bg-rose-300' : 'accent-soft'
              }`}
            />
            <div className={`mt-1.5 text-center text-[11px] ${active ? 'font-semibold acc' : 'ink-3'}`}>
              {s.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}