// Direct port of PRD §7.2's finalized subsection tree — the "single
// document" §7.1's IA completion gate demanded. O8 (SESSION_LOG: "still
// unresolved" across every prior session) turned out to already be
// answered by §7 itself: Activity Log → Analytics, Review Queue → Goals,
// Marketing → Comms & Ops, all stated once and unambiguously (§7.1's
// table + notes). What was actually missing wasn't design, it was this
// file — the IA existed only as prose, never as something the app could
// route against. This is that.
//
// `built: true` means a real module exists (Overview.tsx exists and
// renders real data) — everything else renders <ComingSoon> at its route
// rather than being left out of the nav entirely, so the nav always
// reflects the full §7.2 tree even where the module doesn't exist yet.
// §2 WORK's "Projects" subsection is the one deliberate omission — PRD
// §7.2 itself says "(future — not in MVP, not in v1)", so it's left out
// of the nav rather than stubbed.
//
// `permissionGated` sections (Goals, AI Analyst — per §7.1's inline
// "(permission-gated)" tags) are hidden from a non-leader's nav as a UX
// convenience only. It is NOT a security boundary — every route these
// point at still goes through the server's own `hasPermission` checks
// regardless of what the sidebar shows; a coarse `role === 'leader'`
// check is a stand-in here because there's no bulk grants-fetch endpoint
// yet for the frontend to ask "what am I actually allowed to see."

export interface IaSubsection {
  id: string;
  label: string;
  path: string;
  built: boolean;
}

export interface IaSection {
  id: string;
  number: string; // PRD §7.2's own numbering (01–11), kept for cross-reference
  label: string;
  path: string; // section landing path — redirects to its first subsection
  permissionGated?: boolean;
  // Session 42 (ADMIN_BUILD_GUIDE.md §3 "Session 6" dashboard UI pass).
  // `permissionGated` alone (isLeader) isn't fine-grained enough for the
  // two admin shells — Group Admin and Company Admin are each visible to
  // a *subset* of leaders (leader of a group-type org vs. a company-type
  // org, from GET /session's isGroupAdmin/isCompanyAdmin flags), not
  // "every leader" the way Goals/AI Analyst are. `adminGate` layers on
  // top of `permissionGated` rather than replacing it — App.tsx's
  // visibleSections filter checks both. Same "convenience, not the real
  // boundary" caveat as `permissionGated`'s own note: every /admin/*
  // route re-checks server-side regardless of what the sidebar shows.
  // 'platform' added Session 43 (ADMIN_BUILD_GUIDE.md §3 "Session 5",
  // Super Admin UI) — same layering as 'group'/'company' below, gated on
  // GET /session's isPlatformAdmin flag instead. A platform admin is
  // never simultaneously a group/company admin's own org-scoped leader
  // in practice (platform_admins is a separate, non-org-scoped table per
  // the guide §1), but App.tsx's filter doesn't assume that — all three
  // adminGate values are checked independently, so nothing breaks if a
  // real account ever does hold more than one.
  adminGate?: 'group' | 'company' | 'platform';
  subsections: IaSubsection[];
}

export const IA: IaSection[] = [
  {
    id: 'dashboard',
    number: '01',
    label: 'Dashboard',
    path: '/dashboard',
    subsections: [{ id: 'overview', label: 'Overview', path: '/dashboard', built: true }],
  },
  {
    id: 'work',
    number: '02',
    label: 'Work',
    path: '/work',
    subsections: [
      { id: 'overview', label: 'Overview', path: '/work', built: true },
      { id: 'my-tasks', label: 'My Tasks', path: '/work/my-tasks', built: true },
      { id: 'team-tasks', label: 'Team Tasks', path: '/work/team-tasks', built: true },
      // Projects (ADMIN_BUILD_GUIDE.md §2, Session 38, repo numbering)
      // revisits the "future — not in MVP, not in v1" call PRD §7.2
      // originally made — same subsection tree, now built. Guest access
      // (project_memberships) rides this same route: 'work' isn't
      // `permissionGated` below, so a guest with no blanket 'projects'
      // grant still reaches /work/projects — routes/projects.ts's own
      // fallback to the membership path is what actually scopes what
      // they see once they're there, not the sidebar.
      { id: 'projects', label: 'Projects', path: '/work/projects', built: true },
      // Calendar/Follow-Ups/Completed were ComingSoon as of Session 20
      // (Master Tasks landed, but Calendar/Follow-Ups/Completed didn't).
      // Follow-Ups and Completed are now built — both reuse data/endpoints
      // Analytics and Work already had (Failsafe blocked/deadlines lists,
      // and GET /tasks?status=done), so no new backend was needed. Calendar
      // is now built too — the Google Calendar integration (PRD §10.5) has
      // its own OAuth connect flow, sync service, and event CRUD, all
      // wired through modules/work/Calendar.tsx.
      { id: 'calendar', label: 'Calendar', path: '/work/calendar', built: true },
      { id: 'follow-ups', label: 'Follow-Ups', path: '/work/follow-ups', built: true },
      { id: 'completed', label: 'Completed', path: '/work/completed', built: true },
    ],
  },
  {
    id: 'network',
    number: '03',
    label: 'Network',
    path: '/network',
    subsections: [
      { id: 'overview', label: 'Overview', path: '/network', built: true },
      { id: 'state-network', label: 'State Network', path: '/network/state', built: true },
      { id: 'partnerships', label: 'Partnerships', path: '/network/partnerships', built: true },
      { id: 'org-database', label: 'Org Database', path: '/network/org-database', built: true },
    ],
  },
  {
    id: 'people',
    number: '04',
    label: 'People',
    path: '/people',
    subsections: [
      { id: 'overview', label: 'Overview', path: '/people', built: true },
      // Team Members is built — GET /people (peopleService.ts's
      // listOrgPeople) already existed to back Network's assignee/owner
      // pickers; this is that same read-only roster given its own view.
      //
      // Leave and Onboarding are now built too (0013_leave_decision_note_
      // and_onboarding.sql + routes/leave.ts, routes/onboarding.ts):
      // Leave's table already existed and just needed the route/service
      // layer; Onboarding got a real schema (adjustable checklist
      // template + per-user progress). Attendance is now built too —
      // eodService.ts's new getAttendanceForDate (GET /eod/attendance)
      // is the same EOD-day-aware expected set getEodCompliance/
      // getMissingEod already computed, just returned per-user with a
      // filed/not-filed flag instead of aggregated.
      { id: 'team-members', label: 'Team Members', path: '/people/team-members', built: true },
      { id: 'attendance', label: 'Attendance', path: '/people/attendance', built: true },
      { id: 'leave', label: 'Leave', path: '/people/leave', built: true },
      { id: 'onboarding', label: 'Onboarding', path: '/people/onboarding', built: true },
    ],
  },
  {
    id: 'goals',
    number: '05',
    label: 'Goals',
    path: '/goals',
    permissionGated: true,
    subsections: [
      { id: 'active', label: 'Active Goals', path: '/goals', built: true },
      { id: 'review-queue', label: 'Review Queue', path: '/goals/review-queue', built: true },
      { id: 'archived', label: 'Archived Goals', path: '/goals/archived', built: true },
    ],
  },
  {
    id: 'knowledge',
    number: '06',
    label: 'Knowledge',
    path: '/knowledge',
    subsections: [
      { id: 'browse', label: 'Knowledge Base', path: '/knowledge', built: true },
      { id: 'edit', label: 'Add / Edit Entry', path: '/knowledge/edit', built: true },
      // Company Docs (0023, ADMIN_BUILD_GUIDE.md Session 8) — added as a
      // subsection here rather than a new top-level IA section. This
      // file's own header note says the tree above is "a direct port of
      // PRD §7.2's finalized subsection tree" (a closed 01–11 numbered
      // set); a brand-new top-level number for one feature would be
      // exactly the kind of scope drift that note exists to prevent.
      // Knowledge is the closest existing top-level section by access
      // shape — read-open to every org member, not leader-gated the way
      // the /admin/* shells are — even though its current content model
      // (freeform text entries) is otherwise unrelated to a file list.
      { id: 'company-docs', label: 'Company Docs', path: '/knowledge/company-docs', built: true },
    ],
  },
  {
    id: 'analytics',
    number: '07',
    label: 'Analytics',
    path: '/analytics',
    subsections: [
      // Task Trends + all 4 Failsafe categories currently render together
      // on one Overview page (modules/analytics/Overview.tsx) rather than
      // as 6 separate routes — a known simplification versus §7.2's literal
      // per-metric subsection list, not an oversight. Splitting them into
      // separate routes is reasonable follow-up work, not required to
      // close O8 itself (IA reconciliation was about section placement,
      // not per-subsection routing granularity).
      { id: 'overview', label: 'Overview', path: '/analytics', built: true },
    ],
  },
  {
    id: 'ai-analyst',
    number: '08',
    label: 'AI Analyst',
    path: '/ai-analyst',
    permissionGated: true,
    subsections: [
      // Reports and Agent Handoff are now built too — Reports.tsx calls
      // POST /ai/reports/generate (aiReportService.ts's deterministic
      // signals + aiService.ts's narration); AgentHandoff.tsx calls
      // POST /agent-handoffs (agentHandoffService.ts's n8n-first /
      // direct-AI-fallback contract, PRD §10.6). All three AI Analyst
      // subsections are built as of this session.
      { id: 'reports', label: 'Reports', path: '/ai-analyst', built: true },
      { id: 'chat', label: 'Chat', path: '/ai-analyst/chat', built: true },
      { id: 'agent-handoff', label: 'Agent Handoff', path: '/ai-analyst/agent-handoff', built: true },
    ],
  },
  {
    id: 'comms-ops',
    number: '09',
    label: 'Comms & Ops',
    path: '/comms-ops',
    subsections: [
      // EOD Report, Calendar/Meetings, Follow-Ups, and Failsafe Alerts
      // are now built. EOD Report and Failsafe Alerts are new modules
      // (modules/comms-ops/*) over eodService.ts/analyticsService.ts/
      // networkService.ts's existing queries — no new backend. Calendar
      // and Follow-Ups reuse Work's own Calendar.tsx/FollowUps.tsx
      // components directly rather than duplicating them — same
      // component, a second nav entry, per §7.2's own note that these
      // are "operationally related" duplicates of Work's daily-rhythm
      // views, not distinct data. Marketing now has a service/route
      // (marketingService.ts / routes/marketing.ts) backed by the
      // existing marketing_content table (0009) — content calendar with
      // an Add/Edit drill-in at /comms-ops/marketing/edit[/:id], same
      // fixed-path-plus-:id-drill-in shape as Knowledge's Add/Edit Entry.
      { id: 'eod-report', label: 'EOD Report', path: '/comms-ops', built: true },
      { id: 'calendar', label: 'Calendar / Meetings', path: '/comms-ops/calendar', built: true },
      { id: 'follow-ups', label: 'Follow-Ups', path: '/comms-ops/follow-ups', built: true },
      { id: 'failsafe-alerts', label: 'Failsafe Alerts', path: '/comms-ops/failsafe-alerts', built: true },
      { id: 'marketing', label: 'Marketing', path: '/comms-ops/marketing', built: true },
      // Meetings (PRD §8.2) — the meetings table's own CRUD + recording-
      // review surface (meetingService.ts/meetings.ts), distinct from the
      // 'calendar' subsection just above which is Work's Google Calendar
      // event sync (a different resource, different backend). Added as a
      // new subsection under this section rather than folded into
      // 'calendar' or given a new top-level number — same "closest
      // existing section by shape, not a brand-new numbered slot" call
      // this file's header makes for Knowledge > Company Docs.
      { id: 'meetings', label: 'Meetings', path: '/comms-ops/meetings', built: true },
    ],
  },
  {
    id: 'automation',
    number: '10',
    label: 'Automation',
    path: '/automation',
    subsections: [
      { id: 'toggles', label: 'Automation Toggles', path: '/automation', built: true },
      { id: 'schedule', label: 'Schedule Status', path: '/automation/schedule', built: false },
    ],
  },
  {
    id: 'settings',
    number: '11',
    label: 'Settings',
    path: '/settings',
    subsections: [
      { id: 'integrations', label: 'Integrations', path: '/settings', built: true },
      { id: 'notifications', label: 'Notifications Preferences', path: '/settings/notifications', built: true },
      // Team & Roles used to reuse People > Team Members' component
      // directly (same roster, same read-only view) — Session 36 gave it
      // its own TeamRoles.tsx: same GET /people roster as its starting
      // point, but a row click now opens a drawer onto that person's own
      // `permissions` rows (routes/permissions.ts), the editable
      // per-resource trust grants PRD §13.3 describes. People > Team
      // Members stays the plain read-only roster — granting/revoking
      // access is a Settings-scoped concern, not something every viewer
      // of the People roster needs in front of them. Account is a new,
      // small module: profile display + sign-out — there's no password
      // to manage since Google OAuth is the only login path (§10.1).
      { id: 'team', label: 'Team & Roles', path: '/settings/team', built: true },
      // Guest Invites (Session 42) — the UI half of guestService.ts's
      // backend (Session 37); guests.ts's own header comment names this
      // exact path as the deferred surface. Leader-gated client-side the
      // same way TeamRoles.tsx already is; no orgType restriction since
      // POST /guests itself applies none.
      { id: 'guests', label: 'Guest Invites', path: '/settings/guests', built: true },
      // Billing — the UI half of routes/billing.ts (Session 47's own
      // "Next steps" #3 named this exact gap: "Settings > Billing UI
      // (leader-facing)... no frontend work done this session"). Same
      // client-side leader gate as the rest of this subsection tree; the
      // real boundary is requireLeader() in billing.ts itself.
      { id: 'billing', label: 'Billing', path: '/settings/billing', built: true },
      { id: 'account', label: 'Account', path: '/settings/account', built: true },
    ],
  },
  // Session 42 (ADMIN_BUILD_GUIDE.md §3 "Session 6"). Group Admin and
  // Company Admin are mutually exclusive for any one user (a leader's
  // own org is either `group` or `company`, never both), so both use
  // the same `/admin` path prefix and section number without collision
  // risk — App.tsx's visibleSections filter only ever admits one of
  // the two for a given session. Kept as two separate IaSection entries
  // (not one with conditional subsections) so each subsection tree, and
  // each entry's own built:true set, stays a plain static list — the
  // same reasoning ia.ts's own header comment gives for finalizing the
  // whole tree as data rather than something computed at render time.
  {
    id: 'admin-group',
    number: '12',
    label: 'Group Admin',
    path: '/admin',
    adminGate: 'group',
    subsections: [
      { id: 'overview', label: 'Overview', path: '/admin', built: true },
      { id: 'companies', label: 'Companies', path: '/admin/companies', built: true },
      { id: 'people', label: 'People', path: '/admin/people', built: true },
      { id: 'operations', label: 'Operations', path: '/admin/operations', built: true },
      { id: 'goals', label: 'Goals', path: '/admin/goals', built: true },
      { id: 'analytics', label: 'Analytics', path: '/admin/analytics', built: true },
      { id: 'activity', label: 'Activity', path: '/admin/activity', built: true },
    ],
  },
  {
    id: 'admin-company',
    number: '12',
    label: 'Company Admin',
    path: '/admin',
    adminGate: 'company',
    subsections: [
      { id: 'overview', label: 'Overview', path: '/admin', built: true },
      { id: 'analytics', label: 'Analytics', path: '/admin/analytics', built: true },
      { id: 'automation', label: 'Automation', path: '/admin/automation', built: true },
      { id: 'activity', label: 'Activity', path: '/admin/activity', built: true },
      { id: 'settings', label: 'Settings', path: '/admin/settings', built: true },
    ],
  },
  // Session 43 (ADMIN_BUILD_GUIDE.md §3 "Session 5" — Super Admin UI).
  // `platform_admins` is a separate, non-org-scoped table (guide §1), not
  // an org membership, so unlike admin-group/admin-company above there's
  // no structural guarantee a platform admin never also holds a
  // group/company leader membership — a distinct `/admin/platform` path
  // (not the shared `/admin` the other two use) avoids any real or
  // theoretical route collision rather than relying on the same
  // "mutually exclusive per session" reasoning those two give for
  // sharing one path.
  {
    id: 'admin-platform',
    number: '13',
    label: 'Super Admin',
    path: '/admin/platform',
    adminGate: 'platform',
    subsections: [
      { id: 'overview', label: 'Overview', path: '/admin/platform', built: true },
      { id: 'organizations', label: 'Organizations', path: '/admin/platform/organizations', built: true },
      { id: 'users', label: 'Users', path: '/admin/platform/users', built: true },
      // Billing Review Queue — the UI half of superAdmin.ts's own
      // "Billing review queue (Session 47)" block (GET .../review-queue,
      // POST .../review-queue/:orgId/resolve), named alongside Settings
      // > Billing above as a Session 47 "Next steps" gap ("a Super Admin
      // review-queue screen... no frontend work done this session").
      { id: 'billing', label: 'Billing Review Queue', path: '/admin/platform/billing', built: true },
      { id: 'audit', label: 'Audit & Security', path: '/admin/platform/audit', built: true },
    ],
  },
];
