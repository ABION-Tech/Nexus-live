import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, CreditCard, ShieldCheck, ShieldAlert, Users } from 'lucide-react';
import { Badge, LoadingState, ErrorState } from '../../components/ui';
import { fetchAuditLog, fetchAutomationDispatch, fetchPlatformAnalytics, fetchSystemHealth, searchOrganizations, searchPlatformUsers } from '../../services/superAdminService';
import type { AuditLogEntry, AutomationDispatchEntry, Organization, PlatformAnalyticsSummary, SubsystemStatus, SystemHealthReport } from '@nexus/shared';
import { AdminHome } from './AdminHome';
import { nextRunLabel, relativeTime } from '../automation/automationTime';

// Session 60 (C-04): names for the Scheduled jobs card.
const JOB_LABEL: Record<string, string> = {
  daily_overdue_check: 'Overdue check',
  daily_morning_digest: 'Morning digest',
  daily_dependency_sweep: 'Dependency sweep',
  daily_recurring_tasks: 'Recurring tasks',
  hourly_follow_up: 'Hourly follow-up',
  daily_cob_reminders: 'Close-of-business reminders',
  daily_follow_up_escalation: 'Follow-up escalation',
  daily_eod_nudge: 'EOD nudge',
  daily_task_snapshot: 'Nightly task snapshot',
};

const TONE: Record<SubsystemStatus, 'success' | 'warning' | 'danger' | 'neutral'> = { ok: 'success', degraded: 'warning', down: 'danger', unknown: 'neutral' };

// Super Admin > Overview. Session 58: rebuilt on AdminHome. System health
// shows what is actually checked; subsystems without a check yet are one
// quiet line instead of a wall of "unknown".
export function SuperOverview() {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; summary: PlatformAnalyticsSummary; health: SystemHealthReport; orgs: Organization[] }
  >({ status: 'loading' });
  const [activity, setActivity] = useState<AuditLogEntry[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [jobs, setJobs] = useState<AutomationDispatchEntry[] | null>(null);

  function load() {
    setState({ status: 'loading' });
    Promise.all([fetchPlatformAnalytics(), fetchSystemHealth(), searchOrganizations()])
      .then(([summary, health, orgs]) => setState({ status: 'ready', summary, health, orgs }))
      .catch((err: unknown) => setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' }));
    fetchAuditLog({ limit: 8 }).then(setActivity).catch(() => setActivity([]));
    fetchAutomationDispatch().then(setJobs).catch(() => setJobs([]));
    searchPlatformUsers().then((u) => setNames(new Map(u.map((x) => [x.id, x.name])))).catch(() => undefined);
  }
  useEffect(load, []);

  if (state.status === 'loading') return <LoadingState label="Loading platform overview…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load platform overview" description={state.message} onRetry={load} />;
  const { summary: s, health, orgs } = state;
  const checked = health.subsystems.filter((x) => x.status !== 'unknown');
  const unchecked = health.subsystems.filter((x) => x.status === 'unknown');

  return (
    <AdminHome
      kicker="Super Admin"
      title="The whole NEXUS platform"
      lede="Every organization and person on NEXUS, who runs it, billing, and security."
      primary={{ label: '+ New organization', to: '/admin/platform/organizations' }}
      stats={[
        { label: 'Organizations', value: s.totalOrganizations, to: '/admin/platform/organizations' },
        { label: 'Companies', value: s.totalCompanies, to: '/admin/platform/organizations' },
        { label: 'Groups', value: s.totalGroups, to: '/admin/platform/organizations', tone: 'amber' },
        { label: 'People', value: s.totalUsers, to: '/admin/platform/users', tone: 'green' },
        { label: 'Super Admins', value: s.totalPlatformAdmins, to: '/admin/platform/super-admins', tone: 'red' },
      ]}
      actions={[
        { icon: Building2, title: 'Organizations', text: 'Create, rename, group or switch off companies and groups.', to: '/admin/platform/organizations' },
        { icon: Users, title: 'Users', text: 'Find anyone on the platform and the company they belong to.', to: '/admin/platform/users' },
        { icon: ShieldCheck, title: 'Super Admins', text: 'Who else can run the platform.', to: '/admin/platform/super-admins' },
        { icon: CreditCard, title: 'Billing review', text: 'Plans waiting for a decision.', to: '/admin/platform/billing' },
        { icon: ShieldAlert, title: 'Audit & security', text: 'Every sign-in, impersonation and admin action.', to: '/admin/platform/audit' },
      ]}
      activity={activity}
      activityTo="/admin/platform/audit"
      nameOf={(id) => (id ? names.get(id) : undefined)}
      extra={
        <div className="nx-adminhome__grid">
          <section className="nx-card">
            <div className="nx-adminhome__feedhead">
              <h2 className="nx-adminhome__h2">Organizations</h2>
              <Link className="nx-chipbtn" to="/admin/platform/organizations">Manage</Link>
            </div>
            <ul className="nx-adminhome__orgs">
              {orgs.slice(0, 8).map((o) => (
                <li key={o.id}>
                  <span className="nx-ws__mark nx-ws__mark--sm" aria-hidden="true">{o.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}</span>
                  <b>{o.name}</b>
                  <span className="nx-cell-dim">{o.orgType === 'group' ? 'Group' : 'Company'}</span>
                  <Badge tone={o.active ? 'success' : 'neutral'} dot>{o.active ? 'Active' : 'Off'}</Badge>
                </li>
              ))}
            </ul>
          </section>
          <section className="nx-card">
            <div className="nx-adminhome__feedhead">
              <h2 className="nx-adminhome__h2">System health</h2>
              <Badge tone={checked.some((x) => x.status !== 'ok') ? TONE[checked.find((x) => x.status !== 'ok')!.status] : 'success'} dot>
                {checked.every((x) => x.status === 'ok') ? 'All good' : 'Needs a look'}
              </Badge>
            </div>
            <ul className="nx-adminhome__health">
              {checked.map((x) => (
                <li key={x.name}>
                  <span style={{ textTransform: 'capitalize' }}>{x.name}</span>
                  <Badge tone={TONE[x.status]} dot>{x.status === 'ok' ? 'OK' : x.status}</Badge>
                </li>
              ))}
            </ul>
            {unchecked.length > 0 && (
              <p className="nx-cell-dim" style={{ margin: '10px 0 0', fontSize: 12 }}>
                Not monitored yet: {unchecked.map((x) => x.name).join(', ')}.
              </p>
            )}
          </section>
          <section className="nx-card" style={{ gridColumn: '1 / -1' }}>
            <div className="nx-adminhome__feedhead">
              <h2 className="nx-adminhome__h2">Scheduled jobs</h2>
              {jobs && jobs.length > 0 && (
                <Badge tone={jobs.some((j) => j.status === 'error') ? 'danger' : 'success'} dot>
                  {jobs.some((j) => j.status === 'error') ? `${jobs.filter((j) => j.status === 'error').length} failing` : 'All ran'}
                </Badge>
              )}
            </div>
            {jobs === null ? (
              <p className="nx-cell-dim">Loading…</p>
            ) : (
              <ul className="nx-adminhome__health">
                {jobs.map((j) => (
                  <li key={j.jobKey} title={j.error}>
                    <span>{JOB_LABEL[j.jobKey] ?? j.jobKey}</span>
                    <span className="nx-cell-dim" style={{ fontSize: 12 }}>
                      {j.startedAt ? `${relativeTime(j.startedAt)}${j.orgsRun ? ` · ${j.orgsRun - j.orgsFailed}/${j.orgsRun} companies` : ''}` : 'Not run since tracking began'}
                      {j.nextRunAt ? ` · next ${nextRunLabel(j.nextRunAt)}` : ''}
                    </span>
                    <Badge tone={j.status === 'error' ? 'danger' : j.status === 'never' ? 'neutral' : 'success'} dot>
                      {j.status === 'error' ? (j.orgsRun === 0 ? "Didn't start" : 'Failed') : j.status === 'never' ? '—' : 'OK'}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            {jobs?.some((j) => j.status === 'error') && (
              <p className="nx-cell-dim" style={{ margin: '10px 0 0', fontSize: 12 }}>
                Hover a failing job to see the error. Super Admins get one email a day per failing job.
              </p>
            )}
          </section>
        </div>
      }
    />
  );
}
