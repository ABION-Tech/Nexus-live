import type { ReactNode } from 'react';
import { Card } from '../ui/Card';

export type MetricDeltaDirection = 'up' | 'down' | 'flat';

export interface MetricDelta {
  value: string; // pre-formatted, e.g. "+12%", "-3 vs yesterday"
  direction: MetricDeltaDirection;
  // Whether "up" is good (default) — flip for metrics like "Blocked tasks"
  // where a rising number is bad. Drives delta color, not the arrow glyph.
  positiveDirection?: MetricDeltaDirection;
}

export interface MetricCardProps {
  label: string;
  value: string | number;
  delta?: MetricDelta;
  icon?: ReactNode;
}

const ARROW: Record<MetricDeltaDirection, string> = { up: '▲', down: '▼', flat: '•' };

// Tier 2 (PRD §6.3) — the KPI tile for Dashboard §8.1. Thin composition over
// Card/Badge-level primitives, not a new primitive itself: three or more of
// these existing side by side (recent tasks, EOD compliance, blocked count,
// etc.) is what earned it its own component per the §6.2 abstraction rule.
export function MetricCard({ label, value, delta, icon }: MetricCardProps) {
  const good = delta ? delta.direction === (delta.positiveDirection ?? 'up') : false;
  const deltaTone = !delta || delta.direction === 'flat' ? 'flat' : good ? 'good' : 'bad';

  return (
    // interactive + accent-corner: UI Rehaul polish pass (SESSION_SCOPE_UI_REHAUL.md
    // §1) — restores index.html's .stat-card hover-lift + corner-glow, which the
    // plain flat Card this used before didn't have.
    <Card interactive className="nx-metric-card nx-card--accent-corner">
      <div className="nx-metric-card__head">
        <span className="nx-metric-card__label">{label}</span>
        {icon && <span className="nx-metric-card__icon">{icon}</span>}
      </div>
      <div className="nx-metric-card__value">{value}</div>
      {delta && (
        <span className={`nx-metric-card__delta nx-metric-card__delta--${deltaTone}`}>
          {ARROW[delta.direction]} {delta.value}
        </span>
      )}
    </Card>
  );
}
