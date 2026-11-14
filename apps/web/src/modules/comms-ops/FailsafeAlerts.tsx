import { useEffect, useState } from 'react';
import { Badge, ErrorState, LoadingState, StatusBadge } from '../../components/ui';
import { fetchBlockedTasks, fetchStalePartnerFollowUps, fetchUpcomingDeadlines } from '../../services/analyticsService';
import { fetchMissingEod } from '../../services/eodService';
import { fetchPeople } from '../../services/peopleService';
import type { MissingEodUser, Partnership, Task } from '@nexus/shared';

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

interface AlertsData {
  blocked: Task[];
  deadlines: Task[];
  missingEod: MissingEodUser[];
  partners: Partnership[];
}

// PRD §7.2 09 COMMS & OPS → Failsafe Alerts / §8.9. "Four categorized
// alert tables (blocked tasks, upcoming deadlines, missing EOD, stale
// partner follow-ups). Render as four distinct components, not one
// generic alert feed." All four already exist as backend queries
// (analyticsService.ts's getBlockedTasks/getUpcomingDeadlines,
// networkService.ts's getStalePartnerFollowUps, eodService.ts's
// getMissingEod) — this is their first shared UI, first-class here
// rather than folded into Analytics per §8.9's own note.
export function FailsafeAlerts() {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [data, setData] = useState<AlertsData | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  function loadAll() {
    setLoad({ status: 'loading' });
    Promise.all([fetchBlockedTasks(), fetchUpcomingDeadlines(), fetchMissingEod(), fetchStalePartnerFollowUps()])
      .then(([blocked, deadlines, missingEod, partners]) => {
        setData({ blocked, deadlines, missingEod, partners });
        setLoad({ status: 'ready' });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setLoad({ status: 'error', message });
      });
  }

  useEffect(loadAll, []);
  useEffect(() => {
    fetchPeople().then((p) => setNames(new Map(p.map((x) => [x.id, x.name])))).catch(() => undefined);
  }, []);

  if (load.status === 'loading') return <LoadingState label="Loading alerts…" />;
  if (load.status === 'error') return <ErrorState title="Couldn't load Failsafe Alerts" description={load.message} onRetry={loadAll} />;
  if (!data) return null;

  const name = (id?: string) => (id ? names.get(id) ?? '—' : 'Unassigned');
  const now = Date.now();
  const daysLate = (iso?: string) => (iso ? Math.floor((now - new Date(iso).getTime()) / 86_400_000) : 0);
  const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' }) : '—');
  const total = data.blocked.length + data.deadlines.length + data.missingEod.length + data.partners.length;

  return (
    <div className="nx-dashboard-overview nx-view-enter">
      <p className="nx-allwork__lede" style={{ margin: 0 }}>
        {total === 0 ? 'Nothing needs rescuing right now.' : `${total} thing${total > 1 ? 's' : ''} need${total > 1 ? '' : 's'} attention before they slip further.`}
      </p>
      <div className="nx-failsafe">
        <Panel title="Blocked tasks" tone="danger" count={data.blocked.length} empty="No blocked tasks.">
          {data.blocked.map((t) => (
            <li key={t.id}>
              <span className="nx-failsafe__main"><b>{t.title}</b><span>{name(t.assignedToUserId)}</span></span>
              <StatusBadge status={t.status} />
            </li>
          ))}
        </Panel>
        <Panel title="Overdue or due within 7 days" tone="warning" count={data.deadlines.length} empty="Nothing due soon.">
          {data.deadlines.map((t) => {
            const late = daysLate(t.deadline);
            return (
              <li key={t.id}>
                <span className="nx-failsafe__main"><b>{t.title}</b><span>{name(t.assignedToUserId)} · due {fmt(t.deadline)}</span></span>
                <span className={'nx-tchip' + (late > 0 ? ' nx-tchip--red' : '')}>{late > 0 ? `${late}d late` : late === 0 ? 'today' : `in ${-late}d`}</span>
              </li>
            );
          })}
        </Panel>
        <Panel title="Missing EOD today" tone="warning" count={data.missingEod.length} empty="Everyone expected today has filed.">
          {data.missingEod.map((u) => (
            <li key={u.userId}>
              <span className="nx-failsafe__main"><b>{u.name}</b></span>
              <span className="nx-tchip nx-tchip--red">not filed</span>
            </li>
          ))}
        </Panel>
        <Panel title="Partners: follow-up overdue" tone="warning" count={data.partners.length} empty="No partner is waiting on us.">
          {data.partners.map((p) => (
            <li key={p.id}>
              <span className="nx-failsafe__main"><b>{p.organisation}</b><span>{name(p.assignedToUserId)} · last contact {fmt(p.lastContactDate)}</span></span>
              <span className="nx-tchip nx-tchip--red">{daysLate(p.followUpDate)}d</span>
            </li>
          ))}
        </Panel>
      </div>
    </div>
  );
}

// Session 58 — a Failsafe panel as in the original HTML app: count, then
// one row per item with who owns it and how late it is.
function Panel({ title, tone, count, empty, children }: { title: string; tone: 'danger' | 'warning'; count: number; empty: string; children: React.ReactNode }) {
  return (
    <section className={`nx-card nx-failsafe__panel nx-failsafe__panel--${count > 0 ? tone : 'ok'}`}>
      <div className="nx-adminhome__feedhead">
        <h2 className="nx-adminhome__h2">{title}</h2>
        <Badge tone={count > 0 ? tone : 'success'}>{count}</Badge>
      </div>
      {count === 0 ? <p className="nx-cell-dim" style={{ margin: 0 }}>{empty}</p> : <ul className="nx-failsafe__list">{children}</ul>}
    </section>
  );
}
