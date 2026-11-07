import { useEffect, useState } from 'react';
import { Card, Button, Badge, Select, LoadingState, ErrorState, EmptyState, useToast } from '../../components/ui';
import { fetchAgentHandoffs, createAgentHandoff } from '../../services/agentHandoffService';
import { fetchTasks } from '../../services/taskService';
import type { AgentHandoff, AgentHandoffStatus, Task } from '@nexus/shared';

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

const STATUS_TONE: Record<AgentHandoffStatus, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  queued: 'neutral',
  running: 'info',
  complete: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

// PRD §7.2 08 AI ANALYST → Agent Handoff / §10.6. Leader selects a task
// (optional — a handoff can be freestanding), types instructions, and
// submits: the server follows the exact n8n-first / direct-AI-fallback
// contract (agentHandoffService.ts) and the result — n8n's reply or
// NEXUS AI's stand-in text — lands back in the history list below.
// There's no separate "poll for completion" step here yet since neither
// path is actually async in this first cut (no n8n callback route exists
// until n8n itself is wired) — every handoff a leader submits resolves
// synchronously in the POST response.
export function AgentHandoff() {
  const { show } = useToast();
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [handoffs, setHandoffs] = useState<AgentHandoff[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskId, setTaskId] = useState('');
  const [instructions, setInstructions] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function loadHistory() {
    setLoad({ status: 'loading' });
    fetchAgentHandoffs()
      .then((rows) => {
        setHandoffs(rows);
        setLoad({ status: 'ready' });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setLoad({ status: 'error', message });
      });
  }

  useEffect(loadHistory, []);
  // Best-effort task list for the picker — a failure here shouldn't block
  // the handoff form itself (a handoff can be submitted with no task).
  useEffect(() => {
    fetchTasks().then(setTasks).catch(() => setTasks([]));
  }, []);

  async function handleSubmit() {
    const text = instructions.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const handoff = await createAgentHandoff({ taskId: taskId || undefined, instructions: text });
      setHandoffs((prev) => [handoff, ...prev]);
      setInstructions('');
      setTaskId('');
      if (handoff.status === 'failed') {
        show(`Handoff failed: ${handoff.result ?? 'unknown error'}`, 'danger');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Handoff failed to send.';
      show(message, 'danger');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="nx-page nx-view-enter">
      <h2>Agent Handoff</h2>

      <Card className="nx-stack nx-stack--md">
        <Select
          label="Task (optional)"
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
          placeholder="No specific task"
          options={tasks.map((t) => ({ value: t.id, label: t.title }))}
        />
        <div className="nx-field">
          <label className="nx-field__label" htmlFor="handoff-instructions">Instructions for the agent</label>
          <textarea
            id="handoff-instructions"
            className="nx-input"
            rows={4}
            placeholder="What should the agent do?"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            disabled={submitting}
          />
        </div>
        <div>
          <Button onClick={handleSubmit} disabled={submitting || !instructions.trim()}>
            {submitting ? 'Handing off…' : 'Hand off to agent'}
          </Button>
        </div>
      </Card>

      <h3 style={{ marginBottom: 0 }}>History</h3>
      {load.status === 'loading' && <LoadingState label="Loading handoff history…" />}
      {load.status === 'error' && (
        <ErrorState title="Couldn't load handoff history" description={load.message} onRetry={loadHistory} />
      )}
      {load.status === 'ready' && handoffs.length === 0 && (
        <EmptyState title="No handoffs yet" description="Submit one above to see it here." />
      )}
      {load.status === 'ready' && handoffs.length > 0 && (
        <div className="nx-stack nx-stack--sm">
          {handoffs.map((h) => (
            <Card key={h.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <Badge tone={STATUS_TONE[h.status]} dot>{h.status}</Badge>
                <span style={{ fontSize: 12, opacity: 0.6 }}>{new Date(h.createdAt).toLocaleString()}</span>
              </div>
              {h.instructions && <p style={{ margin: 0 }}>{h.instructions}</p>}
              {h.result && (
                <p style={{ margin: 0, whiteSpace: 'pre-wrap', opacity: 0.85 }}>{h.result}</p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
