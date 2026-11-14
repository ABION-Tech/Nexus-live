// @nexus/shared — types shared between apps/web and apps/api.
// Source of truth: NEXUS-PRD.md §9 (Data Model) and §13.3 (Authorisation).
// Add types here only once a shape is needed by BOTH sides — one-sided
// types stay local to their app (PRD §6.2 abstraction rule: don't abstract
// hypothetical future things).

export type Role = 'leader' | 'team_member' | 'intern' | 'guest';

/** Session 53 — the roles an org member can be assigned (guests are managed separately). */
export type MemberRole = Exclude<Role, 'guest'>;

/** Session 53 — a pending invite as shown in Team & Roles / the Super Admin org drawer. */
export interface PendingInvite {
  id: string;
  orgId: string;
  email: string;
  role: MemberRole;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  grantPlatformAdmin: boolean;
  /** Session 57: they already have a NEXUS account and will Join or
   * Decline from inside the app. Only set on the create response. */
  existingAccount?: boolean;
}

/** Session 53 — one row of Platform > Super Admins. */
export interface PlatformAdminEntry {
  userId: string;
  name: string;
  email: string;
  grantedAt: string;
  grantedByName?: string;
}

/** Session 57 — one company this person belongs to (the switcher). */
export interface Workspace {
  orgId: string;
  name: string;
  orgType: 'group' | 'company';
  /** The group a company sits under, if any. */
  parentName?: string;
  role: string;
  /** The company you land in when you sign in. */
  isHome: boolean;
  /** The company this session is in right now. */
  isCurrent: boolean;
}

/** Session 57 — an invitation waiting for someone who already has an
 * account. They choose Join or Decline. */
export interface WorkspaceInvitation {
  id: string;
  orgId: string;
  orgName: string;
  role: string;
  invitedByName?: string;
  createdAt: string;
  expiresAt: string;
}

/** Session 57 — a task in the cross-company "All my companies" view. */
export interface CrossCompanyTask {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  /** How this person is involved. */
  role: 'owner' | 'support' | 'supervisor';
  startDate?: string;
  deadline?: string;
  department?: string;
  business?: string;
  updatedAt: string;
  company: { id: string; name: string };
}

// ADMIN_BUILD_GUIDE.md §1 (repo Session 37). 'guest' is a real
// org_memberships.role value (0016_admin_foundation.sql) but is never
// offered by the normal invite flow (routes/invites.ts's own VALID_ROLES
// deliberately excludes it) — guests are provisioned via
// guestService.ts's separate credential flow instead.
export const INVITABLE_ROLES: Role[] = ['leader', 'team_member', 'intern'];

// ADMIN_BUILD_GUIDE.md §1 — organizations.org_type (0006), restated here
// as a real union now that authorizationService/organizationService key
// off it directly, rather than each reading the raw column string.
export type OrgType = 'group' | 'company';

export interface Organization {
  id: string;
  name: string;
  orgType: OrgType;
  parentOrgId?: string; // group's own id, for a company; undefined for a group or an independent company
  plan: 'free' | 'paid'; // hook only — no billing enforcement yet (guide §1)
  active: boolean;
  createdAt: string;
}

export interface PlatformAdmin {
  userId: string;
  grantedByUserId?: string;
  grantedAt: string;
}

// PRD §13.3 — resource+action-scoped permission grant, replaces the MVP's
// per-tab Trusted_* flags. `PermissionAction` mirrors the DB check
// constraint on `permissions.action` (0001_init.sql) exactly — rbac.ts's
// own `hasPermission`/`requirePermission` re-export this rather than
// keeping an independently-typed copy.
//
// Session 36: this type predates permissionService.ts (the grant/revoke
// routes that finally read/write this table) and had drifted from the
// row it now needs to represent — no `id` at all (every other DB-backed
// type here carries one), and `grantedBy` rather than the
// `<noun>UserId` convention every other user-reference field in this
// package uses (ChatMessage.authorUserId, Task.assignedToUserId, …).
// Corrected in place rather than left stale now that something actually
// constructs and returns this shape.
export interface Permission {
  id: string;
  userId: string;
  orgId: string;
  resource: string; // e.g. "tasks", "goals", "chat"
  action: PermissionAction;
  grantedByUserId: string;
  grantedAt: string; // ISO timestamp
}

export type PermissionAction = 'read' | 'create' | 'update' | 'delete' | 'approve' | 'export';

// Session 36 — the full resource+action surface actually gated by
// `hasPermission`/`requirePermission` calls across apps/api/src/routes,
// grep'd from the live routes rather than hand-maintained, so the grant
// UI's picker only ever offers a pair that some route genuinely checks.
// `permissions` itself is included: a leader can delegate grant/revoke
// to a trusted non-leader the same way as any other resource — there's
// nothing structurally special about this resource in rbac.ts.
//
// `ai_cross_reference` (repo Session — ADMIN_BUILD_GUIDE.md "AI chat
// cross-referencing"): its own resource, not a `chat` action, per the
// guide's own locked decision ("not implicit in existing AI Analyst
// access... own permission check"). Read-only (`read` is the only
// action — there's nothing to create/update/delete, it's a pure
// capability flag) and org-scoped like every other resource+action pair
// here (no group-wide variant — see chatContextService.ts's own header
// comment for why a broader grant level was rejected). Holding this
// grant means the org-wide 'ai' chat thread (never task threads, which
// get no AI reply at all — see chatService.ts) is answered with a
// live snapshot of this org's own tasks/goals/roster folded into the
// prompt, instead of the "I don't have that data connected" default
// every other caller still gets.
export const PERMISSION_RESOURCE_ACTIONS: Record<string, PermissionAction[]> = {
  agent_handoffs: ['create', 'read'],
  ai_cross_reference: ['read'],
  ai_reports: ['read'],
  analytics: ['read'],
  automation: ['read', 'update'],
  calendar: ['create', 'read', 'delete'],
  chat: ['create', 'read', 'export'],
  eod: ['create', 'read'],
  files: ['create', 'read', 'delete'],
  goals: ['approve', 'create', 'delete', 'read', 'update'],
  knowledge: ['create', 'delete', 'read', 'update'],
  leave: ['approve', 'create', 'delete', 'read'],
  marketing: ['create', 'delete', 'read', 'update'],
  meetings: ['create', 'delete', 'read', 'update'],
  onboarding: ['create', 'delete', 'read', 'update'],
  permissions: ['create', 'delete', 'read'],
  projects: ['create', 'delete', 'read', 'update'],
  settings_ai: ['read', 'update'],
  tasks: ['create', 'delete', 'read', 'update'],
  users: ['create', 'delete'],
};

export interface User {
  id: string;
  orgId: string;
  name: string;
  email: string;
  role: Role;
  avatarUrl?: string;
  createdAt: string;
}

// Session 50 — PRD §14 light/dark toggle. Kept as its own exported type
// (not inlined as `'light' | 'dark'` at each call site) so the API route,
// the DB check constraint's allowed values, and the web ThemeContext all
// derive from one place rather than three copies that could drift.
export type ThemePreference = 'light' | 'dark';

// Session 11 (routes/notifications.ts) — PRD §10.4 two-axis preference
// model, finally with a real screen. Enumerated exactly as the type
// strings notifyInApp callers already use (automationJobs.ts) — not a
// speculative larger set — so isNotificationType() rejects anything that
// isn't actually produced anywhere yet rather than silently accepting a
// typo'd value the UI would never show a row for.
export const NOTIFICATION_TYPES = [
  'overdue',
  'eod_reminder',
  'eod_missing_summary',
  'escalation',
  'deadline_soon',
  'digest',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  overdue: 'Overdue task',
  eod_reminder: 'EOD reminder',
  eod_missing_summary: 'Missing EOD summary',
  escalation: 'Follow-up escalation',
  deadline_soon: 'Deadline approaching',
  digest: 'Daily digest',
};

// email/whatsapp stay reserved in the `notifications.channel` check
// constraint (0009_remaining_entities.sql) for when EmailService/a
// WhatsApp provider actually exist — this preference grid only offers
// the two channels that currently have a real sender wired
// (notifyInApp for in_app, webPushProvider.ts for push).
export const NOTIFICATION_CHANNELS = ['in_app', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface NotificationPreference {
  notificationType: NotificationType;
  channel: NotificationChannel;
  enabled: boolean;
}

export interface NotificationInboxEntry {
  id: string;
  type: string;
  channel: string;
  title: string;
  body: string | null;
  taskId: string | null;
  readAt: string | null;
  createdAt: string;
}

// Shape PushSubscription.toJSON() returns in the browser — passed
// through unchanged to POST /notifications/subscribe.
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// Picker-shaped view of a User — no orgId/createdAt, since a picker
// (assignee/owner dropdown) never needs to know or display those; keeping
// this distinct from User means peopleService.ts's query only has to
// SELECT the columns it actually returns.
export interface Person {
  id: string;
  name: string;
  email: string;
  role: Role;
  avatarUrl?: string;
}

// PRD §8.2 / §9 tasks table
export type TaskStatus = 'not_started' | 'in_progress' | 'blocked' | 'done';

// 0033_task_priority.sql — restored after being found missing from the
// rebuild (PRD §8.2/§13.7: drives ESCALATION_TIERS timing and the AI
// Attention Queue's ranking in the legacy system). 'medium' is the
// column default, not a type-level default — always send it explicitly.
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';

export interface Task {
  id: string;
  orgId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  startDate?: string; // 0034_abion_demo_seed_gaps.sql — ISO date; when work on this task begins, distinct from `deadline`
  assignedToUserId?: string;
  supportUserId?: string;
  supervisorUserId?: string;
  dependsOnTaskId?: string;
  goalId?: string;
  sourcePendingTaskId?: string;
  business?: string;
  department?: string;
  deadline?: string;
  createdAt: string;
  updatedAt: string;
  // PRD §6.4.1 — DELETE archives, never hard-deletes. Null/undefined means
  // active; a route or list query filters on this, never removes the row.
  archivedAt?: string;
  // 0014_marketing_content_tasks.sql — set when this task is one of a
  // marketing_content item's generated stages (Script/Production/SMM).
  // Undefined for every other task in the system.
  marketingContentId?: string;
  // Session 38 — mirrors goalId exactly (nullable FK to projects). A
  // task can belong to a goal, a project, both, or neither; nothing
  // here disallows that combination, same as business/department.
  projectId?: string;
}

// taskService.listTasks — filters and pagination the `GET /tasks` route
// exposes as query params. Kept here (not local to the api app) because
// apps/web's future task list will construct the same shape.
export interface TaskListQuery {
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedToUserId?: string;
  // Session 35 — "assigned to me OR I'm the support OR I'm the
  // supervisor" (the AI Analyst "My Tasks" tab / task drawer visibility
  // rule). Kept separate from assignedToUserId rather than folded into
  // it: a caller may explicitly want the narrower assignment-only view,
  // and routes/tasks.ts's own default only widens to this when neither
  // filter was requested.
  involvingUserId?: string;
  goalId?: string;
  // Session 38 — mirrors goalId's filter, same reasoning.
  projectId?: string;
  includeArchived?: boolean;
  page?: number;
  pageSize?: number;
}

// PRD §8.3 / §9 Network domain — network_cos, partnerships, org_contacts
// (0008_network.sql). Three MVP tabs ('2. COS', '3. Partnerships',
// '4. Org Database') consolidated into one section, three tables sharing
// no ownership model where the MVP genuinely had none (COS) and a real
// owner where it did (the other two) — see the migration's own comment.

export type NetworkCosStatus = 'not_started' | 'acknowledged' | 'in_progress' | 'follow_up_needed' | 'active';

export interface NetworkCos {
  id: string;
  orgId: string;
  state: string;
  adminName?: string;
  adminPhone?: string;
  adminEmail?: string;
  whatsappGroupCreated: boolean;
  membersCount?: number;
  status: NetworkCosStatus;
  lastReportDate?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export type PartnershipStatus = 'not_started' | 'in_discussion' | 'negotiating' | 'cold' | 'active' | 'declined';
export type DocumentStatus = 'not_started' | 'draft_sent' | 'under_review' | 'signed' | 'na';

export interface Partnership {
  id: string;
  orgId: string;
  assignedToUserId?: string;
  organisation: string;
  contactName?: string;
  contactEmail?: string;
  category?: string;
  currentStatus: PartnershipStatus;
  documentStatus: DocumentStatus;
  lastContactDate?: string;
  followUpDate?: string;
  remarks?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export type LetterStatus = 'not_sent' | 'sent' | 'acknowledged';
export type OnboardingStatus = 'pending' | 'in_progress' | 'active' | 'declined';

export interface OrgContact {
  id: string;
  orgId: string;
  contactOwnerUserId?: string;
  visitorName: string;
  position?: string;
  companyOrg?: string;
  email?: string;
  phone?: string;
  state?: string;
  staffSize?: string;
  dateVisited?: string;
  letterStatus: LetterStatus;
  onboardingStatus: OnboardingStatus;
  whatsappAdded: boolean;
  followUpDate?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

// PRD §8.5 — goal lifecycle
export type GoalStatus = 'drafting' | 'active' | 'archived';

export interface Goal {
  id: string;
  orgId: string;
  title: string;
  status: GoalStatus;
  createdByUserId: string;
  createdAt: string;
}

// PRD §9 pending_ai_tasks — goal decomposition proposals awaiting review.
// Matches database/migrations/0001_init.sql — see DECISIONS.md #1 for why
// dependency is a self-referencing FK rather than the MVP's positional
// Depends_On_Index (a sheet-row index isn't a stable reference once rows
// move to a relational table with no fixed order).
export interface PendingAiTask {
  id: string;
  orgId: string;
  goalId: string;
  title: string;
  description?: string;
  dependsOnPendingTaskId?: string;
  reasoning?: string;
  status: 'pending' | 'approved' | 'rejected';
  rejectionReason?: string;
  reviewedBy?: string; // 0034_abion_demo_seed_gaps.sql — who approved/rejected this, distinct from createdByUserId on the parent Goal
  reviewedAt?: string;
  createdAt: string;
}

// PRD §8.5 — "AI decomposes into 4–10 tasks". AIService (§10.2) doesn't
// exist yet, so nothing in this codebase actually calls an AI provider
// to produce these; `POST /goals` and `POST /goals/:id/regenerate`
// accept a caller-supplied array of this shape instead, so the
// propose→review→approve contract can be built and tested end-to-end
// now and swapped for a real AIService call later without changing this
// type or the approvals routes — same "port the pattern, not just the
// feature" principle PRD §4 applies to the policy engine. `dependsOnIndex`
// (not a UUID — none exist yet at request time) references an earlier
// entry in the same array, resolved to a real self-referencing FK
// server-side after insert.
export interface ProposedTaskInput {
  title: string;
  description?: string;
  reasoning?: string;
  dependsOnIndex?: number;
}

// goalService.getGoalWithProgress — goal + constituent task progress, per
// PRD §6.4.1 `GET /goals/:id → goal + constituent tasks + completion %`.
export interface GoalWithProgress extends Goal {
  taskCount: number;
  doneTaskCount: number;
  completionPercent: number; // 0 when taskCount is 0 — no tasks yet is not 100% done
  tasks: Task[];
  pendingTasks: PendingAiTask[];
}

// PRD §7.2 lists Projects as "future — not in MVP, not in v1" — that
// was true until ADMIN_BUILD_GUIDE.md's org/guest/projects build
// (Session 38, repo numbering) revisited it. Same shape as Goal, twice
// over: GoalWithProgress (goalService.ts) and marketing_content's
// "entry + chained stage tasks" (marketingService.ts) both already do
// "container + constituent tasks in one payload" — Project is that
// pattern applied a third time, not a new one (ADMIN_BUILD_GUIDE.md §2).
export type ProjectStatus = 'active' | 'archived';

export interface Project {
  id: string;
  orgId: string; // owning org
  title: string;
  description?: string;
  status: ProjectStatus;
  createdByUserId: string;
  createdAt: string;
}

// projectService.getProjectWithTasks — mirrors GoalWithProgress exactly
// (ADMIN_BUILD_GUIDE.md §2: "ProjectWithTasks — project + constituent
// tasks, mirroring GoalWithProgress exactly"). No completion percent —
// unlike a Goal, a Project isn't framed around driving to 100% and
// archiving; it's an ongoing container. taskCount/doneTaskCount are
// still useful for the list view's trimmed summary, so they're kept.
export interface ProjectWithTasks extends Project {
  taskCount: number;
  doneTaskCount: number;
  tasks: Task[];
  members: ProjectMember[];
}

// project_memberships row, joined with the member's own identity — the
// cross-org access grant DECISIONS.md §5 sketched and deferred out of
// 0006. `orgId` here is the member's own home org (for display — "this
// person is from Company B"), not the project's owning org; contrast
// with the DB row itself, where `project_memberships.org_id` is the
// project's owning org for RLS purposes (see 0017_projects.sql's own
// comment on that distinction).
export interface ProjectMember {
  userId: string;
  name: string;
  email: string;
  orgId: string; // the member's own home org, may differ from the project's owning org
  addedByUserId?: string;
  createdAt: string;
}

// PRD §8.2 Meetings + §8.9's "record, link to Fireflies/Zoom/Google Meet"
// ask (0009_remaining_entities.sql for the base table, 0035_meeting_
// recordings.sql for the recording/transcript side and zoomMeetingId).
export type MeetingLocationType = 'physical' | 'zoom' | 'google_meet';

export interface Meeting {
  id: string;
  orgId: string;
  title: string;
  locationType: MeetingLocationType;
  locationDetail?: string; // address, Zoom link, or blank for Meet (found by title search per 0009's own note)
  startTime: string;
  endTime?: string;
  organizerUserId?: string;
  googleCalendarEventId?: string;
  zoomMeetingId?: string;
  notes?: string;
  // 0034_abion_demo_seed_gaps.sql — first-class columns that were previously
  // unwritable (legacy Agenda, Team_Invitees, External_Emails were folded
  // into `notes` as a workaround before 0034 landed them as real columns).
  agenda?: string;
  inviteeUserIds: string[]; // uuid[] not null default '{}' in DB — always an array
  externalEmails?: string; // free text list; external attendees aren't `users` rows
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface CreateMeetingInput {
  title: string;
  locationType: MeetingLocationType;
  locationDetail?: string;
  startTime: string;
  endTime?: string;
  organizerUserId?: string;
  zoomMeetingId?: string;
  notes?: string;
  // 0034_abion_demo_seed_gaps.sql — first-class columns landing
  // what legacy data stored in `notes` as a workaround.
  agenda?: string;
  inviteeUserIds?: string[];
  externalEmails?: string;
}

export type UpdateMeetingInput = Partial<CreateMeetingInput>;

// meeting_recordings — see 0035's own header for the full reasoning.
// match_status is what the review queue (routes/meetings.ts's
// /recordings/unmatched) actually filters on; match_method is kept
// alongside it as the audit trail for HOW a matched row got there, not
// just that it did.
export type MeetingRecordingSource = 'zoom' | 'google_meet' | 'fireflies';
export type MeetingRecordingMatchMethod = 'exact_id' | 'time_window' | 'manual';
export type MeetingRecordingMatchStatus = 'matched' | 'ambiguous' | 'unmatched';

export interface MeetingRecording {
  id: string;
  orgId: string;
  meetingId?: string; // absent while ambiguous/unmatched
  source: MeetingRecordingSource;
  externalMeetingId?: string;
  externalTranscriptId?: string;
  recordingUrl?: string;
  transcriptUrl?: string;
  transcriptText?: string;
  callStartTime?: string;
  callEndTime?: string;
  matchMethod: MeetingRecordingMatchMethod;
  matchStatus: MeetingRecordingMatchStatus;
  candidateMeetingIds: string[];
  createdAt: string;
}

// The one shape n8n's HTTP node is expected to POST, whichever of
// Fireflies/Zoom/Google Meet the workflow actually pulled from — n8n
// normalizes to this before it reaches NEXUS (Integrations.tsx's "n8n's
// Fireflies → NEXUS webhook" label), so the ingest endpoint never needs
// per-vendor payload parsing of its own.
export interface MeetingIngestPayload {
  source: MeetingRecordingSource;
  externalMeetingId?: string;
  externalTranscriptId?: string;
  organizerEmail?: string;
  recordingUrl?: string;
  transcriptUrl?: string;
  transcriptText?: string;
  callStartTime: string;
  callEndTime?: string;
}

// PRD §8.7 / §9 task_trends — daily snapshot table (0001_init.sql), written
// by the 23:00 `recordDailyTaskSnapshot_` job (PRD §11 schedule table).
// Shared because both the analytics route and the Analytics module's chart
// need the exact same shape.
export interface TaskTrendPoint {
  date: string; // ISO date (YYYY-MM-DD), not a full timestamp — one row per day
  userId?: string; // absent = org-wide snapshot row
  openTasks: number;
  doneToday: number;
  overdue: number;
  atRisk: number;
}

export interface TaskTrendQuery {
  from?: string; // ISO date, inclusive
  to?: string; // ISO date, inclusive
  userId?: string;
}

// PRD §9.1 eod_logs (from "5. KPI Log"), §8.9 EOD Report, §8.7 EOD
// compliance summary. One row per (user, date) — re-filing the same day
// amends the existing row rather than creating a duplicate.
export interface EodLog {
  id: string;
  orgId: string;
  userId: string; // who the EOD is filed for
  filedByUserId: string; // who submitted it — may differ (PRD §8.9 "who am I filing for" selector)
  date: string; // ISO date
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubmitEodInput {
  userId?: string; // defaults to the caller — see routes/eod.ts
  date: string; // ISO date
  summary: string;
}

// PRD §8.4: "EOD-day-aware — only flags members scheduled to
// report today." expectedCount/filedCount are both scoped to that same
// EOD-day-aware set, not every active user — a 100% compliance day with
// only 2 of 12 members scheduled should read as 2/2, not 2/12.
export interface EodComplianceSummary {
  date: string;
  expectedCount: number;
  filedCount: number;
  compliancePercent: number; // 0 when expectedCount is 0 — no one scheduled is not 0% compliant
}

export interface MissingEodUser {
  userId: string;
  name: string;
}

// People > Attendance (PRD §8.4). Same EOD-day-aware expected set as
// EodComplianceSummary/MissingEodUser above, but per-user rather than
// aggregated/filtered — Attendance wants to show everyone expected today
// and whether each one filed, not just the compliance percent or just
// the gap list.
export interface AttendanceEntry {
  userId: string;
  name: string;
  filed: boolean;
}

// PRD §9.1 knowledge_entries (← "23. Knowledge Base"), §8.6. No
// per-record owner in the source sheet — `updatedByUserId` tracks last
// editor for display, not an access-control field (unlike Partnerships'
// `assignedToUserId`); Knowledge access is a flat `knowledge` resource
// grant, same shape as goals.ts, not an own-record branch.
export interface KnowledgeEntry {
  id: string;
  orgId: string;
  title: string;
  content: string;
  category?: string;
  updatedByUserId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface KnowledgeEntryInput {
  title: string;
  content: string;
  category?: string;
}

export interface KnowledgeListQuery {
  search?: string; // matches title or content, PRD §8.6 "add structured search/filter"
  category?: string;
  includeArchived?: boolean;
}

export type ExecutionStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';

export interface Execution {
  id: string;
  orgId: string;
  agentName: string;
  status: ExecutionStatus;
  requestedByUserId: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// AI Settings (PRD §7.2 11 SETTINGS > Integrations) — the org's
// OpenAI-compatible provider connection (NVIDIA NIM or anything else that
// speaks the same API shape). Not tied to one vendor: see
// apps/api/src/integrations/aiProvider.ts. The model list here is the
// selectable catalog for the Chat/Report model dropdowns — kept in
// @nexus/shared so it isn't duplicated between the API's validation and
// the web Select options.
export const AI_MODEL_OPTIONS = [
  'GLM 5.2',
  'Kimi K2.5',
  'MiniMax M2.5',
  'Nemotron 3 Super',
] as const;
export type AiModelOption = (typeof AI_MODEL_OPTIONS)[number];
export const DEFAULT_AI_MODEL: AiModelOption = 'GLM 5.2';

/** What the API returns from GET /settings/ai — secrets are never echoed
 * back, only whether one is currently saved, so the UI can show "A key is
 * currently saved — leave blank to keep it." without ever holding the
 * real value client-side. */
export interface AiSettings {
  baseUrl: string | null;
  hasApiKey: boolean;
  chatModel: string;
  reportModel: string | null;
  hasMeetingIngestSecret: boolean;
  updatedAt: string | null;
}

/** What PUT /settings/ai accepts. A blank/omitted apiKey or
 * meetingIngestSecret means "keep whatever is already saved" — never
 * "clear it" — matching the mockup's own copy for both fields. */
export interface AiSettingsInput {
  baseUrl?: string;
  apiKey?: string;
  chatModel: string;
  reportModel?: string;
  meetingIngestSecret?: string;
}

export type AiTestTarget = 'chat' | 'report';

export interface AiTestResult {
  ok: boolean;
  model: string;
  message: string;
}

// AI usage tracking (ADMIN_BUILD_GUIDE.md §3, 0018_ai_usage.sql, repo
// Session 39). `feature` is which product surface made the call;
// `providerTarget` is which Settings > Integrations slot ('chat' vs
// 'report') was actually resolved to serve it — the two diverge for
// goal_decomposition/agent_handoff, which both resolve the 'chat'
// target today (aiService.ts's own choice, not a 1:1 mapping).
export type AiUsageFeature = 'goal_decomposition' | 'chat' | 'report' | 'agent_handoff';

export interface AiUsageRecord {
  id: string;
  orgId: string;
  actorUserId?: string;
  feature: AiUsageFeature;
  providerTarget: AiTestTarget;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  success: boolean;
  errorMessage?: string;
  createdAt: string;
}

/** Aggregate view — not a persisted table, computed on read from
 * ai_usage the same way AiReportSignals is computed on read from tasks/
 * task_trends rather than stored pre-aggregated. */
export interface AiUsageSummary {
  totalCalls: number;
  successCount: number;
  failureCount: number;
  totalTokens: number;
  averageLatencyMs: number;
  byFeature: Record<AiUsageFeature, { calls: number; totalTokens: number }>;
}

// Chat (PRD §8.11, 0009_remaining_entities.sql chat_messages) — backing
// AI Analyst > Chat (PRD §7.2 08). The table models three channels
// (task-scoped threads, team-wide, and AI), but only the 'ai' one has a
// page in the IA today — the type still carries all three so 'team'/
// 'task' aren't a breaking addition whenever those get built.
export type ChatChannel = 'task' | 'team' | 'ai';

export interface ChatMessage {
  id: string;
  orgId: string;
  channel: ChatChannel;
  taskId?: string;
  /** Absent for AI/system-authored messages — same convention as the
   * `author_user_id` column itself (0009's own comment: "null for
   * system/AI-injected messages"). */
  authorUserId?: string;
  body: string;
  createdAt: string;
}

/** POST /chat's response shape. `aiMessage` is null (with `aiError` set)
 * rather than a fabricated placeholder row when the AI provider call
 * itself fails — the user's own message still saved and returned
 * regardless, so a failed AI turn never loses what they typed. */
export interface SendChatMessageResult {
  userMessage: ChatMessage;
  aiMessage: ChatMessage | null;
  aiError?: string;
  /** True when `aiMessage` was produced with the `ai_cross_reference`
   * context folded into the prompt (chatContextService.ts). Deliberately
   * not a field on `ChatMessage`/`chat_messages` itself — this is a
   * property of how *this specific reply* was generated, not of the
   * message row, and doesn't need to survive a page reload or travel
   * over the SSE broadcast the way the message body does; a caller who
   * wasn't there for the live POST response has no use for it. Absent
   * (not `false`) when cross-referencing wasn't used, same "absence
   * means no" convention `aiError` already follows here. */
  crossReferenced?: boolean;
}

/** GET /chat's response shape (Session 33) — `messages` oldest-first,
 * same convention as the original unpaged endpoint, plus `hasMore` so
 * the client knows whether to render a "Load earlier" affordance rather
 * than inferring it from `messages.length === limit` (which breaks the
 * moment a page happens to land exactly on the limit with nothing older
 * left). */
export interface ChatMessagePage {
  messages: ChatMessage[];
  hasMore: boolean;
}

// AI Analyst > Reports (PRD §8.8 / §7.2 08). Three modes, same anti-
// fabrication posture as §11 Appendix C's computePredictionSignals_ note:
// "Deterministic signal computation — AI narrates these, not invents
// them." No reports table exists yet (PRD O7: "Confirmed: no... net-new
// schema" — deferred), so this is an on-demand generate-and-return shape,
// not a persisted/re-fetchable resource.
export type AiReportMode = 'attention' | 'predictions' | 'custom';

export interface AiReportRequest {
  mode: AiReportMode;
  /** 'custom' mode only — inclusive ISO date range for the underlying
   * task-trend window. Ignored for 'attention'/'predictions'. */
  from?: string;
  to?: string;
}

/** The deterministic counts the narration is grounded in — surfaced back
 * to the UI alongside the prose so a leader can see the AI didn't invent
 * a number that isn't in this object. */
export interface AiReportSignals {
  blockedCount: number;
  upcomingDeadlineCount: number;
  stalePartnerCount: number;
  trendPoints: TaskTrendPoint[];
  // 0033_task_priority.sql — open (not done, not archived) task counts by
  // priority, so the Attention Queue / Predictions narration can call out
  // "3 urgent tasks open" instead of only status-based counts. Computed
  // in analyticsService.ts (deterministic), same "AI narrates, doesn't
  // invent" contract as every other field on this interface.
  priorityBreakdown: Record<TaskPriority, number>;
}

export interface AiReportResult {
  mode: AiReportMode;
  narrative: string;
  signals: AiReportSignals;
  generatedAt: string;
}

// Agent Handoff (PRD §8.8 / §10.6, 0009_remaining_entities.sql
// agent_handoffs). Preserves the exact n8n-first / direct-AI-fallback /
// async-tracking contract PRD §10.6 and Appendix C call out as a
// reference implementation, not a placeholder.
export type AgentHandoffStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';

export interface AgentHandoff {
  id: string;
  orgId: string;
  taskId?: string;
  requestedByUserId?: string;
  instructions?: string;
  status: AgentHandoffStatus;
  n8nExecutionRef?: string;
  result?: string;
  createdAt: string;
  completedAt?: string;
}

export interface CreateAgentHandoffInput {
  taskId?: string;
  instructions: string;
}

// PRD §10.5 CalendarService / §8.2 Calendar — 0012_calendar.sql

/** A connected Google account. Never carries refresh_token/access_token
 * — those stay server-side only (PRD §13.4, "secrets never in React");
 * the frontend only ever needs enough to render "connected as
 * x@abion.org, added <date>" and offer disconnect. */
export interface CalendarConnection {
  id: string;
  orgId: string;
  userId: string;
  googleEmail: string;
  createdAt: string;
  revokedAt?: string;
}

/** One entry from a connection's Google calendar list — used only to
 * populate the "which calendar(s) do you want to sync" picker when
 * creating a subscription; not persisted itself. */
export interface GoogleCalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: string;
}

/** A specific Google calendar synced into NEXUS. connectionEmail is
 * denormalized onto reads (never write target) purely so the
 * subscriptions list can render "Team Calendar — via ayo@abion.org"
 * without a second round trip. */
export interface CalendarSubscription {
  id: string;
  orgId: string;
  connectionId: string;
  connectionEmail: string;
  googleCalendarId: string;
  calendarName: string;
  isActive: boolean;
  lastSyncedAt?: string;
  lastSyncError?: string;
  createdAt: string;
}

/** A locally-mirrored Google Calendar event. startAt/endAt are set for
 * timed events, startDate/endDate for all-day events — exactly one pair
 * is populated, matching Google's own start.dateTime vs start.date
 * distinction (toGoogleDateTime in calendarService.ts). */
export interface CalendarEvent {
  id: string;
  orgId: string;
  subscriptionId: string;
  calendarName: string;
  googleEventId: string;
  title: string;
  description?: string;
  location?: string;
  allDay: boolean;
  startAt?: string;
  endAt?: string;
  startDate?: string;
  endDate?: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  htmlLink?: string;
  attendees?: { email: string; displayName?: string; responseStatus?: string }[];
  createdByNexus: boolean;
}

/** POST/PATCH body for write-back create/update. Exactly one of
 * (startAt/endAt) or (startDate/endDate) should be sent, matching
 * `allDay`; the API takes whichever pair is present. */
export interface CalendarEventInput {
  title: string;
  description?: string;
  location?: string;
  allDay: boolean;
  startAt?: string;
  endAt?: string;
  startDate?: string;
  endDate?: string;
  attendeeEmails?: string[];
}

// PRD §7.2 04 PEOPLE / §8.4 — 0009_remaining_entities.sql's leave_requests
// table, 0013 adds decisionNote. Attendance has no matching type here on
// purpose — it stays derived from EodLog (above), never its own record.

export type LeaveStatus = 'pending' | 'approved' | 'rejected';

export interface LeaveRequest {
  id: string;
  orgId: string;
  userId: string;
  startDate: string; // date, YYYY-MM-DD
  endDate: string; // date, YYYY-MM-DD
  reason?: string;
  status: LeaveStatus;
  approvedByUserId?: string;
  decisionNote?: string;
  decidedAt?: string;
  createdAt: string;
}

export interface LeaveRequestInput {
  // Only settable when filing on someone else's behalf, and only with a
  // `leave.create` grant (routes/leave.ts) — mirrors eod.ts's own
  // "filing for" pattern. Omit to file for yourself.
  userId?: string;
  startDate: string;
  endDate: string;
  reason?: string;
}

export interface LeaveListQuery {
  userId?: string;
  status?: LeaveStatus;
}

// PRD §7.2 04 PEOPLE → Onboarding — 0013_leave_decision_note_and_onboarding.sql.
// Two-part model: `OnboardingStep` is the org's adjustable checklist
// template (leaders/authorized users edit this); `OnboardingChecklistItem`
// is that template joined against one user's completion state, which is
// what the frontend actually renders per new hire.

export interface OnboardingStep {
  id: string;
  orgId: string;
  title: string;
  description?: string;
  position: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OnboardingStepInput {
  title: string;
  description?: string;
  position?: number;
  isActive?: boolean;
}

export interface OnboardingChecklistItem {
  step: OnboardingStep;
  userId: string;
  completed: boolean;
  completedAt?: string;
  completedByUserId?: string;
}

// PRD §7.2 09 COMMS & OPS → Marketing / §8.9 content calendar.
// 0009_remaining_entities.sql's marketing_content table (← "6. Marketing"
// sheet) is the calendar entry itself (what/where/when). The actual work
// is a task, broken into three real, independently assignable stages —
// not a single owner field the way KnowledgeEntry's updatedByUserId is
// just display metadata. 0014_marketing_content_tasks.sql links `tasks`
// rows back here via marketing_content_id, chained script → production →
// smm via tasks' existing depends_on_task_id, so each stage gets its own
// assignee, deadline, and status through the Task infrastructure that
// already exists rather than a second, parallel assignment model.
export type MarketingContentStatus = 'planned' | 'in_progress' | 'posted' | 'skipped';

export interface MarketingContentItem {
  id: string;
  orgId: string;
  contentType?: string;
  platform?: string;
  caption?: string; // 0034_abion_demo_seed_gaps.sql — the actual post text/copy, distinct from contentType/platform metadata
  dueDate?: string; // ISO date — when it needs to post
  status: MarketingContentStatus;
  postLink?: string;
  ownerUserId?: string; // overall owner/point of contact, distinct from each stage's assignee
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface MarketingContentInput {
  contentType?: string;
  platform?: string;
  caption?: string;
  dueDate?: string;
  status?: MarketingContentStatus;
  postLink?: string;
  ownerUserId?: string;
}

export interface MarketingContentListQuery {
  status?: MarketingContentStatus;
  platform?: string;
  includeArchived?: boolean;
}

// The three fixed stages every content item is broken into. Assignee is
// optional per stage at creation time (a leader may know who's shooting
// before they know who's editing captions) — unassigned stage tasks just
// have no assignedToUserId, same as any other task.
export type MarketingStage = 'script' | 'production' | 'smm';

export const MARKETING_STAGE_LABELS: Record<MarketingStage, string> = {
  script: 'Script',
  production: 'Shoot / Cast / Edit',
  smm: 'SMM — Caption & Upload',
};

export interface MarketingStageInput {
  assignedToUserId?: string;
  deadline?: string; // ISO date or datetime
}

// POST /marketing body: the calendar-entry fields plus each stage's
// initial assignee/deadline. createMarketingContent (marketingService.ts)
// creates the marketing_content row and its three chained stage tasks in
// one transaction from this shape.
export interface CreateMarketingContentInput extends MarketingContentInput {
  script?: MarketingStageInput;
  production?: MarketingStageInput;
  smm?: MarketingStageInput;
}

// GET /marketing/:id shape — the calendar entry plus its three stage
// tasks, same "record + constituent tasks" pattern as GoalWithProgress.
// `stages` is always exactly the three MarketingStage tasks, keyed so the
// UI never has to guess which task is which by title-matching.
export interface MarketingContentWithStages extends MarketingContentItem {
  stages: Partial<Record<MarketingStage, Task>>;
  doneStageCount: number;
  stageCount: number; // always 3 once fully created; fewer only if a stage task was individually archived
}

// PRD §10.7 FileService / §13.1 S5 — scoped object storage attachments.
// Polymorphic resourceType/resourceId, same shape ActivityChange's own
// resourceType/resourceId already uses — a file can attach to any
// resource without a per-resource-type FK/table. First real consumer is
// EodReport.tsx's proof attachment (resourceType='eod_logs'), PRD §3's
// "interns submit proof links". Per-record ownership trust (PRD §13.3
// check 4) — own the eod_logs entry, or hold eod.read/eod.create — now
// layers on top of the flat files.read/create/delete grants as of
// Session 31; see routes/files.ts and services/fileResourceAuth.ts.
export interface FileRecord {
  id: string;
  orgId: string;
  resourceType: string;
  resourceId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedByUserId: string;
  /** Unset until confirmFileUpload — see fileService.ts's two-phase
   * upload comment. A row with this unset is an abandoned upload and is
   * never returned by list/download. */
  uploadedAt?: string;
  createdAt: string;
  archivedAt?: string;
  /** 0023: only ever set when resourceType === 'company_archive' — null
   * for every other resource type. Freeform (e.g. "policy", "template"),
   * filtered client-side. */
  category?: string;
}

export interface RequestFileUploadInput {
  resourceType: string;
  resourceId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  category?: string;
}

export interface RequestFileUploadResult {
  file: FileRecord;
  uploadUrl: string;
  expiresInSeconds: number;
}

export interface FileWithDownloadUrl extends FileRecord {
  downloadUrl: string;
  expiresInSeconds: number;
}

export interface FileListQuery {
  resourceType: string;
  resourceId: string;
  includeArchived?: boolean;
}

// 0023 Company docs/archive (ADMIN_BUILD_GUIDE.md Session 8). Not a new
// table — `company_archive` is just another `files.resource_type` value,
// scoped to the org itself: `resourceId` for this resource type is the
// org's own id, not a task/EOD row id. Named as a constant (rather than a
// literal string re-typed at each call site) purely so
// fileResourceAuth.ts, companyArchiveService.ts, and the route body all
// stay in sync if it's ever renamed.
export const COMPANY_ARCHIVE_RESOURCE_TYPE = 'company_archive' as const;

// PRD §8.10 Automation / §9.1 automation_controls, automation_log (←
// "8. Automation Controls", "13. Automation Log"). §12's 9 scheduled
// jobs are "a migration checklist, not a design question" — that closed
// set is exactly AUTOMATION_CONTROL_KEYS below, not an open string, so a
// toggle can't be created for a job that was never ported (or silently
// misspelled).
//
// This is the toggle-panel half of §8.10. The other half — "cron job
// health view (when each job last ran, last result, next run time)" —
// is built as of Phase H (0024_automation_scheduling.sql): see
// AutomationRunLogEntry/AutomationHealthEntry below, written by
// routes/automationMaintenance.ts and read via GET /automation/health.
// Two of the nine keys (daily_recurring_tasks, hourly_follow_up) still
// have no job implementation — not a wiring gap but a schema gap (PRD
// §12 describes both against columns that don't exist anywhere in this
// database) — see automationJobs.ts's own UNIMPLEMENTED_JOBS for the
// full reasoning.
export const AUTOMATION_CONTROL_KEYS = [
  'daily_overdue_check', // 08:00 dailyOverdueCheck — PRD §12
  'daily_morning_digest', // 08:00 sendDailyMorningDigest (Mon full / Tue–Fri light)
  'daily_dependency_sweep', // 09:00 dailyDependencyCheck
  'daily_recurring_tasks', // 10:00 dailyRecurringTasks
  'daily_cob_reminders', // 16:00 sendCOBReminders — EOD-day-aware
  'daily_follow_up_escalation', // 18:00 dailyFollowUpEmails (deadlineCheck folded in)
  'daily_eod_nudge', // 18:00 dailyEODNudge
  'daily_task_snapshot', // 23:00 recordDailyTaskSnapshot_
  'hourly_follow_up', // hourly 8am–7pm weekdays, runHourlyFollowUps
] as const;

export type AutomationControlKey = (typeof AUTOMATION_CONTROL_KEYS)[number];

export interface AutomationControl {
  id: string;
  orgId: string;
  key: AutomationControlKey;
  enabled: boolean;
  updatedByUserId?: string;
  updatedAt: string;
}

export interface AutomationLogEntry {
  id: string;
  orgId: string;
  controlKey: string;
  previousValue: boolean | null; // null on the control's first-ever toggle
  newValue: boolean;
  changedByUserId?: string;
  changedAt: string;
}

// ---------------------------------------------------------------------
// 0024 (Phase H) — automation_run_log. Real backing data for the
// cron-job-health half of §8.10 that automation.ts's own header flagged
// as deliberately unbuilt until a scheduler existed to produce true
// data. One entry per (job_key, org_id) per maintenance-endpoint
// invocation — see routes/automationMaintenance.ts.
// ---------------------------------------------------------------------
export interface AutomationRunLogEntry {
  id: string;
  orgId: string;
  jobKey: string;
  startedAt: string;
  finishedAt: string;
  status: 'success' | 'error';
  /** Job-specific summary — shape varies per jobKey (e.g. dependency
   * sweep: {tasksBlocked, tasksUnblocked}; snapshot: {rowsWritten}).
   * Deliberately loose rather than a per-job-key discriminated union —
   * see the migration's own comment on why this isn't normalized into
   * columns. */
  detail?: Record<string, unknown>;
  error?: string;
}

/** GET /automation/health response shape — one entry per §12 job,
 * closed set (AUTOMATION_CONTROL_KEYS order), each paired with whether
 * it has a real implementation yet and its most recent run, if any. See
 * automationService.ts's getAutomationHealth for why `lastRun` is
 * undefined (not a fabricated placeholder) for a job that hasn't run. */
export interface AutomationHealthEntry {
  key: AutomationControlKey;
  implemented: boolean;
  lastRun?: AutomationRunLogEntry;
}

// ---------------------------------------------------------------------
// Session 40 (ADMIN_BUILD_GUIDE.md §3 "Session 4 — Super Admin backend").
// audit_log itself is 0016_admin_foundation.sql (schema only, that
// session); this is the first typed read shape for it, now that
// auditLogService.ts's write side exists.
// ---------------------------------------------------------------------
export type AuditResult = 'success' | 'forbidden' | 'error';

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  userId?: string;
  orgId?: string; // undefined for a platform-level action (org creation, plan change, etc.)
  action: string;
  resourceType: string;
  resourceId?: string;
  ipAddress?: string;
  userAgent?: string;
  sessionId?: string;
  result: AuditResult;
  previousValue?: unknown;
  newValue?: unknown;
  metadata?: Record<string, unknown>;
}

export interface AuditLogQuery {
  orgId?: string;
  userId?: string;
  action?: string;
  resourceType?: string;
  result?: AuditResult;
  since?: string;
  until?: string;
  limit?: number;
}

// ---------------------------------------------------------------------
// Session 11 (ADMIN_BUILD_GUIDE.md §5 — Impersonation). Mirrors
// sessionService.ts's ImpersonationContext (API-internal) but as the
// wire shape the /admin/impersonation routes and a future frontend
// banner actually consume.
// ---------------------------------------------------------------------
export type ImpersonationMode = 'read_only' | 'write';

export interface ImpersonationContext {
  impersonationId: string;
  actorUserId: string;
  actorName: string;
  mode: ImpersonationMode;
  startedAt: string;
}

export interface StartImpersonationInput {
  targetUserId: string;
  targetOrgId: string;
  reason: string;
  mode?: ImpersonationMode;
}

export interface StartImpersonationResponse {
  impersonationId: string;
  mode: ImpersonationMode;
  expiresAt: string;
}

// System health — systemMetricsService.ts's own doc comment explains
// why this is a skeleton (each subsystem's real check is a later,
// separate piece of work, not this session's scope).
export type SubsystemStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface SubsystemHealth {
  name: 'api' | 'database' | 'ai' | 'email' | 'n8n' | 'notifications' | 'webhooks';
  status: SubsystemStatus;
  detail?: string;
  checkedAt: string;
}

export interface SystemHealthReport {
  overall: SubsystemStatus;
  subsystems: SubsystemHealth[];
}

// Super Admin investigation search — one shape covering the three
// nexus_bootstrap-owned search functions from 0019
// (search_organizations / search_users_platform / search_audit_log).
export interface PlatformUserSummary {
  id: string;
  name: string;
  email: string;
  homeOrgId?: string;
  homeOrgName?: string;
  role?: string;
  createdAt: string;
}

export interface PlatformAnalyticsSummary {
  totalOrganizations: number;
  totalGroups: number;
  totalCompanies: number;
  activeOrganizations: number;
  totalUsers: number;
  totalPlatformAdmins: number;
  generatedAt: string;
}

// Session 41 (ADMIN_BUILD_GUIDE.md §3 "Session 6", Group Admin backend
// half) — same shape family as PlatformAnalyticsSummary above, scoped to
// one group's own children instead of the whole platform.
export interface GroupAnalyticsSummary {
  groupOrgId: string;
  totalCompanies: number;
  activeCompanies: number;
  totalUsers: number;
  generatedAt: string;
}

// Session 41 (ADMIN_BUILD_GUIDE.md §3 "Session 6", Company Admin backend
// half) — aggregate counts across one company's own tenant data, assembled
// from existing service queries rather than new schema. "Thin layer" per
// the guide; the underlying data comes from tasks/goals/knowledge/people
// already present in every org.
export interface CompanyAnalyticsSummary {
  orgId: string;
  totalPeople: number;
  openTasks: number;
  blockedTasks: number;
  doneTasks: number;
  activeGoals: number;
  knowledgeEntries: number;
  generatedAt: string;
  /** 0023: total bytes across every uploaded file in the org (not just
   * company_archive — an archived-but-not-deleted EOD proof still costs
   * bucket storage, so it counts too; see getOrgStorageUsage). */
  storageUsedBytes: number;
  /** Resolved quota — organizations.storage_quota_bytes if set, else the
   * STORAGE_DEFAULT_ORG_QUOTA_BYTES env default. Always a concrete
   * number here so the UI never has to know about the fallback itself. */
  storageQuotaBytes: number;
}

// ---------------------------------------------------------------------
// Billing — Session 47 (SESSION_47_SCOPE_BILLING.md). Paystack, hybrid
// (flat tier fee + per-seat + capped usage) pricing, grace period then
// mandatory manual Super Admin review on payment failure (§1's locked
// decisions). Prices below are placeholders — the doc's own §3.5 flags
// real NGN pricing as still genuinely unscoped; these exist so the
// enforcement mechanism (caps, feature gates) has real numbers to test
// against, not so a paying customer sees them un-reviewed.
// ---------------------------------------------------------------------

export const BILLING_TIER_KEYS = ['free', 'starter', 'pro'] as const;
export type BillingTierKey = (typeof BILLING_TIER_KEYS)[number];

export const BILLING_STATUS_KEYS = ['active', 'past_due', 'pending_review', 'suspended'] as const;
export type BillingStatusKey = (typeof BILLING_STATUS_KEYS)[number];

// Feature keys gated by tier — checked via billingService.hasFeature(orgId,
// key). Deliberately a flat string union, not per-resource permissions
// (permissions/rbac.ts answers "can this user act on this org's data";
// this answers "does this org's plan include this capability at all" —
// two independent questions, checked at two different points in the
// same route in guests.ts/calendar.ts/automation.ts/aiReports.ts).
export const BILLING_FEATURE_KEYS = [
  'guest_invites',
  'calendar_sync',
  'automation',
  'ai_reports',
  'agent_handoff',
] as const;
export type BillingFeatureKey = (typeof BILLING_FEATURE_KEYS)[number];

export interface BillingTierDefinition {
  key: BillingTierKey;
  label: string;
  /** Base monthly price in kobo (NGN's lowest unit — Paystack's own
   * native amount unit). PLACEHOLDER — see file header. */
  basePriceKobo: number;
  /** Seats included in the base price before per-seat pricing kicks in. */
  includedSeats: number;
  /** Price per seat beyond includedSeats, per month, in kobo. Null on
   * `free` — free has a hard seatLimit instead (no paid overage path). */
  perSeatKobo: number | null;
  /** Hard seat cap. Null = uncapped (pro). Free/starter enforce this as
   * a hard block (open question #4's "seat cap" enforcement), not a
   * billable overage — going over means upgrade, not a bigger invoice,
   * since usage-based overage invoicing is explicitly out of scope this
   * session (see 0025_billing.sql's own header). */
  seatLimit: number | null;
  /** AI calls per billing period (aiUsage rows) before the cap blocks
   * further calls. Null = uncapped. */
  aiUsageLimit: number | null;
  /** Storage quota in bytes — feeds getOrgStorageQuota's tier lookup in
   * fileService.ts. */
  storageBytes: number;
  features: BillingFeatureKey[];
}

export const BILLING_TIERS: Record<BillingTierKey, BillingTierDefinition> = {
  free: {
    key: 'free',
    label: 'Free',
    basePriceKobo: 0,
    includedSeats: 5,
    perSeatKobo: null,
    seatLimit: 5,
    aiUsageLimit: 50,
    storageBytes: 500 * 1024 * 1024, // 500MB — matches fileService's pre-existing DEFAULT_ORG_QUOTA_BYTES
    features: [],
  },
  starter: {
    key: 'starter',
    label: 'Starter',
    basePriceKobo: 1_500_000, // ₦15,000/mo placeholder
    includedSeats: 10,
    perSeatKobo: 100_000, // ₦1,000/seat/mo placeholder
    seatLimit: 25,
    aiUsageLimit: 500,
    storageBytes: 5 * 1024 * 1024 * 1024, // 5GB
    features: ['guest_invites', 'calendar_sync'],
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    basePriceKobo: 5_000_000, // ₦50,000/mo placeholder
    includedSeats: 25,
    perSeatKobo: 150_000, // ₦1,500/seat/mo placeholder
    seatLimit: null,
    aiUsageLimit: 5000,
    storageBytes: 50 * 1024 * 1024 * 1024, // 50GB
    features: ['guest_invites', 'calendar_sync', 'automation', 'ai_reports', 'agent_handoff'],
  },
};

export interface BillingSummary {
  orgId: string;
  /** The org whose org_billing row is actually in effect — equal to
   * orgId unless this org is a company inheriting a cascading parent
   * group's billing (Session 47 open question #3's "Either" answer). */
  effectiveSourceOrgId: string;
  tier: BillingTierKey;
  billingStatus: BillingStatusKey;
  seatCount: number;
  seatLimit: number | null;
  aiUsageThisPeriod: number;
  aiUsageLimit: number | null;
  storageUsedBytes: number;
  storageQuotaBytes: number;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  gracePeriodEndsAt?: string;
  features: BillingFeatureKey[];
}

// billingService.ts's listInvoices/listBillingPendingReview/
// resolveBillingReviewEntry return types (Session 47 UI follow-up —
// these three used to send raw `select *` rows straight to the client;
// moved through mappers so the wire shape matches everything else this
// app returns).

export interface BillingInvoice {
  id: string;
  paystackReference: string;
  amountKobo: number;
  currency: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
}

export interface BillingReviewQueueEntry {
  orgId: string;
  orgName: string;
  tier: BillingTierKey;
  billingStatus: BillingStatusKey;
  gracePeriodEndsAt: string | null;
  reviewNote: string | null;
  updatedAt: string;
}

export interface ResolvedBillingReview {
  id: string;
  orgId: string;
  tier: BillingTierKey;
  billingStatus: BillingStatusKey;
  seatCount: number;
  cascadesToChildren: boolean;
  gracePeriodEndsAt: string | null;
  reviewNote: string | null;
  updatedAt: string;
}

