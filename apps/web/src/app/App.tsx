import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import {
  ToastProvider, useToast, Button, Card, Badge, StatusBadge, PriorityBadge,
  Avatar, Tabs, ProgressBar, EmptyState, Input, Modal,
} from '../components/ui';
import { LoadingState, ErrorState } from '../components/ui';
import { Sidebar, ComingSoon, ImpersonationBanner, Logo } from '../components/navigation';
import { WorkspaceProvider } from '../components/navigation/WorkspaceContext';
import { InvitationBanner } from '../components/navigation/InvitationBanner';
import { IA } from './ia';
import type { IaSection, IaSubsection } from './ia';
import { Overview as DashboardOverview } from '../modules/dashboard/Overview';
import { Overview as AnalyticsOverview } from '../modules/analytics/Overview';
import { Overview as NetworkOverview } from '../modules/network/Overview';
import { StateNetwork } from '../modules/network/StateNetwork';
import { Partnerships } from '../modules/network/Partnerships';
import { OrgDatabase } from '../modules/network/OrgDatabase';
import { Overview as WorkOverview } from '../modules/work/Overview';
import { MyTasks } from '../modules/work/MyTasks';
import { AllCompanies } from '../modules/work/AllCompanies';
import { TeamTasks } from '../modules/work/TeamTasks';
import { FollowUps as WorkFollowUps } from '../modules/work/FollowUps';
import { Completed as WorkCompleted } from '../modules/work/Completed';
import { Calendar as WorkCalendar } from '../modules/work/Calendar';
import { ActiveGoals } from '../modules/goals/ActiveGoals';
import { ProjectsList } from '../modules/projects/ProjectsList';
import { ProjectDetail } from '../modules/projects/ProjectDetail';
import { ReviewQueue } from '../modules/goals/ReviewQueue';
import { ArchivedGoals } from '../modules/goals/ArchivedGoals';
import { Chat } from '../modules/ai-analyst/Chat';
import { Reports as AiReports } from '../modules/ai-analyst/Reports';
import { AgentHandoff } from '../modules/ai-analyst/AgentHandoff';
import { GoalDetail } from '../modules/goals/GoalDetail';
import { Browse as KnowledgeBrowse } from '../modules/knowledge/Browse';
import { EditEntry as KnowledgeEditEntry } from '../modules/knowledge/EditEntry';
import { CompanyDocs } from '../modules/knowledge/CompanyDocs';
import { Integrations as SettingsIntegrations } from '../modules/settings/Integrations';
import { TeamRoles as SettingsTeamRoles } from '../modules/settings/TeamRoles';
import { TeamMembers } from '../modules/people/TeamMembers';
import { Overview as PeopleOverview } from '../modules/people/Overview';
import { Attendance as PeopleAttendance } from '../modules/people/Attendance';
import { Leave } from '../modules/people/Leave';
import { Onboarding } from '../modules/people/Onboarding';
import { EodReport } from '../modules/comms-ops/EodReport';
import { FailsafeAlerts } from '../modules/comms-ops/FailsafeAlerts';
import { Marketing } from '../modules/comms-ops/Marketing';
import { MarketingEdit } from '../modules/comms-ops/MarketingEdit';
import { Meetings } from '../modules/comms-ops/Meetings';
import { Account as SettingsAccount } from '../modules/settings/Account';
import { GuestInvites } from '../modules/settings/GuestInvites';
import { Billing as SettingsBilling } from '../modules/settings/Billing';
import { NotificationsPreferences as SettingsNotificationsPreferences } from '../modules/settings/NotificationsPreferences';
import { AutomationToggles } from '../modules/automation/AutomationToggles';
import { LoginPage } from './LoginPage';
import { ThemeProvider, useTheme } from './ThemeContext';
import { ThemeToggle } from '../components/navigation/ThemeToggle';
import { getCurrentSession, logout, listenForMobileOAuthCallback, type CurrentUser } from '../services/authService';
import { replayQueuedWrite } from '../services/apiClient';
import { drainQueue, subscribeToQueueEvents } from '../services/offlineQueue';
import {
  GroupOverview, GroupCompanies, GroupPeople, GroupOperations, GroupGoals, GroupAnalytics, GroupActivity,
  CompanyOverview, CompanyAnalytics, CompanyAutomation, CompanyActivity, CompanySettings,
  SuperOverview, SuperOrganizations, SuperUsers, SuperAudit, SuperBilling, SuperAdmins,
} from '../modules/admin';

// Root app shell. PRD §10.1: Google OAuth is the only production login
// path — App gates everything behind a real session check (GET
// /auth/session). Routing (this file) + Sidebar (components/navigation)
// now implement the full PRD §7.2 IA directly from app/ia.ts, closing
// open item O8 — see ia.ts's header note for why O8 was a closure gap,
// not a missing design. Every §7.2 section/subsection has a real route;
// `built: false` ones render <ComingSoon> instead of 404ing, so the nav
// always matches the PRD even where the module isn't written yet.
function KitchenSink() {
  const { show } = useToast();
  const [tab, setTab] = useState('a');
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 560 }}>
      <Card>
        <h3 style={{ marginBottom: 12 }}>Tier 1 check</h3>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <Button onClick={() => show('Task updated', 'success')}>Primary</Button>
          <Button variant="secondary" onClick={() => setModalOpen(true)}>Open modal</Button>
          <Button variant="ghost">Ghost</Button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <StatusBadge status="in_progress" />
          <PriorityBadge priority="urgent" />
          <Badge tone="neutral">Neutral</Badge>
          <Avatar name="Ayo Joshua" />
        </div>
        <Tabs items={[{ key: 'a', label: 'Overview' }, { key: 'b', label: 'Detail' }]} active={tab} onChange={setTab} />
        <div style={{ margin: '12px 0' }}><ProgressBar value={62} /></div>
        <Input label="Task title" placeholder="e.g. Follow up with partner" />
      </Card>
      <EmptyState title="No goals yet" description="Create one to see AI decomposition in action." />
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Example modal">
        <p>Modal, Drawer, Toast all render via portal.</p>
      </Modal>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'anonymous' } | { status: 'authenticated'; user: CurrentUser }
  >({ status: 'loading' });

  function loadSession() {
    setSession({ status: 'loading' });
    getCurrentSession()
      .then((user) => setSession(user ? { status: 'authenticated', user } : { status: 'anonymous' }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setSession({ status: 'error', message });
      });
  }

  useEffect(loadSession, []);

  // PRD §16 — registers the deep-link listener exactly once for the
  // lifetime of the app. On web this is a no-op (isNativePlatform is
  // false, see authService.ts). On native, a successful mobile OAuth
  // redemption re-runs loadSession so the app transitions straight from
  // LoginPage into AppBody the same way a successful web login does
  // (both end at "cookie is now set, re-fetch /auth/session").
  useEffect(() => {
    listenForMobileOAuthCallback(loadSession, (message) => setSession({ status: 'error', message }));
  }, []);

  // ThemeProvider wraps every branch below, not just AuthenticatedApp —
  // it paints from localStorage before this session check even resolves
  // (see ThemeContext.tsx's own header note), so LoginPage and the
  // loading/error states get the right palette too, not just the
  // post-login shell.
  return (
    <ThemeProvider>
      <AppBody session={session} loadSession={loadSession} />
    </ThemeProvider>
  );
}

function AppBody({
  session,
  loadSession,
}: {
  session: { status: 'loading' } | { status: 'error'; message: string } | { status: 'anonymous' } | { status: 'authenticated'; user: CurrentUser };
  loadSession: () => void;
}) {
  const { setTheme } = useTheme();

  // Server is the account-level source of truth once a session actually
  // resolves — reconcile on every fresh login/session-check the same way
  // the three admin-gate flags are freshly re-derived each time, rather
  // than trusting whatever localStorage happened to hold (a different
  // device, or a stale value from before this user last changed it
  // elsewhere). `persistToServer: false` — this is the server telling the
  // client, not the other way around, so it must not immediately PATCH
  // straight back.
  useEffect(() => {
    if (session.status === 'authenticated') {
      setTheme(session.user.themePreference, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.status === 'authenticated' ? session.user.themePreference : undefined]);

  if (session.status === 'loading') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <LoadingState label="Checking your session…" />
      </div>
    );
  }
  if (session.status === 'error') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <ErrorState title="Couldn't check your session" description={session.message} onRetry={loadSession} />
      </div>
    );
  }
  if (session.status === 'anonymous') {
    return <LoginPage />;
  }

  return (
    <ToastProvider>
      <BrowserRouter>
        <AuthenticatedApp user={session.user} onLoggedOut={loadSession} />
      </BrowserRouter>
    </ToastProvider>
  );
}

// PRD §15 Phase J — the one place this codebase surfaces offline-queue
// sync results as toasts. Lives here (inside ToastProvider, only
// rendered once authenticated) rather than inside offlineQueue.ts
// itself, which has no dependency on React or useToast by design — see
// offlineQueue.ts's own `subscribeToQueueEvents` doc comment. Two
// triggers for a drain attempt: the `online` browser event
// (offlineQueue.ts registers that listener itself) and once here on
// mount, to catch writes that were queued in a previous tab session
// where connectivity was already back by the time this tab loaded.
function useOfflineQueueToasts() {
  const { show } = useToast();

  useEffect(() => {
    const unsubscribe = subscribeToQueueEvents((event) => {
      if (event.type === 'synced') {
        show(`${event.write.kind} synced.`, 'success');
      } else if (event.type === 'rejected') {
        // A write that was queued while offline turned out, once
        // actually sent, to be rejected by the server outright (stale
        // reference, permission change since it was queued, failed
        // validation, etc.) — surfaced as a real failure, not folded
        // into the earlier neutral "saved offline" toast that already
        // came and went.
        show(`${event.write.kind} couldn't be synced: ${event.message}`, 'danger');
      }
    });
    void drainQueue(replayQueuedWrite);
    return unsubscribe;
  }, [show]);
}

function AuthenticatedApp({ user, onLoggedOut }: { user: CurrentUser; onLoggedOut: () => void }) {
  useOfflineQueueToasts();
  const isLeader = user.role === 'leader';
  const visibleSections = IA.filter((section) => {
    if (section.permissionGated && !isLeader) return false;
    // Session 42: adminGate is the extra, finer-grained cut on top of
    // permissionGated (see ia.ts's own note on IaSection.adminGate) —
    // Group Admin and Company Admin are each a subset of leaders, not
    // every leader, so a plain `isLeader` check isn't enough here the
    // way it is for Goals/AI Analyst.
    if (section.adminGate === 'group' && !user.isGroupAdmin) return false;
    if (section.adminGate === 'company' && !user.isCompanyAdmin) return false;
    if (section.adminGate === 'platform' && !user.isPlatformAdmin) return false;
    return true;
  });
  const firstPath = visibleSections[0]?.path ?? '/dashboard';
  // Session 55 — phone drawer. Closes whenever the route changes, so
  // tapping a menu item takes you there and gets the menu out of the way.
  const [navOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setNavOpen(false), [pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  return (
    <WorkspaceProvider>
      {/* Session 11 follow-up — rendered as a sibling above the shell,
          not inside .nx-app-main, so `position: sticky` pins it to the
          real viewport top regardless of which route/scroll container
          is active underneath. onEnded reuses the same loadSession the
          app already calls after a real logout — ending an
          impersonation clears the cookie the same way, so the next
          GET /session comes back anonymous and the actor lands on
          LoginPage to sign back in for real. */}
      {user.impersonatedBy && <ImpersonationBanner info={user.impersonatedBy} onEnded={onLoggedOut} />}
      <div className={'nx-app-shell' + (navOpen ? ' nx-app-shell--nav-open' : '')}>
        <Sidebar
          user={user}
          open={navOpen}
          onClose={() => setNavOpen(false)}
          footer={
            <>
              <div className="nx-sidebar__me">
                <Avatar name={user.name} size="sm" />
                <span>{user.name}</span>
              </div>
              <div className="nx-sidebar__utils">
                <ThemeToggle />
                <Button size="sm" variant="ghost" onClick={() => logout().finally(onLoggedOut)}>
                  Log out
                </Button>
              </div>
            </>
          }
        />
        <div className="nx-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />
      <main className="nx-app-main">
        <header className="nx-topbar">
          <button
            type="button"
            className="nx-topbar__menu"
            aria-label="Open menu"
            aria-controls="nx-sidebar"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          >
            <svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true">
              <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
            </svg>
          </button>
          <span className="nx-topbar__logo"><Logo size={17} /></span>
          <div className="nx-app-main__user">
            <ThemeToggle />
            <Avatar name={user.name} size="sm" />
            <span className="nx-app-main__username">{user.name}</span>
            <Button
              size="sm"
              variant="ghost"
              className="nx-app-main__logout"
              onClick={() => {
                logout().finally(onLoggedOut);
              }}
            >
              Log out
            </Button>
          </div>
        </header>

        {/* Session 57 — a company has invited you (Join / Decline). */}
        <InvitationBanner readOnly={Boolean(user.impersonatedBy)} />

        <Routes>
          {visibleSections.map((section) =>
            section.subsections.map((sub) => (
              <Route
                key={sub.path}
                path={sub.path}
                element={renderSubsection(section, sub, user)}
              />
            )),
          )}
          {/* Goal detail (§8.5) is a drill-in from Active Goals, not its own
              §7.2 subsection — same reason it's added directly here rather
              than through the IA/renderSubsection map, the way network's
              list pages are. Still gated: Goals is `permissionGated` in
              ia.ts, so a non-leader hitting this URL directly should land
              the same place a non-leader hitting /goals does — nowhere,
              via the catch-all below — rather than a route that happens to
              exist outside the IA's own gating. */}
          {isLeader && <Route path="/goals/:id" element={<GoalDetail />} />}
          {/* Project detail (ADMIN_BUILD_GUIDE.md §2) — same drill-in
              shape as /goals/:id, but NOT leader-gated: 'work' isn't
              `permissionGated` in ia.ts, and a guest with a
              project_memberships row is specifically meant to reach
              this exact route (§2: "Guest visibility is this same
              view, scoped" — the scoping is server-side, in
              routes/projects.ts's membership fallback, not here). */}
          <Route path="/work/projects/:id" element={<ProjectDetail user={user} />} />
          {/* Same drill-in reasoning as /goals/:id above — "Add / Edit
              Entry" (ia.ts) is one fixed-path subsection for both create
              and edit; editing a specific existing entry needs an :id
              the IA's flat /knowledge/edit path doesn't carry. Not
              leader-gated like Goals — Knowledge isn't `permissionGated`
              in ia.ts (PRD §7.1 has no "(permission-gated)" tag on it),
              so this route is open the same way /knowledge/edit itself
              is; the server's own `hasPermission` check on PATCH still
              applies regardless. */}
          <Route path="/knowledge/edit/:id" element={<KnowledgeEditEntry />} />
          {/* Marketing (§7.2 09 COMMS & OPS, §8.9) — same fixed-path
              list + :id drill-in shape as Knowledge, but split into two
              routes rather than one flexible /edit[/:id] path: create has
              no server round trip until Save (the three stage tasks are
              created atomically with the content item), while an
              existing item's stage changes save immediately per-field —
              different enough interaction models that MarketingEdit.tsx
              branches on `isEditing` from the route match itself. */}
          {/* Paystack checkout callback (routes/billing.ts builds the
              redirect as `${webOrigin}/settings/billing/callback`) — a
              landing point, not its own §7.2 subsection, so it's added
              directly here rather than through the IA map, same
              reasoning as /work/projects/:id above. Billing.tsx itself
              handles the `reference`/`trxref` query params via
              useSearchParams regardless of which of these two paths it
              was mounted at, so this route renders the exact same
              component as the IA's own /settings/billing entry. */}
          <Route path="/settings/billing/callback" element={<SettingsBilling user={user} />} />
          <Route path="/comms-ops/marketing/new" element={<MarketingEdit />} />
          <Route path="/comms-ops/marketing/:id" element={<MarketingEdit />} />
          {/* Dev-only Tier 1 smoke test — intentionally not in the sidebar (PRD §14 primitives, no feature behind it). */}
          <Route path="/dev/kitchen-sink" element={<KitchenSink />} />
          <Route path="*" element={<Navigate to={firstPath} replace />} />
        </Routes>
      </main>
      </div>
    </WorkspaceProvider>
  );
}

// Extracted from the Routes map above once Network's four subsections
// needed their own branches too — a nested ternary chain per module
// stops being readable past two cases. `user` is threaded through here
// (not just to Sidebar) because the three built Network modules each
// need it: `isLeader` gates their leader-only form fields (see
// modules/network/Partnerships.tsx's `documentStatus`).
function renderSubsection(section: IaSection, sub: IaSubsection, user: CurrentUser) {
  if (!sub.built) {
    return <ComingSoon sectionLabel={section.label} subsectionLabel={sub.label} />;
  }
  if (section.id === 'dashboard') return <DashboardOverview />;
  if (section.id === 'analytics') return <AnalyticsOverview />;
  if (section.id === 'work') {
    if (sub.id === 'overview') return <WorkOverview user={user} />;
    if (sub.id === 'my-tasks') return <MyTasks user={user} />;
    if (sub.id === 'all-companies') return <AllCompanies user={user} />;
    if (sub.id === 'team-tasks') return <TeamTasks user={user} />;
    if (sub.id === 'follow-ups') return <WorkFollowUps user={user} />;
    if (sub.id === 'completed') return <WorkCompleted user={user} />;
    if (sub.id === 'calendar') return <WorkCalendar />;
    if (sub.id === 'projects') return <ProjectsList />;
  }
  if (section.id === 'network') {
    if (sub.id === 'overview') return <NetworkOverview />;
    if (sub.id === 'state-network') return <StateNetwork user={user} />;
    if (sub.id === 'partnerships') return <Partnerships user={user} />;
    if (sub.id === 'org-database') return <OrgDatabase user={user} />;
  }
  if (section.id === 'goals') {
    if (sub.id === 'active') return <ActiveGoals />;
    if (sub.id === 'review-queue') return <ReviewQueue />;
    if (sub.id === 'archived') return <ArchivedGoals />;
  }
  if (section.id === 'ai-analyst') {
    if (sub.id === 'reports') return <AiReports />;
    if (sub.id === 'chat') return <Chat user={user} />;
    if (sub.id === 'agent-handoff') return <AgentHandoff />;
  }
  if (section.id === 'knowledge') {
    if (sub.id === 'browse') return <KnowledgeBrowse />;
    if (sub.id === 'edit') return <KnowledgeEditEntry />;
    if (sub.id === 'company-docs') return <CompanyDocs user={user} />;
  }
  if (section.id === 'settings') {
    if (sub.id === 'integrations') return <SettingsIntegrations />;
    if (sub.id === 'notifications') return <SettingsNotificationsPreferences />;
    if (sub.id === 'team') return <SettingsTeamRoles user={user} />;
    if (sub.id === 'guests') return <GuestInvites user={user} />;
    if (sub.id === 'billing') return <SettingsBilling user={user} />;
    if (sub.id === 'account') return <SettingsAccount user={user} />;
  }
  if (section.id === 'people') {
    if (sub.id === 'overview') return <PeopleOverview />;
    if (sub.id === 'team-members') return <TeamMembers />;
    if (sub.id === 'attendance') return <PeopleAttendance />;
    if (sub.id === 'leave') return <Leave user={user} />;
    if (sub.id === 'onboarding') return <Onboarding user={user} />;
  }
  if (section.id === 'comms-ops') {
    if (sub.id === 'eod-report') return <EodReport user={user} />;
    if (sub.id === 'calendar') return <WorkCalendar />;
    if (sub.id === 'follow-ups') return <WorkFollowUps user={user} />;
    if (sub.id === 'failsafe-alerts') return <FailsafeAlerts />;
    if (sub.id === 'marketing') return <Marketing />;
    if (sub.id === 'meetings') return <Meetings user={user} />;
  }
  if (section.id === 'automation') {
    if (sub.id === 'toggles') return <AutomationToggles />;
    // 'schedule' sub-route deferred to Phase H (PRD §17.1) — falls through
    // to ComingSoon below until jobs are wired to a real scheduler.
  }
  if (section.id === 'admin-group') {
    if (sub.id === 'overview') return <GroupOverview />;
    if (sub.id === 'companies') return <GroupCompanies />;
    if (sub.id === 'people') return <GroupPeople />;
    if (sub.id === 'operations') return <GroupOperations />;
    if (sub.id === 'goals') return <GroupGoals />;
    if (sub.id === 'analytics') return <GroupAnalytics />;
    if (sub.id === 'activity') return <GroupActivity />;
  }
  if (section.id === 'admin-company') {
    if (sub.id === 'overview') return <CompanyOverview />;
    if (sub.id === 'analytics') return <CompanyAnalytics />;
    if (sub.id === 'automation') return <CompanyAutomation />;
    if (sub.id === 'activity') return <CompanyActivity />;
    if (sub.id === 'settings') return <CompanySettings />;
  }
  if (section.id === 'admin-platform') {
    if (sub.id === 'overview') return <SuperOverview />;
    if (sub.id === 'organizations') return <SuperOrganizations />;
    if (sub.id === 'users') return <SuperUsers />;
    if (sub.id === 'super-admins') return <SuperAdmins user={user} />;
    if (sub.id === 'billing') return <SuperBilling />;
    if (sub.id === 'audit') return <SuperAudit />;
  }
  // `built: true` with no case above would be a real bug (IA promises a
  // module that isn't wired here) — fall back to ComingSoon rather than
  // rendering nothing, so it fails visibly instead of as a blank page.
  return <ComingSoon sectionLabel={section.label} subsectionLabel={sub.label} />;
}
