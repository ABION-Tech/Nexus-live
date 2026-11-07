import { Badge } from '../ui/Badge';

export interface TaskCountBadgeProps {
  count: number;
  label?: string;
  /** Count at/above which the badge escalates to the danger tone. */
  urgentAt?: number;
}

// Tier 2 (PRD §8.1: "Badges are live (polling or websocket) for Tasks and
// Calendar items"). This component only renders whatever count it's given —
// the polling/websocket source is a NotificationService/APIService concern
// (§6.2: no component performs its own data fetching), wired in by whatever
// module or nav item embeds it.
export function TaskCountBadge({ count, label, urgentAt = 10 }: TaskCountBadgeProps) {
  const tone = count === 0 ? 'neutral' : count >= urgentAt ? 'danger' : 'info';
  return (
    <Badge tone={tone} live={count > 0}>
      {count}
      {label ? ` ${label}` : ''}
    </Badge>
  );
}
