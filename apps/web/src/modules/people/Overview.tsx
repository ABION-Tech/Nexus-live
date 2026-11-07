import { useEffect, useState } from 'react';
import { Card, Badge, LoadingState, ErrorState } from '../../components/ui';
import { MetricCard } from '../../components/dashboard';
import { fetchPeople } from '../../services/peopleService';
import { fetchEodCompliance } from '../../services/eodService';
import type { EodComplianceSummary, Person, Role } from '@nexus/shared';

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

const ROLE_LABELS: Record<Role, string> = {
  leader: 'Leaders',
  team_member: 'Team members',
  intern: 'Interns',
  // Guests (Session 37, ADMIN_BUILD_GUIDE.md §1) are provisioned via
  // guestService.ts, not the invite flow this roster/summary reflects —
  // included only so this satisfies Record<Role, ...> now that Role
  // has a fourth value; guests aren't expected to actually appear here
  // until project-scoped guest visibility (a later session) surfaces them.
  guest: 'Guests',
};

// PRD §7.2 04 PEOPLE → Overview. A small roster-by-role summary plus
// today's EOD compliance — the same two data sources Team Members and
// Attendance each drill into individually, surfaced together as the
// section landing page.
export function Overview() {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [people, setPeople] = useState<Person[]>([]);
  const [compliance, setCompliance] = useState<EodComplianceSummary | null>(null);

  useEffect(() => {
    Promise.all([fetchPeople(), fetchEodCompliance().catch(() => null)])
      .then(([p, c]) => {
        setPeople(p);
        setCompliance(c);
        setLoad({ status: 'ready' });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setLoad({ status: 'error', message });
      });
  }, []);

  if (load.status === 'loading') return <LoadingState label="Loading team overview…" />;
  if (load.status === 'error') return <ErrorState title="Couldn't load People overview" description={load.message} />;

  const counts = (['leader', 'team_member', 'intern'] as Role[]).map((role) => ({
    role,
    count: people.filter((p) => p.role === role).length,
  }));

  return (
    <div className="nx-page nx-view-enter">
      <h2>People</h2>
      {/* UI Rehaul polish pass — this was hand-rolling a Card with the same
          28px-value/label-below shape MetricCard already defines, missing
          out on the icon slot, mono value font, and hover-lift/accent-corner
          treatment every other Overview page (Work, Network, Analytics, the
          three admin overviews) gets via MetricCard itself. */}
      <div className="nx-dashboard-overview__metrics">
        {counts.map((c) => (
          <MetricCard key={c.role} label={ROLE_LABELS[c.role]} value={c.count} />
        ))}
      </div>
      {compliance && (
        <Card>
          <div className="nx-row nx-row--between">
            <div>
              <div style={{ fontWeight: 600 }}>Today's EOD compliance</div>
              <div style={{ opacity: 0.7, fontSize: 13 }}>
                {compliance.filedCount} of {compliance.expectedCount} expected members have filed
              </div>
            </div>
            <Badge tone={compliance.compliancePercent >= 80 ? 'success' : compliance.compliancePercent >= 50 ? 'warning' : 'danger'}>
              {compliance.compliancePercent}%
            </Badge>
          </div>
        </Card>
      )}
    </div>
  );
}
