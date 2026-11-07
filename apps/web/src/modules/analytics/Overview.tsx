import { useEffect, useState } from 'react';
import { Card, LoadingState, ErrorState } from '../../components/ui';
import { TaskTrendsChart, FailsafeTable, MissingEodList } from '../../components/analytics';
import { MetricCard } from '../../components/dashboard';
import { fetchTaskTrends, fetchBlockedTasks, fetchUpcomingDeadlines } from '../../services/analyticsService';
import { fetchEodCompliance, fetchMissingEod } from '../../services/eodService';
import type { EodComplianceSummary, MissingEodUser, Task, TaskTrendPoint } from '@nexus/shared';

// PRD §7.2, 07 ANALYTICS. Phase 2 of the Analytics build adds EOD
// Compliance + Missing EOD (both real now — apps/api/src/routes/eod.ts —
// see SESSION_LOG for the full phase plan). Task Trends + the two
// Failsafe categories (blocked, deadlines) are Phase 1, unchanged below.
//
// Same real-API, no-login-yet caveat as Phase 1: opening this without a
// session cookie surfaces a real 401 via ErrorState, which is correct.
// Same unrouted-preview caveat re: IA reconciliation (O8) as well.

interface AnalyticsData {
  trends: TaskTrendPoint[];
  blocked: Task[];
  deadlines: Task[];
  eodCompliance: EodComplianceSummary;
  missingEod: MissingEodUser[];
}

function loadAnalytics(): Promise<AnalyticsData> {
  return Promise.all([
    fetchTaskTrends(),
    fetchBlockedTasks(),
    fetchUpcomingDeadlines(),
    fetchEodCompliance(),
    fetchMissingEod(),
  ]).then(([trends, blocked, deadlines, eodCompliance, missingEod]) => ({
    trends,
    blocked,
    deadlines,
    eodCompliance,
    missingEod,
  }));
}

export function Overview() {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: AnalyticsData }
  >({ status: 'loading' });

  function load() {
    setState({ status: 'loading' });
    loadAnalytics()
      .then((data) => setState({ status: 'ready', data }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setState({ status: 'error', message });
      });
  }

  useEffect(load, []);

  if (state.status === 'loading') return <LoadingState label="Loading analytics…" />;
  if (state.status === 'error') {
    return <ErrorState title="Couldn't load analytics" description={state.message} onRetry={load} />;
  }

  const { trends, blocked, deadlines, eodCompliance, missingEod } = state.data;

  return (
    <div className="nx-dashboard-overview">
      <h1>Analytics</h1>

      <Card>
        <h3 style={{ marginBottom: 12 }}>Task Trends</h3>
        <TaskTrendsChart points={trends} />
      </Card>

      <div className="nx-dashboard-overview__metrics">
        <MetricCard label="EOD compliance" value={`${eodCompliance.compliancePercent}%`} />
        <MetricCard label="Filed" value={`${eodCompliance.filedCount} / ${eodCompliance.expectedCount}`} />
      </div>

      <Card>
        <h3 style={{ marginBottom: 12 }}>Failsafe — Missing EOD</h3>
        <MissingEodList users={missingEod} />
      </Card>

      <Card>
        <h3 style={{ marginBottom: 12 }}>Failsafe — Blocked tasks</h3>
        <FailsafeTable tasks={blocked} emptyTitle="Nothing blocked" emptyDescription="No tasks are currently marked blocked." />
      </Card>

      <Card>
        <h3 style={{ marginBottom: 12 }}>Failsafe — Upcoming deadlines</h3>
        <FailsafeTable
          tasks={deadlines}
          emptyTitle="No deadlines coming up"
          emptyDescription="Nothing due (or overdue) in the next 7 days."
        />
      </Card>
    </div>
  );
}
