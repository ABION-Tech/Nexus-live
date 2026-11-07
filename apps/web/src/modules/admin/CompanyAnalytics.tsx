import { useEffect, useState } from 'react';
import { Card, LoadingState, ErrorState } from '../../components/ui';
import { MetricCard } from '../../components/dashboard';
import { TaskTrendsChart } from '../../components/analytics';
import { fetchCompanyAnalyticsOverview, type CompanyAnalyticsOverview } from '../../services/companyAdminService';

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: CompanyAnalyticsOverview };

// Company Admin > Analytics — GET /admin/company/analytics/overview
// (task trends + blocked/upcoming-deadline counts pre-assembled server-
// side, one fetch instead of the three Analytics > Overview itself
// makes — companyAdmin.ts's own header comment on why this route exists
// as its own thing rather than the client composing analyticsService
// calls directly).
export function CompanyAnalytics() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  function load() {
    setState({ status: 'loading' });
    fetchCompanyAnalyticsOverview()
      .then((data) => setState({ status: 'ready', data }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(load, []);

  if (state.status === 'loading') return <LoadingState label="Loading analytics…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load analytics" description={state.message} onRetry={load} />;

  const { trends, blockedCount, upcomingDeadlineCount } = state.data;

  return (
    <div className="nx-page nx-view-enter">
      <h2>Analytics</h2>
      <div className="nx-dashboard-overview__metrics">
        <MetricCard label="Blocked tasks" value={blockedCount} />
        <MetricCard label="Upcoming deadlines" value={upcomingDeadlineCount} />
      </div>
      <Card>
        <h3 style={{ marginBottom: 12 }}>Task Trends</h3>
        <TaskTrendsChart points={trends} />
      </Card>
    </div>
  );
}
