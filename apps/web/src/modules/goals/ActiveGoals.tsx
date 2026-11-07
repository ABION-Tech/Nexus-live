import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Button, Modal, Input, LoadingState, ErrorState, EmptyState, useToast } from '../../components/ui';
import { DecompositionProgress } from '../../components/goals';
import { fetchGoals, createGoal } from '../../services/goalService';
import type { Goal } from '@nexus/shared';

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; goals: Goal[] };

// PRD §8.5 — the reference agent workflow: "AI proposes → human approves/
// rejects → system executes." Creating a goal here doesn't create tasks
// directly; it triggers AIService.decomposeGoal (or the stub, if
// AI_PROVIDER=stub) and lands the result in pending_ai_tasks, awaiting
// Review Queue action. This page only handles the "create the goal and
// kick off decomposition" half — approval lives in ReviewQueue.tsx.
export function ActiveGoals() {
  const { show } = useToast();
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [modalOpen, setModalOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [decomposing, setDecomposing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function load() {
    setList({ status: 'loading' });
    fetchGoals('active')
      .then((goals) => setList({ status: 'ready', goals }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setList({ status: 'error', message });
      });
  }

  useEffect(load, []);

  async function handleCreate() {
    if (!title.trim()) {
      setFormError('Give the goal a title.');
      return;
    }
    setFormError(null);
    setDecomposing(true);
    try {
      // No proposedTasks passed — this is the real decomposeGoal() call
      // site (goalService.ts's comment on why `undefined` matters here).
      const { pendingTasks } = await createGoal(title.trim());
      setModalOpen(false);
      setTitle('');
      show(
        pendingTasks.length
          ? `Goal created — ${pendingTasks.length} proposed task${pendingTasks.length === 1 ? '' : 's'} awaiting review.`
          : 'Goal created — no tasks were proposed.',
        'success'
      );
      load();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Decomposition failed.';
      setFormError(message);
    } finally {
      setDecomposing(false);
    }
  }

  return (
    <div className="nx-page nx-view-enter">
      <div className="nx-row nx-row--between">
        <h2>Active Goals</h2>
        <Button onClick={() => setModalOpen(true)}>New goal</Button>
      </div>

      {list.status === 'loading' && <LoadingState label="Loading goals…" />}
      {list.status === 'error' && <ErrorState title="Couldn't load goals" description={list.message} onRetry={load} />}
      {list.status === 'ready' && list.goals.length === 0 && (
        <EmptyState
          title="No active goals yet"
          description="Create one to see AI decomposition in action."
          action={<Button onClick={() => setModalOpen(true)}>New goal</Button>}
        />
      )}
      {list.status === 'ready' && list.goals.length > 0 && (
        <div className="nx-stack nx-stack--md">
          {list.goals.map((goal) => (
            <Link key={goal.id} to={`/goals/${goal.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <Card interactive style={{ padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <strong>{goal.title}</strong>
                  <span style={{ fontSize: 12, opacity: 0.7 }}>{new Date(goal.createdAt).toLocaleDateString()}</span>
                </div>
                {/* Progress isn't in the list payload (GET /goals returns
                    bare Goal[], not GoalWithProgress[]) — a per-card fetch
                    would be N+1; the bar renders on the detail page instead,
                    where the single GET already includes it. */}
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => (decomposing ? undefined : setModalOpen(false))} title="New goal">
        {decomposing ? (
          <DecompositionProgress />
        ) : (
          <div className="nx-stack nx-stack--md">
            <Input
              label="Goal title"
              placeholder="e.g. Launch the Q4 partner outreach campaign"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              error={formError ?? undefined}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setModalOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate}>Decompose with AI</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
