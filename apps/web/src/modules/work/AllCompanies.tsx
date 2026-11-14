// Session 57 — 02 WORK → All my companies. Your tasks from every company
// you work in, on one page. Each company only ever sees its own work;
// this view exists only for you.
//
// Picking one company turns the page into a clean view of just that
// company's tasks (no other company's name appears anywhere on it), so
// you can screenshot it and send it to that team.
import { useEffect, useMemo, useState } from 'react';
import type { CrossCompanyTask, TaskPriority, TaskStatus } from '@nexus/shared';
import { Card, EmptyState, ErrorState, LoadingState, PriorityBadge, StatusBadge, Table, useToast, type TableColumn } from '../../components/ui';
import { useWorkspaces } from '../../components/navigation/WorkspaceContext';
import { fetchMyWork, type MyWork } from '../../services/workspaceService';
import type { CurrentUser } from '../../services/authService';

const PART: Record<CrossCompanyTask['role'], string> = { owner: 'Owner', support: 'Support', supervisor: 'Supervisor' };

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function AllCompanies({ user }: { user: CurrentUser }) {
  const { switchTo } = useWorkspaces();
  const { show } = useToast();
  const [company, setCompany] = useState<string>('all');
  const [includeDone, setIncludeDone] = useState(false);
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: MyWork }>({
    status: 'loading',
  });

  function load() {
    setState({ status: 'loading' });
    fetchMyWork({ includeDone })
      .then((data) => setState({ status: 'ready', data }))
      .catch((err: unknown) => setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' }));
  }
  useEffect(load, [includeDone]);

  const data = state.status === 'ready' ? state.data : null;
  const one = company !== 'all' ? data?.companies.find((c) => c.id === company) : undefined;
  const rows = useMemo(() => (data ? data.tasks.filter((t) => company === 'all' || t.company.id === company) : []), [data, company]);
  const now = today();

  const columns: TableColumn<CrossCompanyTask>[] = [
    { key: 'title', header: 'Task', render: (r) => <span className="nx-allwork__title">{r.title}</span> },
    ...(one ? [] : [{ key: 'company', header: 'Company', render: (r: CrossCompanyTask) => <span className="nx-allwork__co">{r.company.name}</span> }]),
    { key: 'part', header: 'Your part', render: (r) => PART[r.role] },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status as TaskStatus} /> },
    { key: 'priority', header: 'Priority', render: (r) => <PriorityBadge priority={r.priority as TaskPriority} /> },
    { key: 'deadline', header: 'Deadline', render: (r) => fmtDate(r.deadline) },
  ];

  async function open(t: CrossCompanyTask) {
    if (t.company.id === user.orgId) {
      window.location.assign('/work/my-tasks');
      return;
    }
    try {
      await switchTo(t.company.id, '/work/my-tasks');
    } catch (err) {
      show(err instanceof Error ? err.message : `Couldn't open ${t.company.name}.`, 'danger');
    }
  }

  const openCount = rows.filter((r) => r.status !== 'done').length;
  const overdue = rows.filter((r) => r.status !== 'done' && r.deadline && r.deadline.slice(0, 10) < now).length;

  return (
    <div className="nx-dashboard-overview nx-view-enter nx-allwork">
      <h1 className="nx-allwork__h1">{one ? `My tasks · ${one.name}` : 'All my companies'}</h1>
      <p className="nx-allwork__lede">
        {one
          ? `${openCount} open${overdue ? `, ${overdue} overdue` : ''}. Only ${one.name} tasks are on this page.`
          : 'Your tasks from every company you work in. Each company only sees its own; this page is just for you.'}
      </p>

      <div className="nx-allwork__bar">
        <label className="nx-allwork__pick">
          <span>Company</span>
          <select className="nx-select" value={company} onChange={(e) => setCompany(e.target.value)} disabled={!data}>
            <option value="all">All companies</option>
            {data?.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="nx-allwork__check">
          <input type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.target.checked)} />
          <span>Show done</span>
        </label>
        {!one && data && data.companies.length > 1 && (
          <span className="nx-allwork__hint">Pick one company for a view you can screenshot for that team.</span>
        )}
      </div>

      {!one && data && data.companies.length > 1 && (
        <div className="nx-allwork__tiles">
          {data.companies.map((c) => (
            <button key={c.id} type="button" className="nx-allwork__tile" onClick={() => setCompany(c.id)}>
              <span className="nx-allwork__tile-n">{c.open}</span>
              <span className="nx-allwork__tile-l">open in {c.name}</span>
            </button>
          ))}
        </div>
      )}

      <Card>
        {state.status === 'loading' && <LoadingState label="Gathering your tasks…" />}
        {state.status === 'error' && <ErrorState title="Couldn't load your tasks" description={state.message} onRetry={load} />}
        {state.status === 'ready' &&
          (rows.length === 0 ? (
            <EmptyState
              title={includeDone ? 'No tasks here' : 'Nothing open'}
              description={one ? `Nothing assigned to you in ${one.name} right now.` : 'Nothing is assigned to you in any of your companies right now.'}
            />
          ) : (
            <Table
              columns={columns}
              rows={rows}
              rowKey={(r) => `${r.company.id}:${r.id}`}
              onRowClick={open}
              rowClassName={(r) => (r.status !== 'done' && r.deadline && r.deadline.slice(0, 10) < now ? 'nx-table__row--overdue' : undefined)}
            />
          ))}
      </Card>
      {state.status === 'ready' && rows.length > 0 && (
        <p className="nx-allwork__foot">Tap a task to open it in its company.</p>
      )}
    </div>
  );
}
