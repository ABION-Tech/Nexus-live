import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, LoadingState, ErrorState, EmptyState } from '../../components/ui';
import { fetchGoals } from '../../services/goalService';
import type { Goal } from '@nexus/shared';

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; goals: Goal[] };

// Group Admin > Goals — same reuse posture as GroupPeople.tsx: this
// group's own active goals, via the existing session-cookie-scoped
// GET /goals, read-only here (creating/reviewing goals stays on the
// full Goals section for leaders who want that workflow — this tab is
// an admin-shell-level glance, not a duplicate of Active Goals'
// create-and-decompose flow). Progress isn't in the list payload
// (GET /goals returns bare Goal[], not GoalWithProgress[]) — same note
// ActiveGoals.tsx's own card makes; it renders on the detail page.
export function GroupGoals() {
  const [state, setState] = useState<ListState>({ status: 'loading' });

  function load() {
    setState({ status: 'loading' });
    fetchGoals('active')
      .then((goals) => setState({ status: 'ready', goals }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(load, []);

  if (state.status === 'loading') return <LoadingState label="Loading goals…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load goals" description={state.message} onRetry={load} />;

  return (
    <div className="nx-page nx-view-enter">
      <h2>Goals</h2>
      {state.goals.length === 0 ? (
        <EmptyState title="No active goals" description="This group has no active goals right now." />
      ) : (
        <div className="nx-stack nx-stack--md">
          {state.goals.map((goal) => (
            <Link key={goal.id} to={`/goals/${goal.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <Card interactive style={{ padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <strong>{goal.title}</strong>
                  <span style={{ fontSize: 12, opacity: 0.7 }}>{new Date(goal.createdAt).toLocaleDateString()}</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

