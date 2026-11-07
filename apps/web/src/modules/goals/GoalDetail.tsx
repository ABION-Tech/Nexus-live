import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Card, Button, StatusBadge, LoadingState, ErrorState, ProgressBar, Badge, useToast } from '../../components/ui';
import { DecompositionProgress } from '../../components/goals';
import { fetchGoal, regenerateGoal, archiveGoal } from '../../services/goalService';
import type { GoalWithProgress } from '@nexus/shared';

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; goal: GoalWithProgress };

export function GoalDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { show } = useToast();
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  const [regenerating, setRegenerating] = useState(false);

  function load() {
    if (!id) return;
    setState({ status: 'loading' });
    fetchGoal(id)
      .then((goal) => setState({ status: 'ready', goal }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setState({ status: 'error', message });
      });
  }

  useEffect(load, [id]);

  async function handleRegenerate() {
    if (!id) return;
    setRegenerating(true);
    try {
      await regenerateGoal(id);
      show('Regenerated — new proposals are in the Review Queue.', 'success');
      load();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Regeneration failed.', 'danger');
    } finally {
      setRegenerating(false);
    }
  }

  async function handleArchive() {
    if (!id) return;
    if (!confirm('Archive this goal? Its tasks stay as they are — only the goal is archived.')) return;
    try {
      await archiveGoal(id);
      show('Goal archived.', 'success');
      navigate('/goals');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Archive failed.', 'danger');
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading goal…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load goal" description={state.message} onRetry={load} />;

  const { goal } = state;

  return (
    <div className="nx-page nx-page--narrow nx-view-enter" style={{ maxWidth: 760 }}>
      <div>
        <Link to="/goals" style={{ fontSize: 13 }}>← Active Goals</Link>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ marginBottom: 4 }}>{goal.title}</h2>
          <Badge tone={goal.status === 'archived' ? 'neutral' : 'info'}>{goal.status}</Badge>
        </div>
        {goal.status === 'active' && (
          <div className="nx-row">
            <Button variant="secondary" size="sm" onClick={handleRegenerate} disabled={regenerating}>
              Regenerate
            </Button>
            <Button variant="danger" size="sm" onClick={handleArchive}>Archive</Button>
          </div>
        )}
      </div>

      {regenerating && <DecompositionProgress />}

      <Card style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <span>Completion</span>
          <span>{goal.completionPercent}% ({goal.doneTaskCount}/{goal.taskCount} tasks)</span>
        </div>
        <ProgressBar value={goal.completionPercent} />
      </Card>

      {goal.pendingTasks.filter((p) => p.status === 'pending').length > 0 && (
        <Card style={{ padding: 16 }}>
          <div className="nx-row nx-row--between">
            <strong>{goal.pendingTasks.filter((p) => p.status === 'pending').length} task(s) awaiting review</strong>
            <Link to={`/goals/review-queue?goalId=${goal.id}`}>
              <Button size="sm">Go to Review Queue</Button>
            </Link>
          </div>
        </Card>
      )}

      <div>
        <h3 style={{ marginBottom: 8 }}>Tasks ({goal.taskCount})</h3>
        {goal.tasks.length === 0 ? (
          <p style={{ opacity: 0.7 }}>No approved tasks yet — check the Review Queue.</p>
        ) : (
          <div className="nx-stack nx-stack--sm">
            {goal.tasks.map((task) => (
              <Card key={task.id} style={{ padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{task.title}</span>
                <StatusBadge status={task.status} />
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
