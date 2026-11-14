// 09 COMMS & OPS → Activity Log. Session 58: the original HTML app's
// Activity Log — every EOD filed, by date and person, with what they
// completed, moved forward, achieved, were blocked by and plan next.
// Filter by person and date range; Export CSV and Cols come with the
// table. Leaders see the whole team; anyone else sees their own.
import { useEffect, useMemo, useState } from 'react';
import type { EodLog, Person } from '@nexus/shared';
import { Card, ErrorState, LoadingState, Table, type TableColumn } from '../../components/ui';
import { fetchEodHistory } from '../../services/eodService';
import { fetchPeople } from '../../services/peopleService';
import type { CurrentUser } from '../../services/authService';

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function ActivityLog({ user }: { user: CurrentUser }) {
  const [to, setTo] = useState(() => iso(new Date()));
  const [from, setFrom] = useState(() => iso(new Date(Date.now() - 29 * 86_400_000)));
  const [who, setWho] = useState('');
  const [people, setPeople] = useState<Person[]>([]);
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; logs: EodLog[] }>({ status: 'loading' });
  const leader = user.role === 'leader';

  useEffect(() => {
    fetchPeople().then(setPeople).catch(() => undefined);
  }, []);

  function load() {
    setState({ status: 'loading' });
    fetchEodHistory({ from, to, userId: who || undefined })
      .then((r) => setState({ status: 'ready', logs: r.logs }))
      .catch((err: unknown) => setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' }));
  }
  useEffect(load, [from, to, who]);

  const names = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const text = (v?: string) => <span className="nx-cell-dim" style={{ whiteSpace: 'pre-wrap' }}>{v || '—'}</span>;

  const columns: TableColumn<EodLog>[] = [
    {
      key: 'date',
      header: 'Date',
      render: (l) => {
        const d = new Date(l.date + 'T12:00:00');
        return (
          <span className="nx-task">
            <b>{d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</b>
            <span className="nx-cell-dim">{d.toLocaleDateString('en-GB', { weekday: 'long' })}</span>
          </span>
        );
      },
    },
    { key: 'member', header: 'Team member', render: (l) => <span className="nx-cell-strong">{names.get(l.userId) ?? '—'}</span> },
    { key: 'completed', header: 'Completed (with proof)', render: (l) => text(l.summary) },
    { key: 'moved', header: 'Moved forward', render: (l) => text(l.movedForward) },
    { key: 'achievement', header: 'Key achievement', render: (l) => text(l.keyAchievement) },
    { key: 'blockers', header: 'Blockers', render: (l) => (l.blockers ? <span className="nx-late" style={{ fontWeight: 500 }}>{l.blockers}</span> : text()) },
    { key: 'plan', header: "Tomorrow's plan", render: (l) => text(l.tomorrowPlan) },
    {
      key: 'filed',
      header: 'Filed',
      render: (l) => (
        <span className="nx-tchip">
          {new Date(l.createdAt).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' })}
          {l.filedByUserId !== l.userId ? ` · by ${names.get(l.filedByUserId) ?? 'someone'}` : ''}
        </span>
      ),
    },
  ];

  return (
    <div className="nx-dashboard-overview nx-view-enter">
      <Card className="nx-filterbar">
        {leader && (
          <label>
            <span>Team member</span>
            <select className="nx-select" value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Everyone</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <label>
          <span>From</span>
          <input className="nx-input" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </label>
        <label>
          <span>To</span>
          <input className="nx-input" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </label>
      </Card>

      <Card>
        {state.status === 'loading' && <LoadingState label="Loading the activity log…" />}
        {state.status === 'error' && <ErrorState title="Couldn't load the activity log" description={state.message} onRetry={load} />}
        {state.status === 'ready' &&
          (state.logs.length === 0 ? (
            <p className="nx-cell-dim" style={{ margin: 0 }}>No EODs filed in this period.</p>
          ) : (
            <Table
              exportName="Activity log"
              title={<span>EOD reports <span className="nx-cell-dim">· {state.logs.length}</span></span>}
              defaultHidden={['moved']}
              columns={columns}
              rows={state.logs}
              rowKey={(l) => l.id}
            />
          ))}
      </Card>
    </div>
  );
}
