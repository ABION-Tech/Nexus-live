import { useEffect, useState } from 'react';
import { Drawer, Button, StatusBadge, Select } from '../../components/ui';
import type { CurrentUser } from '../../services/authService';
import type { Task } from '@nexus/shared';
import { ChatThread } from '../ai-analyst/ChatThread';
import {
  fetchTaskAssignees,
  addTaskAssignee,
  removeTaskAssignee,
  type TaskAssignee,
} from '../../services/taskService';

// Session 35 — the drawer TaskSection.tsx opens on row click: task detail
// on top, an embedded chat thread scoped to this one task underneath.
// The thread itself is just ChatThread (ai-analyst/ChatThread.tsx, the
// component extracted from Chat.tsx in this same pass) rendered with
// `taskId` and `compact`, not a second hand-rolled message list — access
// to it is enforced server-side regardless (routes/chat.ts's own
// authorizeTaskThread — general tasks.read OR assignee/support/
// supervisor, taskService.ts's canViewTaskThread), same "server is the
// real boundary" posture as canEdit/canArchive below being UI-
// convenience-only.
export interface TaskDrawerProps {
  task: Task | null;
  onClose: () => void;
  onEdit: () => void;
  onArchive: () => void;
  canEdit: boolean;
  canArchive: boolean;
  user: CurrentUser;
  peopleById: Map<string, string>;
}

function personLabel(id: string | undefined, peopleById: Map<string, string>): string {
  if (!id) return '—';
  return peopleById.get(id) ?? '—';
}

// 0032_task_assignees.sql — "people on this task" beyond the single
// primary Assigned to/Support fields already shown above. Lives inside
// the drawer (not the create/edit form) because it needs a real task.id
// to call POST/DELETE /tasks/:id/assignees against — a task being
// created has no id yet, so this is add-after-create only, same
// "edit-only surface" shape Session 35's own header comment gives for
// why the drawer and the RelationshipForm modal are two separate things
// here rather than one.
function TaskPeoplePanel({ task, canEdit, peopleById }: { task: Task; canEdit: boolean; peopleById: Map<string, string> }) {
  const [assignees, setAssignees] = useState<TaskAssignee[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingRole, setAddingRole] = useState<'assignee' | 'support'>('assignee');
  const [addingUserId, setAddingUserId] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    fetchTaskAssignees(task.id)
      .then(setAssignees)
      .catch(() => setError("Couldn't load who's on this task."));
  }

  useEffect(() => {
    setAssignees(null);
    setError(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const peopleOptions = Array.from(peopleById.entries()).map(([value, label]) => ({ value, label }));

  async function handleAdd() {
    if (!addingUserId) return;
    setBusy(true);
    try {
      await addTaskAssignee(task.id, addingUserId, addingRole);
      setAddingUserId('');
      load();
    } catch {
      setError("Couldn't add that person — they may already be on this task.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(userId: string, role: 'assignee' | 'support') {
    setBusy(true);
    try {
      await removeTaskAssignee(task.id, userId, role);
      load();
    } catch {
      setError("Couldn't remove that person.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="nx-stack nx-stack--sm">
      <h4 style={{ margin: 0 }}>People on this task</h4>
      {error && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>}
      {assignees === null && !error && <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Loading…</span>}
      {assignees && assignees.length === 0 && (
        <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Just the primary assignee/support above.</span>
      )}
      {assignees && assignees.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {assignees.map((a) => (
            <li
              key={a.id}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}
            >
              <span>
                {peopleById.get(a.userId) ?? '—'}{' '}
                <span style={{ color: 'var(--text-dim)' }}>({a.role === 'support' ? 'Support' : 'Assignee'})</span>
              </span>
              {canEdit && (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => handleRemove(a.userId, a.role)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 4 }}>
          <Select
            options={peopleOptions}
            placeholder="Add someone…"
            value={addingUserId}
            onChange={(e) => setAddingUserId(e.target.value)}
          />
          <Select
            options={[
              { value: 'assignee', label: 'Assignee' },
              { value: 'support', label: 'Support' },
            ]}
            value={addingRole}
            onChange={(e) => setAddingRole(e.target.value as 'assignee' | 'support')}
          />
          <Button size="sm" disabled={busy || !addingUserId} onClick={handleAdd}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

export function TaskDrawer({ task, onClose, onEdit, onArchive, canEdit, canArchive, user, peopleById }: TaskDrawerProps) {
  return (
    <Drawer open={task !== null} onClose={onClose} title={task?.title}>
      {task && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="nx-stack nx-stack--md">
            <StatusBadge status={task.status} />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                columnGap: 12,
                rowGap: 6,
                fontSize: 13,
              }}
            >
              <span style={{ color: 'var(--text-dim)' }}>Assigned to</span>
              <span>{personLabel(task.assignedToUserId, peopleById)}</span>
              <span style={{ color: 'var(--text-dim)' }}>Support</span>
              <span>{personLabel(task.supportUserId, peopleById)}</span>
              <span style={{ color: 'var(--text-dim)' }}>Supervisor</span>
              <span>{personLabel(task.supervisorUserId, peopleById)}</span>
              <span style={{ color: 'var(--text-dim)' }}>Department</span>
              <span>{task.department ?? '—'}</span>
              <span style={{ color: 'var(--text-dim)' }}>Deadline</span>
              <span>{task.deadline ? new Date(task.deadline).toLocaleDateString() : '—'}</span>
            </div>
            {task.description && (
              <p style={{ fontSize: 13, color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>{task.description}</p>
            )}
          </div>

          <div className="nx-row">
            {canEdit && (
              <Button size="sm" variant="secondary" onClick={onEdit}>
                Edit
              </Button>
            )}
            {canArchive && (
              <Button size="sm" variant="danger" onClick={onArchive}>
                Archive
              </Button>
            )}
          </div>

          <TaskPeoplePanel task={task} canEdit={canEdit} peopleById={peopleById} />

          <div className="nx-stack nx-stack--sm">
            <h4 style={{ margin: 0 }}>Discussion</h4>
            {/* `key={task.id}` forces a fresh ChatThread (and its own
                fetch + SSE subscription) whenever the drawer switches to a
                different task, rather than relying on ChatThread's
                internal `taskId` effect dependency alone — cheaper to
                reason about than trusting effect cleanup timing across a
                prop change on a component this drawer doesn't own. */}
            <ChatThread
              key={task.id}
              user={user}
              taskId={task.id}
              compact
              emptyTitle="No messages on this task yet"
              resolveName={(id) => peopleById.get(id)}
            />
          </div>
        </div>
      )}
    </Drawer>
  );
}
