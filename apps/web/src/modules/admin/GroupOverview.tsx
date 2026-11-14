import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, BarChart3, Building2, Target, Users, Workflow } from 'lucide-react';
import { Badge, LoadingState, ErrorState } from '../../components/ui';
import { fetchGroupActivity, fetchGroupAnalyticsOverview, fetchGroupCompanies } from '../../services/groupAdminService';
import type { AuditLogEntry, GroupAnalyticsSummary, Organization } from '@nexus/shared';
import { AdminHome } from './AdminHome';

// Group Admin > Overview. Session 58: rebuilt on AdminHome, with the
// group's companies as a list you can open.
export function GroupOverview() {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; summary: GroupAnalyticsSummary; companies: Organization[] }
  >({ status: 'loading' });
  const [activity, setActivity] = useState<AuditLogEntry[] | null>(null);

  function load() {
    setState({ status: 'loading' });
    Promise.all([fetchGroupAnalyticsOverview(), fetchGroupCompanies()])
      .then(([summary, companies]) => setState({ status: 'ready', summary, companies }))
      .catch((err: unknown) => setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' }));
    fetchGroupActivity({ limit: 8 }).then(setActivity).catch(() => setActivity([]));
  }
  useEffect(load, []);

  if (state.status === 'loading') return <LoadingState label="Loading group overview…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load group overview" description={state.message} onRetry={load} />;
  const { summary: s, companies } = state;

  return (
    <AdminHome
      kicker="Group Admin"
      title="Your group of companies"
      lede="Every company in the group, its people and its work, in one place."
      primary={{ label: '+ Add a company', to: '/admin/companies' }}
      stats={[
        { label: 'Companies', value: s.totalCompanies, to: '/admin/companies' },
        { label: 'Active', value: s.activeCompanies, to: '/admin/companies', tone: 'green' },
        { label: 'People', value: s.totalUsers, to: '/admin/people', tone: 'amber' },
      ]}
      actions={[
        { icon: Building2, title: 'Companies', text: 'Add a company, rename it, or switch it off.', to: '/admin/companies' },
        { icon: Users, title: 'People', text: 'Everyone across the group and their roles.', to: '/admin/people' },
        { icon: Workflow, title: 'Operations', text: 'Open, blocked and overdue work per company.', to: '/admin/operations' },
        { icon: Target, title: 'Goals', text: 'Goals across the group and how far along they are.', to: '/admin/goals' },
        { icon: BarChart3, title: 'Analytics', text: 'Compare companies side by side.', to: '/admin/analytics' },
        { icon: Activity, title: 'Activity log', text: "What's happened across the group.", to: '/admin/activity' },
      ]}
      activity={activity}
      activityTo="/admin/activity"
      extra={
        <section className="nx-card">
          <div className="nx-adminhome__feedhead">
            <h2 className="nx-adminhome__h2">Companies in this group</h2>
            <Link className="nx-chipbtn" to="/admin/companies">Manage</Link>
          </div>
          {companies.length === 0 ? (
            <p className="nx-cell-dim">No companies in this group yet. Add the first one with "+ Add a company".</p>
          ) : (
            <ul className="nx-adminhome__orgs">
              {companies.map((c) => (
                <li key={c.id}>
                  <span className="nx-ws__mark nx-ws__mark--sm" aria-hidden="true">{c.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}</span>
                  <b>{c.name}</b>
                  <Badge tone={c.active ? 'success' : 'neutral'} dot>{c.active ? 'Active' : 'Off'}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      }
    />
  );
}
