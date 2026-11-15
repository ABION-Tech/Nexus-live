import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Card, Modal, StatusBadge, PriorityBadge, ProgressBar, LoadingState, ErrorState, useToast } from '../../components/ui';
import { RelationshipTable, RelationshipForm, type FieldSchema, type TableColumn } from '../../components/network';
import { ApiError, QueuedOfflineError } from '../../services/apiClient';
import { TaskDrawer } from './TaskDrawer';
import { archiveTask, createTask, updateTask, type TaskCreateInput, type TaskUpdateInput } from '../../services/taskService';
import { fetchPeople } from '../../services/peopleService';
import type { CurrentUser } from '../../services/authService';
import type { Task, TaskPriority, TaskStatus, Person } from '@nexus/shared';
import { useQuickAdd } from '../../components/navigation/quickAdd';

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
const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

function buildSchema(peopleOptions: { value: string; label: string }[], taskOptions: { value: string; label: string }[]): FieldSchema<Task>[] {
  return [
    { key: 'title', label: 'Title', type: 'text', required: true, leaderOnly: true },
    { key: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS, required: true },
    // Session 58: priority, start date and depends-on, as on the original
    // HTML app's task form (the API accepted them; the form never asked).
    { key: 'priority', label: 'Priority', type: 'select', options: PRIORITY_OPTIONS, leaderOnly: true },
    { key: 'description', label: 'Description / notes', type: 'textarea' },
    { key: 'assignedToUserId', label: 'Assigned to', type: 'select', options: peopleOptions, leaderOnly: true },
    { key: 'supportUserId', label: 'Support', type: 'select', options: peopleOptions, leaderOnly: true },
    { key: 'supervisorUserId', label: 'Supervisor', type: 'select', options: peopleOptions, leaderOnly: true },
    { key: 'business', label: 'Business', type: 'text', leaderOnly: true },
    { key: 'department', label: 'Department', type: 'text', leaderOnly: true },
    { key: 'startDate', label: 'Start date', type: 'date', leaderOnly: true },
    { key: 'deadline', label: 'Deadline', type: 'date', leaderOnly: true },
    { key: 'dependsOnTaskId', label: 'Depends on', type: 'select', options: taskOptions, leaderOnly: true },
    // Session 60 (C-11, 0047).
    { key: 'recurrence', label: 'Repeats', type: 'select', options: REPEAT_OPTIONS, leaderOnly: true },
    { key: 'followUpHours', label: 'Nudge if no update for (hours)', type: 'number', leaderOnly: true },
  ];
}

const REPEAT_OPTIONS = [
  { value: '', label: "Doesn't repeat" },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Every weekday (Mon–Fri)' },
  { value: 'weekly', label: 'Every week, same day' },
  { value: 'monthly', label: 'Every month, same date' },
];

/** Session 60: only the fields the form edits, with "empty" sent as null
 * (clear it) on edit and left out on create. The form used to send the
 * whole task — id, createdAt, ref … — and the server rejected every edit. */
function formPayload(values: Record<string, unknown>, mode: 'create' | 'edit'): Record<string, unknown> {
  const keys = buildSchema([], []).map((f) => f.key as string);
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (!(k in values)) continue;
    let v = values[k];
    if (v === '' || v === undefined || (typeof v === 'number' && Number.isNaN(v))) v = null;
    if (v === null && mode === 'create') continue;
    out[k] = v;
  }
  return out;
}

export interface TaskSectionProps {
  title: string;
  emptyTitle: string;
  newLabel: string;
  user: CurrentUser;
  fetchList: () => Promise<Task[]>;
  /** Session 58 — shown above the filters (Follow-Ups' tracker panels). */
  header?: React.ReactNode;
  /** Session 58 — add "Last updated" and "Days stale" (Follow-Ups). */
  showStale?: boolean;
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
export function TaskSection({ title, emptyTitle, newLabel, user, fetchList, header, showStale = false }: TaskSectionProps) {
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
  useQuickAdd(() => setFormModal({ mode: 'create' }));

  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const peopleOptions = useMemo(() => people.map((p) => ({ value: p.id, label: p.name })), [people]);
  const allRows = useMemo(() => (state.status === 'ready' ? state.rows : []), [state]);
  const taskOptions = useMemo(
    () => allRows.map((t) => ({ value: t.id, label: `${t.ref ? t.ref + ' · ' : ''}${t.title}`.slice(0, 80) })),
    [allRows]
  );
  const schema = useMemo(() => buildSchema(peopleOptions, taskOptions), [peopleOptions, taskOptions]);

  // Session 58 — Master Tasks as in the original HTML app: search, the
  // five filters, sort, and every column it showed.
  const [f, setF] = useState({ q: '', status: '', assignee: '', priority: '', dept: '', support: '' });
  const [sort, setSort] = useState<'newest' | 'deadline' | 'priority'>('newest');
  const filtersOn = Object.values(f).some(Boolean);
  const byId = useMemo(() => new Map(allRows.map((t) => [t.id, t])), [allRows]);
  const blocking = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of allRows) if (t.dependsOnTaskId && t.status !== 'done') m.set(t.dependsOnTaskId, (m.get(t.dependsOnTaskId) ?? 0) + 1);
    return m;
  }, [allRows]);
  const depts = useMemo(() => [...new Set(allRows.map((t) => t.department).filter(Boolean) as string[])].sort(), [allRows]);
  const rows = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    const out = allRows.filter(
      (t) =>
        (!q || [t.title, t.ref, t.description, t.assignedToUserId && peopleById.get(t.assignedToUserId)].some((x) => x && String(x).toLowerCase().includes(q))) &&
        (!f.status || t.status === f.status) &&
        (!f.assignee || t.assignedToUserId === f.assignee) &&
        (!f.priority || t.priority === f.priority) &&
        (!f.dept || t.department === f.dept) &&
        (!f.support || t.supportUserId === f.support)
    );
    if (sort === 'deadline') out.sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999'));
    if (sort === 'priority') out.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9));
    return out;
  }, [allRows, f, sort, peopleById]);

  const daysSince = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
  const progress = (t: Task) => (t.status === 'done' ? 100 : t.checklistTotal ? Math.round(((t.checklistDone ?? 0) / t.checklistTotal) * 100) : 0);
  const isLate = (t: Task) => t.status !== 'done' && !!t.deadline && new Date(t.deadline).getTime() < Date.now();
  const name = (id?: string) => (id ? peopleById.get(id) ?? '—' : '—');

  const columns: TableColumn<Task>[] = [
    { key: 'id', header: 'ID', render: (r) => <span className="nx-mono-id">{r.ref && /^[A-Z]{1,6}-?\d{1,5}$/.test(r.ref) ? r.ref : '—'}</span> },
    {
      key: 'title',
      header: 'Task',
      render: (r) => {
        const dep = r.dependsOnTaskId ? byId.get(r.dependsOnTaskId) : undefined;
        const blocks = blocking.get(r.id) ?? 0;
        return (
          <span className="nx-task">
            <span className="nx-task__title">{r.title}</span>
            <span className="nx-task__chips">
              {r.status !== 'done' && <span className={'nx-tchip' + (daysSince(r.createdAt) > 30 ? ' nx-tchip--red' : '')} title="Days since created">{daysSince(r.createdAt)}d</span>}
              {!!r.checklistTotal && <span className="nx-tchip" title="Checklist">✓ {r.checklistDone ?? 0}/{r.checklistTotal}</span>}
              {r.recurrence && <span className="nx-tchip" title={`Repeats ${r.recurrence}: a fresh copy each day it's due`}>↻ {r.recurrence}</span>}
              {r.followUpHours && <span className="nx-tchip" title={`Nudges the assignee after ${r.followUpHours}h without an update`}>⏱ {r.followUpHours}h</span>}
              {r.dependsOnTaskId && (
                <span className={'nx-tchip' + (dep && dep.status !== 'done' ? ' nx-tchip--red' : '')} title={dep ? `Depends on: ${dep.title}` : 'Depends on another task'}>
                  ⛓ {dep?.ref ?? (dep ? dep.title.slice(0, 18) + '…' : 'task')}
                </span>
              )}
              {blocks > 0 && <span className="nx-tchip nx-tchip--red" title="Tasks waiting on this one">⚠ blocking {blocks}</span>}
            </span>
          </span>
        );
      },
    },
    { key: 'priority', header: 'Priority', render: (r) => <PriorityBadge priority={r.priority} /> },
    { key: 'assignedTo', header: 'Assigned to', render: (r) => name(r.assignedToUserId) },
    { key: 'supervisor', header: 'Supervisor', render: (r) => name(r.supervisorUserId) },
    { key: 'support', header: 'Support', render: (r) => name(r.supportUserId) },
    { key: 'department', header: 'Dept', render: (r) => r.department ?? r.business ?? '—' },
    {
      key: 'deadline',
      header: 'Deadline',
      render: (r) =>
        r.deadline ? (
          <span className={isLate(r) ? 'nx-late' : undefined}>
            {new Date(r.deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' })}
          </span>
        ) : (
          '—'
        ),
    },
    ...(showStale
      ? [
          {
            key: 'updated',
            header: 'Last updated',
            render: (r: Task) => new Date(r.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' }),
          },
          {
            key: 'stale',
            header: 'Days stale',
            render: (r: Task) => {
              const d = daysSince(r.updatedAt);
              return <span className={'nx-tchip' + (d >= 2 ? ' nx-tchip--red' : '')}>{d}d</span>;
            },
          },
        ]
      : []),
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'progress',
      header: 'Progress',
      render: (r) => (
        <span className="nx-progress-cell">
          <span>{progress(r)}%</span>
          <ProgressBar value={progress(r)} />
        </span>
      ),
    },
    {
      key: 'edit',
      header: '',
      render: (r) =>
        canEditTask(r) ? (
          <button
            type="button"
            className="nx-chipbtn"
            onClick={(e) => {
              e.stopPropagation();
              setFormModal({ mode: 'edit', row: r });
            }}
          >
            Edit
          </button>
        ) : null,
    },
  ];

  function errorMessage(err: unknown): string {
    if (err instanceof ApiError) return err.message;
    return err instanceof Error ? err.message : 'Something went wrong.';
  }

  async function handleCreate(values: Record<string, unknown>) {
    setSaving(true);
    try {
      await createTask(formPayload(values, 'create') as unknown as TaskCreateInput);
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
      const updated = await updateTask(id, formPayload(values, 'edit') as TaskUpdateInput);
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
      {header}

      <Card className="nx-filterbar">
        <label className="nx-filterbar__search">
          <span>Search</span>
          <input className="nx-input" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Task, ID or person…" />
        </label>
        <label>
          <span>Status</span>
          <select className="nx-select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="">All</option>
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label>
          <span>Assignee</span>
          <select className="nx-select" value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
            <option value="">All</option>
            <option value={user.id}>— My tasks —</option>
            {peopleOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label>
          <span>Priority</span>
          <select className="nx-select" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
            <option value="">All</option>
            {PRIORITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label>
          <span>Dept</span>
          <select className="nx-select" value={f.dept} onChange={(e) => setF({ ...f, dept: e.target.value })}>
            <option value="">All</option>
            {depts.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label>
          <span>Support</span>
          <select className="nx-select" value={f.support} onChange={(e) => setF({ ...f, support: e.target.value })}>
            <option value="">All</option>
            {peopleOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {filtersOn && (
          <button type="button" className="nx-chipbtn nx-filterbar__clear" onClick={() => setF({ q: '', status: '', assignee: '', priority: '', dept: '', support: '' })}>
            × Clear
          </button>
        )}
      </Card>

      <Card>
        {state.status === 'loading' && <LoadingState label={`Loading ${title.toLowerCase()}…`} />}
        {state.status === 'error' && (
          <ErrorState title={`Couldn't load ${title.toLowerCase()}`} description={state.message} onRetry={load} />
        )}
        {state.status === 'ready' && (
          <RelationshipTable
            exportName={title}
            title={
              <span>
                {title} <span className="nx-cell-dim">· {rows.length}{filtersOn ? ` of ${allRows.length}` : ''}</span>
              </span>
            }
            toolbar={
              <select className="nx-select nx-select--sm" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
                <option value="newest">Newest added</option>
                <option value="deadline">Deadline</option>
                <option value="priority">Priority</option>
              </select>
            }
            defaultHidden={['support']}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            onRowClick={(row) => setDrawerTask(row)}
            emptyTitle={filtersOn ? 'Nothing matches these filters' : emptyTitle}
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
