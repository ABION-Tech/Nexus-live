import { Table } from '../ui/Table';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import type { AuditLogEntry, AuditResult } from '@nexus/shared';

export interface AuditLogTableProps {
  entries: AuditLogEntry[];
  emptyTitle?: string;
  emptyDescription?: string;
}

const RESULT_TONE: Record<AuditResult, 'success' | 'warning' | 'danger'> = {
  success: 'success',
  forbidden: 'warning',
  error: 'danger',
};

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Tier 2 — shared table for the Activity tab both Group Admin and
// Company Admin dashboards render (ADMIN_BUILD_GUIDE.md §3 "Session 6").
// Both routes (`/admin/group/activity`, `/admin/company/activity`)
// return the same `{ entries: AuditLogEntry[] }` shape, org-scoped
// server-side — this component is purely presentational, same
// division of labor as FailsafeTable/MissingEodList in components/analytics.
export function AuditLogTable({ entries, emptyTitle = 'No activity yet', emptyDescription }: AuditLogTableProps) {
  if (entries.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription ?? 'Administrative actions will show up here as they happen.'} />;
  }

  return (
    <Table
      rowKey={(e) => e.id}
      rows={entries}
      columns={[
        { key: 'timestamp', header: 'When', render: (e) => formatTimestamp(e.timestamp) },
        { key: 'action', header: 'Action', render: (e) => <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{e.action}</code> },
        { key: 'resource', header: 'Resource', render: (e) => e.resourceType },
        { key: 'result', header: 'Result', render: (e) => <Badge tone={RESULT_TONE[e.result]} dot>{e.result}</Badge> },
        { key: 'user', header: 'By', render: (e) => e.userId ?? '—' },
      ]}
    />
  );
}
