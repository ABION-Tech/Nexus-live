import { useEffect, useState } from 'react';
import { Card, Badge, LoadingState, ErrorState } from '../../components/ui';
import { MetricCard } from '../../components/dashboard';
import { fetchGroupAnalyticsOverview, fetchGroupCompanies } from '../../services/groupAdminService';
import type { GroupAnalyticsSummary, Organization } from '@nexus/shared';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; summary: GroupAnalyticsSummary; companies: Organization[] };

// Group Admin > Overview (ADMIN_BUILD_GUIDE.md §3 "Session 6"). One
// summary card row from GET /admin/group/analytics/overview, plus a
// quick glance at the group's own companies list (full management lives
// on the Companies tab — this is a preview, same "landing page surfaces
// what the section's own subsections drill into" pattern People >
// Overview already uses for its role-count cards).
export function GroupOverview() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  function load() {
    setState({ status: 'loading' });
    Promise.all([fetchGroupAnalyticsOverview(), fetchGroupCompanies()])
      .then(([summary, companies]) => setState({ status: 'ready', summary, companies }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(load, []);

  if (state.status === 'loading') return <LoadingState label="Loading group overview…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load group overview" description={state.message} onRetry={load} />;

  const { summary, companies } = state;
  const preview = companies.slice(0, 5);

  return (
    <div className="nx-page nx-view-enter">
      <h1>Group Admin</h1>

      <div className="nx-dashboard-overview__metrics">
        <MetricCard label="Companies" value={summary.totalCompanies} />
        <MetricCard label="Active companies" value={summary.activeCompanies} />
        <MetricCard label="Total users" value={summary.totalUsers} />
      </div>

      <Card>
        <h3 style={{ marginBottom: 12 }}>Companies in this group</h3>
        {preview.length === 0 ? (
          <p style={{ color: 'var(--text-dim)' }}>No companies in this group yet.</p>
        ) : (
          <div className="nx-stack nx-stack--sm">
            {preview.map((c) => (
              <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <span>{c.name}</span>
                <Badge tone={c.active ? 'success' : 'neutral'}>{c.active ? 'Active' : 'Inactive'}</Badge>
              </div>
            ))}
          </div>
        )}
        {companies.length > preview.length && (
          <p style={{ marginTop: 12, color: 'var(--text-dim)', fontSize: 13 }}>
            +{companies.length - preview.length} more — see the Companies tab.
          </p>
        )}
      </Card>
    </div>
  );
}
