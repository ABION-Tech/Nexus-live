import { Table } from '../ui/Table';
import { StatusBadge } from '../ui/StatusBadge';
import { EmptyState } from '../ui/EmptyState';
import type { Task } from '@nexus/shared';

export interface FailsafeTableProps {
  tasks: Task[];
  emptyTitle: string;
  emptyDescription?: string;
}

function formatDeadline(deadline?: string): string {
  if (!deadline) return '—';
  const d = new Date(deadline);
  const overdue = d.getTime() < Date.now();
  const formatted = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return overdue ? `${formatted} (overdue)` : formatted;
}

// Tier 2 (PRD §8.9: "Render as four distinct components, not one generic
// alert feed" — this is the one shared shape underneath those four, not
// the alert feed itself. §8.7/§8.9 name four Failsafe categories: this
// component currently backs two (blocked, deadlines) via
// modules/analytics/Overview.tsx; `eod` and `partners` will reuse it too
// once their backend tables exist (see analyticsService.ts's api/src
// counterpart for that scope note) — same table shape, different query.
export function FailsafeTable({ tasks, emptyTitle, emptyDescription }: FailsafeTableProps) {
  if (tasks.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <Table
      rowKey={(t) => t.id}
      rows={tasks}
      columns={[
        { key: 'title', header: 'Task', render: (t) => t.title },
        { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
        { key: 'deadline', header: 'Deadline', render: (t) => formatDeadline(t.deadline) },
      ]}
    />
  );
}
