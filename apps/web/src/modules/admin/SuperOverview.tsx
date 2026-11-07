import { useEffect, useState } from 'react';
import { Card, Badge, LoadingState, ErrorState } from '../../components/ui';
import { MetricCard } from '../../components/dashboard';
import { fetchPlatformAnalytics, fetchSystemHealth } from '../../services/superAdminService';
import type { PlatformAnalyticsSummary, SubsystemStatus, SystemHealthReport } from '@nexus/shared';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; summary: PlatformAnalyticsSummary; health: SystemHealthReport };

const STATUS_TONE: Record<SubsystemStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  ok: 'success',
  degraded: 'warning',
  down: 'danger',
  unknown: 'neutral',
};

// Super Admin > Overview (ADMIN_BUILD_GUIDE.md §3 "Session 5"). Platform-
// wide counts (GET /admin/super/analytics/overview) plus a subsystem
// health strip (GET /admin/super/system-health) — same "landing page
// previews what the section's own tabs drill into" pattern GroupOverview
// already uses, one level up (platform-wide instead of one group's own
// children).
export function SuperOverview() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  function load() {
    setState({ status: 'loading' });
    Promise.all([fetchPlatformAnalytics(), fetchSystemHealth()])
      .then(([summary, health]) => setState({ status: 'ready', summary, health }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(load, []);

  if (state.status === 'loading') return <LoadingState label="Loading platform overview…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load platform overview" description={state.message} onRetry={load} />;

  const { summary, health } = state;

  return (
    <div className="nx-page nx-view-enter">
      <h1>Super Admin</h1>

      <div className="nx-dashboard-overview__metrics">
        <MetricCard label="Groups" value={summary.totalGroups} />
        <MetricCard label="Companies" value={summary.totalCompanies} />
        <MetricCard label="Active organizations" value={summary.activeOrganizations} />
        <MetricCard label="Total users" value={summary.totalUsers} />
        <MetricCard label="Platform admins" value={summary.totalPlatformAdmins} />
      </div>

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>System health</h3>
          <Badge tone={STATUS_TONE[health.overall]}>{health.overall}</Badge>
        </div>
        <div className="nx-stack nx-stack--sm">
          {health.subsystems.map((s) => (
            <div
              key={s.name}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}
            >
              <span style={{ textTransform: 'capitalize' }}>{s.name}</span>
              <div className="nx-row">
                {s.detail && <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>{s.detail}</span>}
                <Badge tone={STATUS_TONE[s.status]} dot>{s.status}</Badge>
              </div>
            </div>
          ))}
        </div>
        <p style={{ marginTop: 12, color: 'var(--text-dim)', fontSize: 12 }}>
          Some subsystems report "unknown" until their real health check is wired up (systemMetricsService.ts) — not a failure, just not instrumented yet.
        </p>
      </Card>
    </div>
  );
}
