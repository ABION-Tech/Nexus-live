import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Button, LoadingState, ErrorState, EmptyState, useToast } from '../../components/ui';
import { fetchGoals, restoreGoal } from '../../services/goalService';
import type { Goal } from '@nexus/shared';

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; goals: Goal[] };

// PRD §7.2 05 GOALS → Archived Goals. Read-only mirror of ActiveGoals.tsx's
// list half — no "New goal" create flow here (that only ever targets
// active goals), just GET /goals?status=archived (routes/goals.ts already
// validates 'archived' against VALID_STATUSES and passes it straight to
// listGoals, so no backend change was needed for this page). Rows still
// link into GoalDetail like Active Goals' do: /goals/:id isn't gated on
// goal status, so an archived goal's detail page (progress, task list,
// regenerate/archive actions) renders exactly the same way.
//
// The Restore button is the one piece that isn't just a read-only mirror
// — archiving a goal (GoalDetail's archive action) had no way back until
// now. `restoringId` (rather than a single boolean) tracks per-card
// in-flight state so restoring one goal doesn't disable every row's
// button while its request is out, matching the granularity of
// GoalDetail's own per-action `regenerating` flag.
export function ArchivedGoals() {
  const { show } = useToast();
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [restoringId, setRestoringId] = useState<string | null>(null);

  function load() {
    setList({ status: 'loading' });
    fetchGoals('archived')
      .then((goals) => setList({ status: 'ready', goals }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setList({ status: 'error', message });
      });
  }

  useEffect(load, []);

  async function handleRestore(goal: Goal, e: React.MouseEvent) {
    // Row is a Link to the detail page — stop the click from also
    // navigating there while the restore request is in flight.
    e.preventDefault();
    e.stopPropagation();
    setRestoringId(goal.id);
    try {
      await restoreGoal(goal.id);
      show(`"${goal.title}" restored to Active Goals.`, 'success');
      load();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Restore failed.';
      show(message, 'danger');
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <div className="nx-page nx-view-enter">
      <div className="nx-row nx-row--between">
        <h2>Archived Goals</h2>
      </div>

      {list.status === 'loading' && <LoadingState label="Loading goals…" />}
      {list.status === 'error' && <ErrorState title="Couldn't load goals" description={list.message} onRetry={load} />}
      {list.status === 'ready' && list.goals.length === 0 && (
        <EmptyState
          title="No archived goals"
          description="Goals you archive from the detail page will show up here."
        />
      )}
      {list.status === 'ready' && list.goals.length > 0 && (
        <div className="nx-stack nx-stack--md">
          {list.goals.map((goal) => (
            <Link key={goal.id} to={`/goals/${goal.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <Card interactive style={{ padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flex: 1, minWidth: 0 }}>
                    <strong>{goal.title}</strong>
                    <span style={{ fontSize: 12, opacity: 0.7 }}>{new Date(goal.createdAt).toLocaleDateString()}</span>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={restoringId === goal.id}
                    onClick={(e) => handleRestore(goal, e)}
                  >
                    {restoringId === goal.id ? 'Restoring…' : 'Restore'}
                  </Button>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
