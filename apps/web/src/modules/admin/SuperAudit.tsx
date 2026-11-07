import { useEffect, useState } from 'react';
import { Button, Card, Input, Select, LoadingState, ErrorState } from '../../components/ui';
import { AuditLogTable } from '../../components/admin';
import { fetchAuditLog } from '../../services/superAdminService';
import type { AuditLogEntry, AuditResult } from '@nexus/shared';

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; entries: AuditLogEntry[] };

// Super Admin > Audit & Security (ADMIN_BUILD_GUIDE.md §3 "Session 5").
// Platform-wide — no orgId filter applied by default, unlike Group/
// Company Admin's own Activity tabs which are mandatorily scoped
// server-side to the caller's own org. GET /admin/super/audit-log has no
// such restriction (searchAuditLog with an empty query returns
// everything, gated only by isPlatformAdmin at the route). Reuses
// AuditLogTable, same shared presentational component Group/Company
// Admin's Activity tabs already use — this tab differs only in which
// filters it exposes (result + action, not just org-scoping), not in how
// rows render.
export function SuperAudit() {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [action, setAction] = useState('');
  const [result, setResult] = useState<'' | AuditResult>('');

  function load() {
    setState({ status: 'loading' });
    fetchAuditLog({
      action: action.trim() || undefined,
      result: result || undefined,
      limit: 100,
    })
      .then((entries) => setState({ status: 'ready', entries }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="nx-page nx-view-enter">
      <div>
        <h2>Audit &amp; Security</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
          Every administrative action across the platform — organization changes, plan changes, and platform-level events with
          no single owning org, plus anything captured at the Group/Company level.
        </p>
      </div>

      <Card>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 240px' }}>
            <Input
              label="Action"
              placeholder="e.g. organization.plan_change"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
            />
          </div>
          <div style={{ width: 180 }}>
            <Select
              label="Result"
              value={result}
              onChange={(e) => setResult(e.target.value as '' | AuditResult)}
              options={[
                { value: 'success', label: 'Success' },
                { value: 'forbidden', label: 'Forbidden' },
                { value: 'error', label: 'Error' },
              ]}
              placeholder="Any result"
            />
          </div>
          <Button variant="secondary" onClick={load}>Filter</Button>
        </div>
      </Card>

      {state.status === 'loading' && <LoadingState label="Loading audit log…" />}
      {state.status === 'error' && <ErrorState title="Couldn't load the audit log" description={state.message} onRetry={load} />}
      {state.status === 'ready' && (
        <AuditLogTable entries={state.entries} emptyDescription="No administrative actions match these filters." />
      )}
    </div>
  );
}
