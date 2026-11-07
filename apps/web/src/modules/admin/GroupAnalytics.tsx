import { useEffect, useState } from 'react';
import { Card, LoadingState, ErrorState } from '../../components/ui';
import { MetricCard } from '../../components/dashboard';
import { TaskTrendsChart } from '../../components/analytics';
import { fetchGroupAnalyticsOverview } from '../../services/groupAdminService';
import { fetchTaskTrends } from '../../services/analyticsService';
import type { GroupAnalyticsSummary, TaskTrendPoint } from '@nexus/shared';

interface Data {
  summary: GroupAnalyticsSummary;
  trends: TaskTrendPoint[];
}

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: Data };

// Group Admin > Analytics — cross-company summary (GET
// /admin/group/analytics/overview, the N-query merge across this
// group's companies) plus this group org's own task trends (same
// session-scoped GET /analytics/task-trends every other module uses —
// a group org can have its own tasks/goals too, same as any org).
export function GroupAnalytics() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  function load() {
    setState({ status: 'loading' });
    Promise.all([fetchGroupAnalyticsOverview(), fetchTaskTrends()])
      .then(([summary, trends]) => setState({ status: 'ready', data: { summary, trends } }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(load, []);

  if (state.status === 'loading') return <LoadingState label="Loading analytics…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load analytics" description={state.message} onRetry={load} />;

  const { summary, trends } = state.data;

  return (
    <div className="nx-page nx-view-enter">
      <h2>Analytics</h2>

      <div className="nx-dashboard-overview__metrics">
        <MetricCard label="Companies" value={summary.totalCompanies} />
        <MetricCard label="Active companies" value={summary.activeCompanies} />
        <MetricCard label="Total users across group" value={summary.totalUsers} />
      </div>

      <Card>
        <h3 style={{ marginBottom: 12 }}>This group's own task trends</h3>
        <TaskTrendsChart points={trends} />
      </Card>
    </div>
  );
}
