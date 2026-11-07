import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LoadingState, ErrorState } from '../../components/ui';
import { MetricCard } from '../../components/dashboard';
import { fetchTasks } from '../../services/taskService';
import type { CurrentUser } from '../../services/authService';

interface WorkCounts {
  myOpen: number;
  teamOpen: number;
}

function loadCounts(userId: string): Promise<WorkCounts> {
  return Promise.all([
    fetchTasks({ assignedToUserId: userId }),
    fetchTasks({}),
  ]).then(([mine, team]) => ({
    myOpen: mine.filter((t) => t.status !== 'done').length,
    teamOpen: team.filter((t) => t.status !== 'done').length,
  }));
}

// PRD §7.2 02 WORK → Overview. Same landing-page role as Network's
// Overview.tsx: a count per subsection plus a link into each. `teamOpen`
// reads the same as My Tasks for a non-`tasks.read` caller (the API
// silently narrows to their own assignments either way, PRD §13.3) — that's
// expected, not a bug to fix here.
export function Overview({ user }: { user: CurrentUser }) {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; counts: WorkCounts }
  >({ status: 'loading' });

  function load() {
    setState({ status: 'loading' });
    loadCounts(user.id)
      .then((counts) => setState({ status: 'ready', counts }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setState({ status: 'error', message });
      });
  }

  useEffect(load, [user.id]);

  if (state.status === 'loading') return <LoadingState label="Loading Work…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load Work" description={state.message} onRetry={load} />;

  return (
    <div className="nx-page nx-view-enter">
      <h2>Work</h2>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Link to="/work/my-tasks" style={{ textDecoration: 'none' }}>
          <MetricCard label="My open tasks" value={state.counts.myOpen} />
        </Link>
        <Link to="/work/team-tasks" style={{ textDecoration: 'none' }}>
          <MetricCard label="Team open tasks" value={state.counts.teamOpen} />
        </Link>
      </div>
    </div>
  );
}
