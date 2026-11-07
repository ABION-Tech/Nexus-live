import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Badge, Button, Select, LoadingState, ErrorState, EmptyState } from '../../components/ui';
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
            <div className="nx-stack nx-stack--sm">
              {filtered.map((item) => (
                <Link
                  key={item.id}
                  to={`/comms-ops/marketing/${item.id}`}
                  style={{ textDecoration: 'none', color: 'inherit' }}
                >
                  <Card interactive style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                      <strong>{item.contentType || 'Untitled content'}</strong>
                      <Badge tone={statusTone(item.status)}>
                        {STATUS_OPTIONS.find((s) => s.value === item.status)?.label ?? item.status}
                      </Badge>
                    </div>
                    <div style={{ opacity: 0.75, fontSize: 13 }}>
                      {item.platform && <span>{item.platform}</span>}
                      {item.platform && item.dueDate && <span> · </span>}
                      {item.dueDate && <span>Due {item.dueDate}</span>}
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
