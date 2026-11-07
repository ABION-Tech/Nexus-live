import { EmptyState } from '../ui/EmptyState';
import type { TaskTrendPoint } from '@nexus/shared';

export interface TaskTrendsChartProps {
  points: TaskTrendPoint[];
  height?: number;
}

type SeriesKey = 'openTasks' | 'doneToday' | 'overdue' | 'atRisk';

const SERIES: { key: SeriesKey; label: string; varName: string }[] = [
  { key: 'openTasks', label: 'Open', varName: '--accent' },
  { key: 'doneToday', label: 'Done today', varName: '--success' },
  { key: 'overdue', label: 'Overdue', varName: '--danger' },
  { key: 'atRisk', label: 'At risk', varName: '--warning' },
];

const Y_TICKS = 4; // horizontal gridlines, not counting the zero baseline

// Rounds a max value up to a "nice" number so y-axis ticks land on whole,
// human-friendly steps (5, 10, 25, 50…) instead of whatever the raw data
// max happens to be — the same trick most charting libraries do
// internally, done by hand here since this stays plain SVG (§6.2's
// abstraction rule: no charting dependency until something actually
// needs stacking/zoom/animation, which four polylines don't).
function niceMax(rawMax: number): number {
  if (rawMax <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawMax));
  const normalized = rawMax / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

// Tier 2 (PRD §6.3, §8.7 — "Task Trends is confirmed rendered as a
// chart"). No charting library — this is a handful of lines on a shared
// scale, which plain SVG covers without pulling in a dependency for it.
export function TaskTrendsChart({ points, height = 240 }: TaskTrendsChartProps) {
  if (points.length === 0) {
    return <EmptyState title="No trend data yet" description="Task Trends snapshots appear once the daily job has run at least once." />;
  }

  const width = 640;
  const padding = { top: 12, right: 12, bottom: 28, left: 34 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const rawMax = Math.max(0, ...points.flatMap((p) => SERIES.map((s) => p[s.key])));
  const maxValue = niceMax(rawMax);
  const xStep = points.length > 1 ? innerW / (points.length - 1) : 0;

  function xAt(i: number) {
    return padding.left + i * xStep;
  }
  function yAt(value: number) {
    return padding.top + innerH - (value / maxValue) * innerH;
  }
  function coords(key: SeriesKey) {
    return points.map((p, i) => `${xAt(i)},${yAt(p[key])}`).join(' ');
  }

  const yTickValues = Array.from({ length: Y_TICKS + 1 }, (_, i) => Math.round((maxValue / Y_TICKS) * i));

  // Thin out x-axis labels so they don't collide on a longer range —
  // show at most ~6, always including the first and last point.
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));

  return (
    <div className="nx-trend-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Task trends over time">
        {/* Gridlines + y-axis scale, drawn bottom-to-top so the 0 line
            doubles as the x-axis baseline. */}
        {yTickValues.map((v) => (
          <g key={v}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={yAt(v)}
              y2={yAt(v)}
              className={v === 0 ? 'nx-trend-chart__baseline' : 'nx-trend-chart__gridline'}
            />
            <text x={padding.left - 6} y={yAt(v)} textAnchor="end" dominantBaseline="middle" className="nx-trend-chart__ytick">
              {v}
            </text>
          </g>
        ))}

        {SERIES.map((s) => (
          <g key={s.key}>
            <polyline points={coords(s.key)} fill="none" stroke={`var(${s.varName})`} strokeWidth={2} strokeLinejoin="round" />
            {points.map((p, i) => (
              <circle key={p.date} cx={xAt(i)} cy={yAt(p[s.key])} r={3} fill={`var(${s.varName})`} className="nx-trend-chart__dot">
                <title>{`${s.label}: ${p[s.key]} on ${p.date}`}</title>
              </circle>
            ))}
          </g>
        ))}

        {points.map((p, i) =>
          i % labelEvery === 0 || i === points.length - 1 ? (
            <text
              key={p.date}
              x={xAt(i)}
              y={height - 8}
              textAnchor="middle"
              className="nx-trend-chart__label"
            >
              {p.date.slice(5)}
            </text>
          ) : null
        )}
      </svg>
      <div className="nx-trend-chart__legend">
        {SERIES.map((s) => (
          <span key={s.key} className="nx-trend-chart__legend-item">
            <span className="nx-trend-chart__swatch" style={{ background: `var(${s.varName})` }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
