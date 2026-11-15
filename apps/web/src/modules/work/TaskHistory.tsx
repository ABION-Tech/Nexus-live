// Session 60 (C-12) — the History section in TaskDrawer: who created the
// task, who changed what (before → after), who archived it, who was
// added or removed, and imports. Collapsed by default; fetched when first
// opened.
import { useState } from 'react';
import type { TaskHistoryEntry } from '@nexus/shared';
import { fetchTaskHistory } from '../../services/taskService';
import { relativeTime } from '../automation/automationTime';

const FIELD: Record<string, string> = {
  title: 'title',
  description: 'description',
  status: 'status',
  priority: 'priority',
  startDate: 'start date',
  deadline: 'deadline',
  assignedToUserId: 'assigned to',
  supportUserId: 'support',
  supervisorUserId: 'supervisor',
  dependsOnTaskId: 'depends on',
  business: 'business',
  department: 'department',
};
const STATUS: Record<string, string> = { not_started: 'Not started', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
const PRIORITY: Record<string, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
const PEOPLE = new Set(['assignedToUserId', 'supportUserId', 'supervisorUserId']);
// activity_log rows imported from the original sheet use its own column
// names ("Status", "% Progress"); they're shown as they are.

function show(field: string, v: string | null | undefined, peopleById: Map<string, string>): string {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'status') return STATUS[v] ?? v;
  if (field === 'priority') return PRIORITY[v] ?? v;
  if (PEOPLE.has(field) || field === 'userId') return peopleById.get(v) ?? 'someone';
  if (field === 'deadline' || field === 'startDate') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
  }
  if (field === 'description') return v.length > 60 ? `${v.slice(0, 60)}…` : v;
  if (field === 'dependsOnTaskId') return 'another task';
  return v;
}

function describe(e: TaskHistoryEntry, peopleById: Map<string, string>): string[] {
  switch (e.action) {
    case 'task.created':
      return ['created this task'];
    case 'task.archived':
      return ['archived this task'];
    case 'task.restored':
      return ['restored this task'];
    case 'tasks.import':
      return ['imported this task'];
    case 'task.assignee_added':
      return [`added ${show('userId', e.next?.userId, peopleById)} as ${e.next?.role === 'support' ? 'support' : 'an assignee'}`];
    case 'task.assignee_removed':
      return [`removed ${show('userId', e.previous?.userId, peopleById)} as ${e.previous?.role === 'support' ? 'support' : 'an assignee'}`];
    case 'task.updated':
      return Object.keys(e.next ?? {}).map(
        (f) => `changed ${FIELD[f] ?? f}: ${show(f, e.previous?.[f], peopleById)} → ${show(f, e.next?.[f], peopleById)}`
      );
    default:
      return [e.action];
  }
}

export function TaskHistory({ taskId, peopleById }: { taskId: string; peopleById: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<TaskHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && entries === null) {
      fetchTaskHistory(taskId)
        .then(setEntries)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Couldn't load the history."));
    }
  }

  return (
    <div className="nx-stack nx-stack--sm">
      <button type="button" onClick={toggle} aria-expanded={open} className="nx-taskhist__toggle">
        <h4 style={{ margin: 0 }}>History</h4>
        <span aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open &&
        (error ? (
          <p className="nx-cell-dim" style={{ fontSize: 13 }}>{error}</p>
        ) : entries === null ? (
          <p className="nx-cell-dim" style={{ fontSize: 13 }}>Loading…</p>
        ) : entries.length === 0 ? (
          <p className="nx-cell-dim" style={{ fontSize: 13 }}>No changes recorded yet.</p>
        ) : (
          <ol className="nx-taskhist">
            {entries.map((e) => (
              <li key={e.id}>
                <div>
                  <b>{e.userName ?? (e.userId ? 'Someone' : 'NEXUS (automation)')}</b>{' '}
                  {describe(e, peopleById).map((line, i) => (
                    <span key={i} className="nx-taskhist__line">
                      {line}
                    </span>
                  ))}
                </div>
                <time dateTime={e.at} title={new Date(e.at).toLocaleString()} className="nx-cell-dim">
                  {relativeTime(e.at)}
                </time>
              </li>
            ))}
          </ol>
        ))}
    </div>
  );
}
