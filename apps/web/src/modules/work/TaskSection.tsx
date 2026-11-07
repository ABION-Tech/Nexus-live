import { useEffect, useMemo, useState } from 'react';
import { Card, Button, Modal, StatusBadge, LoadingState, ErrorState, useToast } from '../../components/ui';
import { RelationshipTable, RelationshipForm, type FieldSchema, type TableColumn } from '../../components/network';
import { ApiError, QueuedOfflineError } from '../../services/apiClient';
import { TaskDrawer } from './TaskDrawer';
import { archiveTask, createTask, fetchTasks, updateTask, type TaskCreateInput, type TaskUpdateInput } from '../../services/taskService';
import { fetchPeople } from '../../services/peopleService';
import type { CurrentUser } from '../../services/authService';
import type { Task, TaskStatus, Person } from '@nexus/shared';

const STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
];

// PRD §13.3's own example grant: `Team Member → tasks.own → read, update
// (status, notes only)` — routes/tasks.ts's OWN_UPDATE_FIELDS enforces
// exactly `status` + `description` for an own-record caller with no flat
// `tasks.update` grant, silently stripping everything else. `leaderOnly`
// here mirrors that on every other field (including `title`, unlike
// Partnerships — a team member can't even rename their own task, per the
// backend's own restriction) so the UI shows the same shape the server
// will actually accept, not a wider one. Same UX-only caveat as
// Partnerships.tsx's schema: this is a convenience read of `isLeader`,
// not the real security boundary — the server enforces the real one
// regardless of what this form allows through.
function buildSchema(peopleOptions: { value: string; label: string }[]): FieldSchema<Task>[] {
  return [
    { key: 'title', label: 'Title', type: 'text', required: true, leaderOnly: true },
    { key: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS, required: true },
    { key: 'description', label: 'Description / notes', type: 'textarea' },
    { key: 'assignedToUserId', label: 'Assigned to', type: 'select', options: peopleOptions, leaderOnly: true },
    { key: 'supportUserId', label: 'Support', type: 'select', options: peopleOptions, leaderOnly: true },
    { key: 'supervisorUserId', label: 'Supervisor', type: 'select', options: peopleOptions, leaderOnly: true },
    { key: 'business', label: 'Business', type: 'text', leaderOnly: true },
    { key: 'department', label: 'Department', type: 'text', leaderOnly: true },
    { key: 'deadline', label: 'Deadline', type: 'date', leaderOnly: true },
  ];
}

export interface TaskSectionProps {
  title: string;
  emptyTitle: string;
  newLabel: string;
  user: CurrentUser;
  fetchList: () => Promise<Task[]>;
}

// Session 35 rewrite: tasks used to go through the same generic
// CrudSection every Network subsection uses (row click → edit modal
// directly). That stops working once a task row click needs to open a
// drawer with detail + an embedded chat thread instead — CrudSection
// owns its modal state privately and has no concept of a drawer, and
// widening it for one caller would have meant threading drawer-specific
// props through a component three other, unrelated sections still use
// exactly as-is. So this file now owns its own list/create/edit/archive
// state directly (a small, deliberate duplication of CrudSection's
// logic, not a shared abstraction stretched to fit) — row click opens
// TaskDrawer (view + chat); "New task" and the drawer's own "Edit"
// button both open the same RelationshipForm modal this always used.
export function TaskSection({ title, emptyTitle, newLabel, user, fetchList }: TaskSectionProps) {
  const { show } = useToast();
  const [people, setPeople] = useState<Person[]>([]);
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; rows: Task[] }
  >({ status: 'loading' });
  const [drawerTask, setDrawerTask] = useState<Task | null>(null);
  const [formModal, setFormModal] = useState<{ mode: 'create' } | { mode: 'edit'; row: Task } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPeople()
      .then((rows) => { if (!cancelled) setPeople(rows); })
      .catch(() => { /* picker just renders empty — same degrade as Partnerships.tsx */ });
    return () => { cancelled = true; };
  }, []);

  function load() {
    setState({ status: 'loading' });
    fetchList()
      .then((rows) => setState({ status: 'ready', rows }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setState({ status: 'error', message });
      });
  }

  useEffect(load, []);

  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const peopleOptions = useMemo(() => people.map((p) => ({ value: p.id, label: p.name })), [people]);
  const schema = useMemo(() => buildSchema(peopleOptions), [peopleOptions]);

  const columns: TableColumn<Task>[] = [
    { key: 'title', header: 'Title', render: (r) => r.title },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'assignedTo', header: 'Assigned to', render: (r) => (r.assignedToUserId ? peopleById.get(r.assignedToUserId) ?? '—' : '—') },
    { key: 'support', header: 'Support', render: (r) => (r.supportUserId ? peopleById.get(r.supportUserId) ?? '—' : '—') },
    { key: 'department', header: 'Department', render: (r) => r.department ?? '—' },
    { key: 'deadline', header: 'Deadline', render: (r) => (r.deadline ? new Date(r.deadline).toLocaleDateString() : '—') },
  ];

  function errorMessage(err: unknown): string {
    if (err instanceof ApiError) return err.message;
    return err instanceof Error ? err.message : 'Something went wrong.';
  }

  async function handleCreate(values: Record<string, unknown>) {
    setSaving(true);
    try {
      await createTask(values as unknown as TaskCreateInput);
      show('Created.', 'success');
      setFormModal(null);
      load();
    } catch (err) {
      // PRD §15 Phase J — createTask (taskService.ts) throws this
      // instead of resolving when offline; there's no real Task back
      // from the server yet, so this closes the modal and shows a
      // neutral (not danger) toast rather than treating it as a
      // failure. `load()` deliberately isn't called here — the queued
      // task doesn't exist server-side yet, so a reload would just
      // show the list unchanged, not reflect what the user believes
      // just happened; the next real `load()` (a manual refresh, or
      // the drain's own toast surfacing separately via App.tsx) is
      // what will actually show it.
      if (err instanceof QueuedOfflineError) {
        show(err.message, 'default');
        setFormModal(null);
        return;
      }
      show(errorMessage(err), 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(id: string, values: Record<string, unknown>) {
    setSaving(true);
    try {
      const updated = await updateTask(id, values as TaskUpdateInput);
      show('Saved.', 'success');
      setFormModal(null);
      // Keeps an open drawer in sync with the edit that was just made,
      // instead of showing stale detail until the next full reload.
      setDrawerTask((prev) => (prev && prev.id === id ? updated : prev));
      load();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive(id: string) {
    setSaving(true);
    try {
      await archiveTask(id);
      show('Archived.', 'success');
      setFormModal(null);
      setDrawerTask(null);
      load();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setSaving(false);
    }
  }

  // Same UX-only convenience gate as the rest of this file's schema
  // (`leaderOnly`) — the real enforcement is routes/tasks.ts's own
  // `hasPermission`/`isOwnTask` check, this just decides which buttons
  // this component bothers to show.
  function canEditTask(task: Task): boolean {
    return user.role === 'leader' || task.assignedToUserId === user.id;
  }

  // UI Rehaul polish pass — index.html tinted a whole task row by status
  // rather than relying on the StatusBadge column alone; a row you don't
  // have to read the badge cell of to spot at a glance is real signal at
  // list-scanning size. "At risk" mirrors ESCALATION_TIERS' own
  // definition (PRD §8.2 Follow-Ups): due within 48h and not done.
  function rowClassName(task: Task): string | undefined {
    if (task.status === 'done') return 'nx-table__row--done';
    if (task.deadline) {
      const dueMs = new Date(task.deadline).getTime() - Date.now();
      if (dueMs < 0) return 'nx-table__row--overdue';
      if (dueMs < 48 * 60 * 60 * 1000) return 'nx-table__row--at-risk';
    }
    return undefined;
  }

  return (
    <div className="nx-dashboard-overview nx-view-enter">
      <div className="nx-app-main__header" style={{ padding: 0, marginBottom: 16 }}>
        <h1>{title}</h1>
        <Button size="sm" onClick={() => setFormModal({ mode: 'create' })}>
          {newLabel}
        </Button>
      </div>

      <Card>
        {state.status === 'loading' && <LoadingState label={`Loading ${title.toLowerCase()}…`} />}
        {state.status === 'error' && (
          <ErrorState title={`Couldn't load ${title.toLowerCase()}`} description={state.message} onRetry={load} />
        )}
        {state.status === 'ready' && (
          <RelationshipTable
            columns={columns}
            rows={state.rows}
            rowKey={(row) => row.id}
            onRowClick={(row) => setDrawerTask(row)}
            emptyTitle={emptyTitle}
            rowClassName={rowClassName}
          />
        )}
      </Card>

      <TaskDrawer
        task={drawerTask}
        onClose={() => setDrawerTask(null)}
        onEdit={() => drawerTask && setFormModal({ mode: 'edit', row: drawerTask })}
        onArchive={() => drawerTask && handleArchive(drawerTask.id)}
        canEdit={drawerTask ? canEditTask(drawerTask) : false}
        canArchive={drawerTask ? canEditTask(drawerTask) : false}
        user={user}
        peopleById={peopleById}
      />

      <Modal
        open={formModal !== null}
        onClose={() => setFormModal(null)}
        title={formModal?.mode === 'create' ? newLabel : 'Edit task'}
      >
        {formModal && (
          <RelationshipForm<Task>
            schema={schema}
            mode={formModal.mode}
            initialValues={formModal.mode === 'edit' ? formModal.row : {}}
            isLeader={user.role === 'leader'}
            saving={saving}
            onCancel={() => setFormModal(null)}
            onSubmit={(values) =>
              formModal.mode === 'create' ? handleCreate(values) : handleUpdate(formModal.row.id, values)
            }
          />
        )}
      </Modal>
    </div>
  );
}
