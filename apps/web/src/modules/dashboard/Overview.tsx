// 01 DASHBOARD. Session 58: rebuilt from the original HTML app's "KPI
// Dashboard", on live data (GET /overview). Replaces the placeholder that
// showed hard-coded numbers and invented activity.
//
//   alert bars   blocked tasks, tasks not updated in 2+ days, missing EODs
//   4 numbers    active tasks, partnerships, overdue / at risk, failsafe
//   table        the latest tasks, with progress (checklist), −10 / +10
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Clock, ListChecks, Handshake, CalendarX, ShieldAlert } from 'lucide-react';
import type { TaskPriority, TaskStatus } from '@nexus/shared';
import { Card, ErrorState, LoadingState, PriorityBadge, ProgressBar, StatusBadge, Table, type TableColumn } from '../../components/ui';
import { MyDay } from './MyDay';
import { fetchOverview, shortRef, type Overview as Data, type RecentTask } from '../../services/overviewService';

function fmtDeadline(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });
}

function progressOf(t: RecentTask): number {
  if (t.status === 'done') return 100;
  return t.checklistTotal ? Math.round((t.checklistDone / t.checklistTotal) * 100) : 0;
}

export function Overview() {
  const navigate = useNavigate();
  const [n, setN] = useState(10);
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: Data }>({ status: 'loading' });

  function load() {
    fetchOverview(n)
      .then((data) => setState({ status: 'ready', data }))
      .catch((err: unknown) => setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' }));
  }
  useEffect(load, [n]);

  if (state.status === 'loading') return <LoadingState label="Loading the dashboard…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load the dashboard" description={state.message} onRetry={load} />;

  const { counts: c, recentTasks, today } = state.data;
  const todayLabel = new Date(today + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  const columns: TableColumn<RecentTask>[] = [
    { key: 'id', header: 'ID', render: (t) => <span className="nx-mono-id">{shortRef(t.ref) ?? '—'}</span> },
    { key: 'task', header: 'Task', render: (t) => <span className="nx-cell-strong">{t.title}</span> },
    { key: 'assignee', header: 'Assigned', render: (t) => t.assignee ?? '—' },
    { key: 'priority', header: 'Priority', render: (t) => <PriorityBadge priority={t.priority as TaskPriority} /> },
    {
      key: 'deadline',
      header: 'Deadline',
      render: (t) => {
        const late = t.status !== 'done' && t.deadline && t.deadline.slice(0, 10) < today;
        return <span className={late ? 'nx-late' : undefined}>{fmtDeadline(t.deadline)}</span>;
      },
    },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status as TaskStatus} /> },
    {
      key: 'progress',
      header: 'Progress',
      render: (t) => (
        <span className="nx-progress-cell">
          <span>{progressOf(t)}%</span>
          <ProgressBar value={progressOf(t)} />
        </span>
      ),
    },
    { key: 'notes', header: 'Notes', render: (t) => <span className="nx-cell-dim">{t.notes || '—'}</span> },
  ];

  return (
    <div className="nx-dashboard-overview nx-view-enter nx-kpi">
      <MyDay />
      {c.blocked > 0 && (
        <div className="nx-alertbar nx-alertbar--danger" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <b>{c.blocked} task{c.blocked > 1 ? 's' : ''} blocked</b>
            <span>Immediate attention needed.</span>
          </div>
          <Link className="nx-chipbtn" to="/comms-ops/failsafe-alerts">View blocked</Link>
        </div>
      )}
      {c.stale > 0 && (
        <div className="nx-alertbar nx-alertbar--warn">
          <Clock size={18} aria-hidden="true" />
          <div>
            <b>{c.stale} task{c.stale > 1 ? 's' : ''} not updated in 2+ days</b>
            <span>Nudge the owners or close them.</span>
          </div>
          <Link className="nx-chipbtn" to="/work/follow-ups">View follow-ups</Link>
        </div>
      )}
      {c.missingEod > 0 && (
        <div className="nx-alertbar nx-alertbar--warn">
          <CalendarX size={18} aria-hidden="true" />
          <div>
            <b>{c.missingEod} EOD report{c.missingEod > 1 ? 's' : ''} missing today</b>
            <span>{todayLabel}</span>
          </div>
          <Link className="nx-chipbtn" to="/comms-ops/failsafe-alerts">See who</Link>
        </div>
      )}

      <div className="nx-kpi__stats">
        <button type="button" className="nx-kpi__stat nx-kpi__stat--accent" onClick={() => navigate('/work/team-tasks')}>
          <span className="nx-kpi__icon"><ListChecks size={16} aria-hidden="true" /></span>
          <span className="nx-kpi__n">{c.activeTasks}</span>
          <span className="nx-kpi__l">Active tasks</span>
        </button>
        <button type="button" className="nx-kpi__stat nx-kpi__stat--green" onClick={() => navigate('/network/partnerships')}>
          <span className="nx-kpi__icon"><Handshake size={16} aria-hidden="true" /></span>
          <span className="nx-kpi__n">{c.partnerships}</span>
          <span className="nx-kpi__l">Partnerships</span>
        </button>
        <button type="button" className="nx-kpi__stat nx-kpi__stat--red" onClick={() => navigate('/comms-ops/failsafe-alerts')}>
          <span className="nx-kpi__icon"><CalendarX size={16} aria-hidden="true" /></span>
          <span className="nx-kpi__n">{c.atRisk}</span>
          <span className="nx-kpi__l">Overdue / at risk</span>
        </button>
        <button type="button" className="nx-kpi__stat nx-kpi__stat--amber" onClick={() => navigate('/comms-ops/failsafe-alerts')}>
          <span className="nx-kpi__icon"><ShieldAlert size={16} aria-hidden="true" /></span>
          <span className="nx-kpi__n">{c.failsafe}</span>
          <span className="nx-kpi__l">Failsafe alerts</span>
        </button>
      </div>

      <Card>
        <Table
          exportName="Recent tasks"
          title="Recent tasks"
          toolbar={
            <span className="nx-kpi__step">
              <span>Latest</span>
              <button type="button" className="nx-chipbtn" disabled={n <= 10} onClick={() => setN((x) => Math.max(10, x - 10))}>−10</button>
              <b>{n}</b>
              <button type="button" className="nx-chipbtn" disabled={recentTasks.length < n || n >= 50} onClick={() => setN((x) => Math.min(50, x + 10))}>+10</button>
            </span>
          }
          columns={columns}
          rows={recentTasks}
          rowKey={(t) => t.id}
          onRowClick={() => navigate('/work/team-tasks')}
          defaultHidden={['priority']}
          rowClassName={(t) => (t.status !== 'done' && t.deadline && t.deadline.slice(0, 10) < today ? 'nx-table__row--overdue' : undefined)}
        />
        {recentTasks.length === 0 && <p className="nx-cell-dim" style={{ margin: '12px 0 0' }}>No tasks yet. Create one with the + Task button at the top.</p>}
      </Card>
    </div>
  );
}
