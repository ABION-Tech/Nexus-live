import { useEffect, useState } from 'react';
import { Card, LoadingState, ErrorState } from '../../components/ui';
import { MetricCard, ActivityFeed, TaskCountBadge, type ActivityItem } from '../../components/dashboard';

// PRD §7.2, 01 DASHBOARD → Overview. First real module, replacing App.tsx's
// Tier 1 kitchen sink (PRD §17.1 Phase D).
//
// Two open items this module deliberately does NOT resolve, both already
// flagged in SESSION_LOG.md:
//  1. IA reconciliation (O8) is still unresolved, and the PRD says no
//     module should be built against an unfinalized IA. This is built as a
//     standalone, unrouted preview screen for that reason — App.tsx renders
//     it directly, there's no sidebar/router wiring yet.
//  2. There is no APIService for apps/web yet (Tier 4 not built on the web
//     side). `fetchOverview` below stands in for that call so this module
//     has something real to render loading/error/success against, per the
//     §6.2 acceptance criteria — swap its body for a real APIService call
//     once that layer exists, without touching anything else here.
//
// Not yet built: AttentionQueuePanel, DailyDigestCard (both listed in
// §8.1's key components alongside MetricCard/ActivityFeed/TaskCountBadge) —
// left for a follow-up pass.

interface OverviewData {
  metrics: {
    openTasks: number;
    dueToday: number;
    blocked: number;
    eodCompliance: string;
  };
  taskBadgeCount: number;
  activity: ActivityItem[];
}

function fetchOverview(): Promise<OverviewData> {
  // Stand-in for APIService.get('/dashboard/overview') — see module note.
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        metrics: { openTasks: 24, dueToday: 6, blocked: 3, eodCompliance: '92%' },
        taskBadgeCount: 6,
        activity: [
          { id: '1', actorName: 'Ada Obi', message: 'marked "Draft Q3 partner email" as done', timestamp: '12m ago' },
          { id: '2', actorName: 'Femi Cole', message: 'moved "Vendor onboarding" to Blocked', timestamp: '1h ago' },
          { id: '3', actorName: 'Ada Obi', message: 'added a note to "State network follow-up"', timestamp: '3h ago' },
        ],
      });
    }, 400);
  });
}

export function Overview() {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: OverviewData }
  >({ status: 'loading' });

  function load() {
    setState({ status: 'loading' });
    fetchOverview()
      .then((data) => setState({ status: 'ready', data }))
      .catch(() => setState({ status: 'error' }));
  }

  useEffect(load, []);

  if (state.status === 'loading') return <LoadingState label="Loading dashboard…" />;
  if (state.status === 'error') {
    return <ErrorState description="Couldn't load your dashboard." onRetry={load} />;
  }

  const { metrics, taskBadgeCount, activity } = state.data;

  return (
    // nx-view-enter: UI Rehaul polish pass — every route swap in index.html
    // faded/slid in (.view.active); reference usage here for other modules
    // to copy onto their own top-level return (SESSION_SCOPE_UI_REHAUL.md §1).
    <div className="nx-dashboard-overview nx-view-enter">
      <div className="nx-dashboard-overview__head">
        <h1>Dashboard</h1>
        <TaskCountBadge count={taskBadgeCount} label="tasks due" />
      </div>

      <div className="nx-dashboard-overview__metrics">
        <MetricCard label="Open tasks" value={metrics.openTasks} />
        <MetricCard label="Due today" value={metrics.dueToday} delta={{ value: '+2 vs yesterday', direction: 'up', positiveDirection: 'down' }} />
        <MetricCard label="Blocked" value={metrics.blocked} delta={{ value: '-1 vs yesterday', direction: 'down', positiveDirection: 'down' }} />
        <MetricCard label="EOD compliance" value={metrics.eodCompliance} delta={{ value: 'steady', direction: 'flat' }} />
      </div>

      <Card>
        <h3 style={{ marginBottom: 12 }}>Recent activity</h3>
        <ActivityFeed items={activity} />
      </Card>
    </div>
  );
}
