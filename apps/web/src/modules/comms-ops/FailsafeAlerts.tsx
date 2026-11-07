import { useEffect, useState } from 'react';
import { Card, Badge, EmptyState, ErrorState, LoadingState, StatusBadge } from '../../components/ui';
import { fetchBlockedTasks, fetchStalePartnerFollowUps, fetchUpcomingDeadlines } from '../../services/analyticsService';
import { fetchMissingEod } from '../../services/eodService';
import type { MissingEodUser, Partnership, Task } from '@nexus/shared';

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

interface AlertsData {
  blocked: Task[];
  deadlines: Task[];
  missingEod: MissingEodUser[];
  partners: Partnership[];
}

function Section<T>({ title, tone, items, render, empty }: {
  title: string; tone: 'danger' | 'warning'; items: T[]; render: (item: T) => React.ReactNode; empty: string;
}) {
  return (
    <div className="nx-stack nx-stack--sm">
      <div className="nx-row">
        <h3 style={{ margin: 0 }}>{title}</h3>
        <Badge tone={items.length > 0 ? tone : 'success'}>{items.length}</Badge>
      </div>
      {items.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((item, i) => <Card key={i}>{render(item)}</Card>)}
        </div>
      )}
    </div>
  );
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

  if (load.status === 'loading') return <LoadingState label="Loading alerts…" />;
  if (load.status === 'error') return <ErrorState title="Couldn't load Failsafe Alerts" description={load.message} onRetry={loadAll} />;
  if (!data) return null;

  return (
    <div className="nx-page nx-view-enter" style={{ gap: 24 }}>
      <h2>Failsafe Alerts</h2>
      <Section
        title="Blocked tasks"
        tone="danger"
        items={data.blocked}
        empty="No blocked tasks"
        render={(t) => (
          <div className="nx-row nx-row--between">
            <span>{t.title}</span>
            <StatusBadge status={t.status} />
          </div>
        )}
      />
      <Section
        title="Upcoming / overdue deadlines"
        tone="warning"
        items={data.deadlines}
        empty="Nothing due soon"
        render={(t) => (
          <div className="nx-row nx-row--between">
            <span>{t.title}</span>
            <span style={{ opacity: 0.7, fontSize: 13 }}>{t.deadline ? new Date(t.deadline).toLocaleDateString() : ''}</span>
          </div>
        )}
      />
      <Section
        title="Missing EOD (today)"
        tone="warning"
        items={data.missingEod}
        empty="Everyone expected today has filed"
        render={(u) => <span>{u.name}</span>}
      />
      <Section
        title="Stale partner follow-ups"
        tone="warning"
        items={data.partners}
        empty="No stale partner follow-ups"
        render={(p) => (
          <div className="nx-row nx-row--between">
            <span>{p.organisation}</span>
            <span style={{ opacity: 0.7, fontSize: 13 }}>{p.followUpDate ? new Date(p.followUpDate).toLocaleDateString() : ''}</span>
          </div>
        )}
      />
    </div>
  );
}
