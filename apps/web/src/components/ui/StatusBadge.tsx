import { Badge } from './Badge';
import type { TaskStatus } from '@nexus/shared';

// Fixed semantic mapping for task status (PRD §8.2, §9). Thin domain wrapper
// over Badge — kept in Tier 1 per PRD §14 because task status is used
// across nearly every module, not just Work.
const STATUS_MAP: Record<TaskStatus, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' }> = {
  not_started: { label: 'Not started', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'info' },
  blocked: { label: 'Blocked', tone: 'warning' },
  done: { label: 'Done', tone: 'success' },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const cfg = STATUS_MAP[status];
  return <Badge tone={cfg.tone} dot>{cfg.label}</Badge>;
}
