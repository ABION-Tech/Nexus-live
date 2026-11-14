import { useEffect, useState } from 'react';
import { Activity, BarChart3, CreditCard, Settings2, UserPlus, Users, Workflow, UserRoundPlus } from 'lucide-react';
import { LoadingState, ErrorState } from '../../components/ui';
import { fetchCompanyActivity, fetchCompanyOverview } from '../../services/companyAdminService';
import { fetchPeople } from '../../services/peopleService';
import type { AuditLogEntry, CompanyAnalyticsSummary } from '@nexus/shared';
import { AdminHome } from './AdminHome';

// Company Admin > Overview. Session 58: rebuilt on AdminHome — live
// numbers that link to where you act on them, the jobs a company admin
// does, and the company's recent audit activity.
export function CompanyOverview() {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; summary: CompanyAnalyticsSummary }>({
    status: 'loading',
  });
  const [activity, setActivity] = useState<AuditLogEntry[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  function load() {
    setState({ status: 'loading' });
    fetchCompanyOverview()
      .then((summary) => setState({ status: 'ready', summary }))
      .catch((err: unknown) => setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' }));
    fetchCompanyActivity({ limit: 8 }).then(setActivity).catch(() => setActivity([]));
    fetchPeople().then((p) => setNames(new Map(p.map((x) => [x.id, x.name])))).catch(() => undefined);
  }
  useEffect(load, []);

  if (state.status === 'loading') return <LoadingState label="Loading overview…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load overview" description={state.message} onRetry={load} />;
  const s = state.summary;

  return (
    <AdminHome
      kicker="Company Admin"
      title="Run your company"
      lede="Who's in, what they can do, how the company is set up, and what's been happening."
      primary={{ label: '+ Invite people', to: '/settings/team' }}
      stats={[
        { label: 'People', value: s.totalPeople, to: '/people/team-members' },
        { label: 'Open tasks', value: s.openTasks, to: '/work/team-tasks' },
        { label: 'Blocked', value: s.blockedTasks, to: '/comms-ops/failsafe-alerts', tone: s.blockedTasks > 0 ? 'red' : 'green' },
        { label: 'Done', value: s.doneTasks, to: '/work/completed', tone: 'green' },
        { label: 'Active goals', value: s.activeGoals, to: '/goals', tone: 'amber' },
        { label: 'Knowledge entries', value: s.knowledgeEntries, to: '/knowledge' },
      ]}
      actions={[
        { icon: UserPlus, title: 'Invite people', text: 'Add teammates by email, as leader, team member or intern.', to: '/settings/team' },
        { icon: Users, title: 'Team & roles', text: "Change someone's role or cancel an invite.", to: '/settings/team' },
        { icon: UserRoundPlus, title: 'Guests', text: 'Let an outside person into one project only.', to: '/settings/guests' },
        { icon: Settings2, title: 'Company settings', text: 'Name, working days, EOD time and time zone.', to: '/admin/settings' },
        { icon: Workflow, title: 'Automation', text: 'Turn reminders, escalations and reports on or off.', to: '/admin/automation' },
        { icon: BarChart3, title: 'Analytics', text: 'Throughput, on-time rate and workload by person.', to: '/admin/analytics' },
        { icon: CreditCard, title: 'Billing', text: 'Your plan, seats and invoices.', to: '/settings/billing' },
        { icon: Activity, title: 'Activity log', text: 'Every sign-in, invite, role change and edit.', to: '/admin/activity' },
      ]}
      activity={activity}
      activityTo="/admin/activity"
      nameOf={(id) => (id ? names.get(id) : undefined)}
    />
  );
}
