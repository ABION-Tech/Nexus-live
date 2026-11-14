import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Card, Badge, Button, Select, LoadingState, ErrorState, EmptyState, Table, type TableColumn } from '../../components/ui';
import { fetchPeople } from '../../services/peopleService';
import { fetchMarketingContent } from '../../services/marketingService';
import type { MarketingContentItem, MarketingContentStatus } from '@nexus/shared';

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: MarketingContentItem[] };

const STATUS_OPTIONS: { value: MarketingContentStatus; label: string }[] = [
  { value: 'planned', label: 'Planned' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'posted', label: 'Posted' },
  { value: 'skipped', label: 'Skipped' },
];

function statusTone(status: MarketingContentStatus): 'neutral' | 'info' | 'success' | 'danger' {
  if (status === 'posted') return 'success';
  if (status === 'in_progress') return 'info';
  if (status === 'skipped') return 'danger';
  return 'neutral';
}

// PRD §7.2 09 COMMS & OPS → Marketing / §8.9 content calendar. Each item
// is a task broken into three stages (Script → Production → SMM,
// marketingService.ts) — this list shows the calendar-level view (what/
// where/when/overall status); per-stage assignment and progress live on
// the drill-in (MarketingEdit.tsx), same "list is flat, detail has the
// tasks" split ActiveGoals/GoalDetail already use for Goals.
export function Marketing() {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [statusFilter, setStatusFilter] = useState('');
  const navigate = useNavigate();
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    fetchPeople().then((p) => setNames(new Map(p.map((x) => [x.id, x.name])))).catch(() => undefined);
  }, []);
  const today = new Date().toISOString().slice(0, 10);

  // Session 58: a table as on the original HTML app — the caption itself,
  // who owns it, and the post link, not just the content type.
  const columns: TableColumn<MarketingContentItem>[] = [
    { key: 'type', header: 'Type', render: (r) => <span className="nx-tchip">{r.contentType || '—'}</span> },
    { key: 'caption', header: 'Topic / caption', render: (r) => <span className="nx-cell-strong">{r.caption || <span className="nx-cell-dim">No caption yet</span>}</span> },
    { key: 'platform', header: 'Platform', render: (r) => r.platform ?? '—' },
    { key: 'owner', header: 'Assigned', render: (r) => (r.ownerUserId ? names.get(r.ownerUserId) ?? '—' : '—') },
    {
      key: 'due',
      header: 'Due',
      render: (r) =>
        r.dueDate ? (
          <span className={r.status !== 'posted' && r.dueDate.slice(0, 10) < today ? 'nx-late' : undefined}>
            {new Date(r.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
          </span>
        ) : (
          '—'
        ),
    },
    { key: 'status', header: 'Status', render: (r) => <Badge tone={statusTone(r.status)}>{STATUS_OPTIONS.find((s) => s.value === r.status)?.label ?? r.status}</Badge> },
    {
      key: 'link',
      header: 'Link',
      render: (r) =>
        r.postLink ? (
          <a className="nx-link" href={r.postLink} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            Open ↗
          </a>
        ) : (
          '—'
        ),
    },
  ];

  function load() {
    setState({ status: 'loading' });
    fetchMarketingContent()
      .then((items) => setState({ status: 'ready', items }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setState({ status: 'error', message });
      });
  }

  useEffect(load, []);

  const filtered = useMemo(() => {
    if (state.status !== 'ready') return [];
    if (!statusFilter) return state.items;
    return state.items.filter((i) => i.status === statusFilter);
  }, [state, statusFilter]);

  return (
    <div className="nx-page nx-view-enter">
      <div className="nx-row nx-row--between">
        <h2>Marketing</h2>
        <Link to="/comms-ops/marketing/new">
          <Button>New content</Button>
        </Link>
      </div>

      {state.status === 'loading' && <LoadingState label="Loading content calendar…" />}
      {state.status === 'error' && (
        <ErrorState title="Couldn't load Marketing" description={state.message} onRetry={load} />
      )}

      {state.status === 'ready' && (
        <>
          <div style={{ width: 200 }}>
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              placeholder="All statuses"
              options={STATUS_OPTIONS}
            />
          </div>

          {filtered.length === 0 && (
            <EmptyState
              title={state.items.length === 0 ? 'No content planned yet' : 'No matches'}
              description={
                state.items.length === 0
                  ? 'Add the first piece of content — it\u2019s broken into script, production, and SMM stages automatically.'
                  : 'Try a different status filter.'
              }
              action={
                state.items.length === 0 ? (
                  <Link to="/comms-ops/marketing/new"><Button>New content</Button></Link>
                ) : undefined
              }
            />
          )}

          {filtered.length > 0 && (
            <Card>
              <Table
                exportName="Marketing"
                title={<span>Content calendar <span className="nx-cell-dim">· {filtered.length}</span></span>}
                columns={columns}
                rows={filtered}
                rowKey={(r) => r.id}
                onRowClick={(r) => navigate(`/comms-ops/marketing/${r.id}`)}
                rowClassName={(r) => (r.status !== 'posted' && r.dueDate && r.dueDate.slice(0, 10) < today ? 'nx-table__row--overdue' : undefined)}
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
