import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Card, Button, Badge, LoadingState, ErrorState, EmptyState, useToast } from '../../components/ui';
import { fetchApprovals, approvePendingTask, rejectPendingTask } from '../../services/approvalService';
import { fetchGoals } from '../../services/goalService';
import type { Goal, PendingAiTask } from '@nexus/shared';

type QueueState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: PendingAiTask[]; goalTitles: Map<string, string> };

// PRD §8.5: "Review Queue (permission-gated): Groups pending AI-proposed
// items by goal. Approve-all action available. Approval/rejection
// surfaces the reasoning behind each suggestion." — and §4/§8.5's
// general contract for every agent workflow: "AI proposes → human
// approves/rejects → system executes."
//
// GET /approvals already filters to status='pending' server-side
// (approvalService.ts, API side) — this page never needs its own status
// filter, only the grouping/goalId-scoping.
export function ReviewQueue() {
  const [searchParams] = useSearchParams();
  const goalId = searchParams.get('goalId') ?? undefined;
  const { show } = useToast();
  const [state, setState] = useState<QueueState>({ status: 'loading' });
  // Per-item in-flight tracking so Approve/Reject buttons disable only on
  // the row being acted on, not the whole queue — and so "Approve all"
  // can show which row it's currently on.
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  function load() {
    setState({ status: 'loading' });
    Promise.all([fetchApprovals(goalId), fetchGoals()])
      .then(([items, goals]: [PendingAiTask[], Goal[]]) => {
        const goalTitles = new Map(goals.map((g) => [g.id, g.title] as const));
        setState({ status: 'ready', items, goalTitles });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setState({ status: 'error', message });
      });
  }

  useEffect(load, [goalId]);

  const grouped = useMemo(() => {
    if (state.status !== 'ready') return [];
    const byGoal = new Map<string, PendingAiTask[]>();
    for (const item of state.items) {
      const list = byGoal.get(item.goalId) ?? [];
      list.push(item);
      byGoal.set(item.goalId, list);
    }
    return Array.from(byGoal.entries()).map(([gId, items]) => ({
      goalId: gId,
      goalTitle: state.goalTitles.get(gId) ?? 'Untitled goal',
      items,
    }));
  }, [state]);

  async function handleApprove(item: PendingAiTask) {
    setPendingActionId(item.id);
    try {
      await approvePendingTask(item.id);
      show(`Approved "${item.title}" — added to Master Tasks.`, 'success');
      load();
    } catch (err: unknown) {
      // ApprovalError codes surface as ApiError.message from apiClient —
      // dependency_not_approved / dependency_rejected are the two the
      // leader actually needs to see and act on (approve the dependency
      // first, or this one can't be approved at all).
      show(err instanceof Error ? err.message : 'Approval failed.', 'danger');
    } finally {
      setPendingActionId(null);
    }
  }

  async function handleApproveAll(items: PendingAiTask[]) {
    // Sequential, in the order the queue returned them (created_at asc —
    // decomposition inserts dependencies before their dependents), not
    // Promise.all: approving out of order trips ApprovalError
    // 'dependency_not_approved' on anything that depends on a sibling
    // later in the same batch.
    for (const item of items) {
      setPendingActionId(item.id);
      try {
        await approvePendingTask(item.id);
      } catch (err: unknown) {
        show(
          `Stopped at "${item.title}": ${err instanceof Error ? err.message : 'approval failed'}`,
          'danger'
        );
        setPendingActionId(null);
        load();
        return;
      }
    }
    setPendingActionId(null);
    show(`Approved ${items.length} task${items.length === 1 ? '' : 's'}.`, 'success');
    load();
  }

  async function handleReject(item: PendingAiTask) {
    setPendingActionId(item.id);
    try {
      await rejectPendingTask(item.id, rejectReason.trim() || undefined);
      show(`Rejected "${item.title}".`, 'default');
      setRejectingId(null);
      setRejectReason('');
      load();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Rejection failed.', 'danger');
    } finally {
      setPendingActionId(null);
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading Review Queue…" />;
  if (state.status === 'error') {
    return <ErrorState title="Couldn't load Review Queue" description={state.message} onRetry={load} />;
  }

  return (
    <div className="nx-page nx-page--narrow nx-view-enter" style={{ maxWidth: 820 }}>
      <div className="nx-row nx-row--between">
        <h2>Review Queue</h2>
        <Link to="/goals" style={{ fontSize: 13 }}>← Active Goals</Link>
      </div>

      {goalId && (
        <Badge tone="info">Filtered to one goal — <Link to="/goals/review-queue">clear filter</Link></Badge>
      )}

      {grouped.length === 0 && (
        <EmptyState
          title="Nothing awaiting review"
          description="AI-proposed tasks from goal decomposition will show up here."
        />
      )}

      {grouped.map((group) => (
        <div key={group.goalId} className="nx-stack nx-stack--sm">
          <div className="nx-row nx-row--between">
            <Link to={`/goals/${group.goalId}`} style={{ fontWeight: 600 }}>{group.goalTitle}</Link>
            <Button size="sm" onClick={() => handleApproveAll(group.items)} disabled={pendingActionId !== null}>
              Approve all ({group.items.length})
            </Button>
          </div>

          {group.items.map((item) => (
            <Card key={item.id} style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <strong>{item.title}</strong>
                  {item.description && <p style={{ opacity: 0.8, marginTop: 4 }}>{item.description}</p>}
                  {item.reasoning && (
                    <p style={{ fontSize: 13, opacity: 0.7, marginTop: 8 }}>
                      <em>Why: {item.reasoning}</em>
                    </p>
                  )}
                  {item.dependsOnPendingTaskId && (
                    <Badge tone="neutral">Depends on another proposed task</Badge>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <Button
                    size="sm"
                    onClick={() => handleApprove(item)}
                    disabled={pendingActionId !== null}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setRejectingId(rejectingId === item.id ? null : item.id)}
                    disabled={pendingActionId !== null}
                  >
                    Reject
                  </Button>
                </div>
              </div>

              {rejectingId === item.id && (
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <input
                    className="nx-input"
                    placeholder="Reason (optional)"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    style={{ flex: 1 }}
                    autoFocus
                  />
                  <Button size="sm" variant="danger" onClick={() => handleReject(item)} disabled={pendingActionId !== null}>
                    Confirm reject
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      ))}
    </div>
  );
}
