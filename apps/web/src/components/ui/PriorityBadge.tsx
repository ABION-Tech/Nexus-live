import { Badge } from './Badge';

export type Priority = 'low' | 'medium' | 'high' | 'urgent';

const PRIORITY_MAP: Record<Priority, { label: string; tone: 'neutral' | 'info' | 'warning' | 'danger' }> = {
  low: { label: 'Low', tone: 'neutral' },
  medium: { label: 'Medium', tone: 'info' },
  high: { label: 'High', tone: 'warning' },
  urgent: { label: 'Urgent', tone: 'danger' },
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  const cfg = PRIORITY_MAP[priority];
  return <Badge tone={cfg.tone}>{cfg.label}</Badge>;
}
