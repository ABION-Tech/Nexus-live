import { useEffect, useState } from 'react';
import { LoadingState, ErrorState } from '../../components/ui';
import { MetricCard } from '../../components/dashboard';
import { fetchCompanyOverview } from '../../services/companyAdminService';
import type { CompanyAnalyticsSummary } from '@nexus/shared';

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; summary: CompanyAnalyticsSummary };

// Company Admin > Overview — GET /admin/company/overview, the one
// aggregate-counts pass companyAdmin.ts assembles server-side (people,
// task statuses, goals, knowledge) rather than the client making four
// separate calls. Company Admin is "mostly reuse" per the guide (a
// Company Admin is just a `leader`) — People/Work/Goals/Knowledge stay
// on their own top-level sidebar sections; this tab is purely the
// admin-shell landing summary.
export function CompanyOverview() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  function load() {
    setState({ status: 'loading' });
    fetchCompanyOverview()
      .then((summary) => setState({ status: 'ready', summary }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(load, []);

  if (state.status === 'loading') return <LoadingState label="Loading overview…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load overview" description={state.message} onRetry={load} />;

  const { summary } = state;

  return (
    <div className="nx-page nx-view-enter">
      <h1>Company Admin</h1>
      <div className="nx-dashboard-overview__metrics">
        <MetricCard label="People" value={summary.totalPeople} />
        <MetricCard label="Open tasks" value={summary.openTasks} />
        <MetricCard label="Blocked" value={summary.blockedTasks} delta={{ value: 'blocked', direction: summary.blockedTasks > 0 ? 'up' : 'flat', positiveDirection: 'down' }} />
        <MetricCard label="Done" value={summary.doneTasks} />
        <MetricCard label="Active goals" value={summary.activeGoals} />
        <MetricCard label="Knowledge entries" value={summary.knowledgeEntries} />
      </div>
    </div>
  );
}
