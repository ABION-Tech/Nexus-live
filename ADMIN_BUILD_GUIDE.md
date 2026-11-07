# NEXUS — Admin, Org Hierarchy, Guests & Projects
## Final Session Guide (9 Sessions)

Status: **Planning locked. No code written yet.** This document is the reference
for implementation — each session should be scoped to exactly what's listed
here, in this order, with dependencies respected.

---

## 0. Context — why this exists

The original ask was a full administration/analytics/observability layer for
NEXUS: platform-level Super Admin, optional Groups containing Companies,
independent Companies, hierarchical analytics, AI cost tracking, system
health, and audit logging.

Inspection of the existing codebase found the organizational foundation
**already mostly built**, just not surfaced as admin UI:

- `organizations.org_type` (`group`/`company`) + self-referencing
  `parent_org_id` already exist (migration `0006_org_hierarchy_memberships.sql`).
- Independent companies already work (`parent_org_id = null`).
- `org_memberships` already supports one user holding different roles in
  different orgs simultaneously.
- `DECISIONS.md` §5 already established the doctrine for cross-org reads:
  **never widen RLS to match multiple orgs in one query.** Cross-org views
  are N separately-scoped queries, merged at the API layer. This doctrine
  is extended, not overridden, by everything below.

What's genuinely new: a Platform tier, admin-role semantics, guests,
projects, AI usage tracking, audit logging, and all admin-facing UI.

---

## 1. Locked architecture decisions

| Area | Decision |
|---|---|
| **Company Admin** | = existing `leader` role. No new role, no new code — a leader already has full CRUD on their one org. |
| **Group Admin** | = `leader` role on a membership where the org is `org_type = 'group'`. **One new authorization rule required:** a leader of group G gets *read-scoped* access to any company where `parent_org_id = G`. This is the single highest-risk new piece of logic in the whole build. |
| **Super Admin** | A new, separate `platform_admins(user_id)` table — **not** an org concept, no platform-level row in `organizations`. Checked first, ahead of the org-scoped chain, mirroring how `leader` already bypasses the permissions lookup in `hasPermission`. |
| **Cross-org aggregation** | N separately-scoped queries merged at the API layer, per existing `DECISIONS.md` doctrine. Never a widened RLS policy. |
| **Super Admin cross-org reads** | One isolated, narrowly-scoped code path, reviewed on its own — not a general RLS-bypass mechanism reused elsewhere. This is the highest blast-radius code in the entire build. |
| **AI usage tracking** | `AIProvider.complete()`'s return shape changes **first** (adds tokens/latency), verified against every existing caller, *before* any `ai_usage` table or dashboard is built. |
| **PostHog** | Stub only for now (`analyticsService` with a no-op provider, same shape as the existing `StubAIProvider`). Real key/account supplied later, after the stub is tested end-to-end — abstraction is built so the real provider drops in without a second refactor. |
| **Audit log** | New dedicated `audit_log` table (not an extension of existing `activity_log`/`permission_log`) — needed for `ip_address`/`user_agent`/`previous_value`/`new_value` on administrative actions specifically. |
| **Guest role** | New `guest` value in `org_memberships`, most restrictive default of any role — no blanket resource-type grants. |
| **Guest sign-in** | Company (any admin tier) generates guest credentials and shares them; guest signs in with **password-capable** login — not OAuth-only. |
| **Guest visibility** | Full **project container model** (see §3) — not just individual-record assignment. A guest is scoped to the project(s) they're a member of via `project_memberships`, seeing every task inside, not just tasks they're personally assigned. |
| **Plan-gating for guests** | Deferred as a real feature (no billing integration), but the **hook gets built now**: a minimal `organizations.plan` field + a gate check wired into the guest-invite path, even though what plans exist / pricing / upgrades stays fully out of scope. |
| **Super Admin — plan management** | Super Admin is the actor who sets and changes a company's plan tier — same authority level as creating companies and assigning them to groups. In Session 1, this is just moving a value on the `organizations.plan` hook (no enforcement yet). In Session 10, this becomes a real action with consequences (upgrade/downgrade flows, whatever enforcement means once billing is real) — but the *authority* is decided now, not revisited later. |
| **AI chat cross-referencing** | Default behavior: AI chat stays scoped to the current chat only. Cross-referencing tasks/company data for a better answer is an explicit, grantable capability with its own permission check — not implicit in existing AI Analyst access. Own session, own scoping conversation. |
| **Company docs/archive** | Structured storage for company documents — in-app, Google Drive, or another store. Storage footprint ("watch for space") is a first-order constraint, decided at the start of that session, not assumed here. Own session, unrelated to the org/admin work otherwise. |

---

## 2. Projects — the Goals precedent, applied a third time

Projects follow the same shape already used twice in this codebase:

- **Goals**: `GoalWithProgress` — goal + constituent tasks + completion % in
  one payload; `ActiveGoals` (list) + `GoalDetail` (drill-in route).
- **Marketing content**: calendar entry + 3 chained stage tasks; `GET /:id`
  returns both together; list view + `MarketingEdit` drill-in.
- **Projects** (this build): same pattern again.

**Data shape:** `ProjectWithTasks` — project + constituent tasks, mirroring
`GoalWithProgress` exactly.

**Frontend — two entry points, one payload:**
1. **List view** — each project row has an expand affordance (chevron/click)
   showing a **trimmed inline task summary** (title, assignee, status) for
   fast skimming across multiple projects without leaving the list.
2. **Full drill-in** (`ProjectDetail`, mirroring `GoalDetail`'s actual route
   pattern) — reached from the expanded row or a task title. Full task
   list, add task, reassign, edit status — everything that doesn't fit in a
   scannable row.

Both renderings pull from the same `ProjectWithTasks` response. No
duplicated logic, no second source of truth.

**Guest visibility is this same view, scoped.** A guest with a
`project_memberships` row sees exactly what a Company Admin sees when they
open that one project — the same `ProjectDetail` — just gated to their
project(s) only, nothing else in the company.

**Why the full container model, not assigned-record-only:** an
assigned-record-only guest would need manual re-assignment on every new
task added to a project, and would never see the project as a whole — no
context on what else is happening, what stage things are at, no shared
visibility with the rest of the pipeline. The project container gives
automatic visibility into new tasks and matches how an actual external
collaborator works: "you're on this project," not "here are 6 tasks, hope
someone remembers to loop you in on the 7th."

---

## 3. The 9 sessions

### Session 1 — Auth foundation + Org/Guest management *(merged)*
- `platform_admins` table (Super Admin, non-org-scoped)
- Consolidate `hasPermission`/`rbac.ts` into one `authorizationService.ts`
- New rule: leader-of-a-group → read-scoped access to companies where
  `parent_org_id = group`
- New `guest` role value in `org_memberships`
- `organizationService.ts`: create/edit/deactivate Group and Company,
  assign/remove Company↔Group (including → `null` for independent)
- `organizations.plan` field + gate check (hook only, no real billing)
- **Super Admin can set/change a company's plan tier** — the authority
  is established here, wired to `routes/admin/superAdmin.ts` in Session 4;
  no enforcement consequences yet, just the ability to move the value
- Guest invite/credential flow, password-capable sign-in
- New `audit_log` table (schema only)
- New folder scaffolding: `routes/admin/`, `modules/admin/` (empty shells)
- **Isolation tests, passing, before anything else builds on this:**
  - Group A blocked from Group B
  - Group A blocked from independent companies
  - Group A sees only its own companies
  - Company Admin blocked cross-company
  - Guest sees only their project(s), nothing else

### Session 2 — Projects & project memberships
- `projects` table, `project_memberships` (cross-org membership allowed,
  per `DECISIONS.md`'s own sketch of how this slots in)
- `ProjectWithTasks` service shape (mirrors `GoalWithProgress`)
- List view with inline expand (trimmed task summary)
- `ProjectDetail` full drill-in route (mirrors `GoalDetail`)
- Guest visibility wired to `project_memberships`

### Session 3 — AI provider interface + usage tracking *(merged)*
- Change `AIProvider.complete()` to return tokens/latency alongside text
- Update every existing caller (goal decomposition, reports, chat) —
  verify nothing breaks, treated as its own isolated unit first
- `ai_usage` table + `aiUsageService.ts`, wired to the new shape

### Session 4 — Super Admin backend *(includes audit/health/analytics stub, folded in)*
- `auditLogService.ts` write-side, wired into org/guest admin actions
- `systemMetricsService.ts` skeleton (API/DB/AI/email/n8n/notifications/webhooks)
- `analyticsService.ts` — PostHog no-op stub
- `routes/admin/superAdmin.ts`: Groups/Companies/Users CRUD, investigation
  search + drill-down endpoints, platform-wide analytics (N-query merge),
  system health endpoint, audit query/filter endpoint, **plan-change
  endpoint** (moves the `organizations.plan` value set up in Session 1)
- **Super Admin cross-org read path built and reviewed as its own isolated
  unit** — not folded into a general query helper

### Session 5 — Super Admin UI
- Full dashboard: Overview, Groups, Companies, Users, Analytics,
  Operations, AI & Costs, System Health, Audit & Security
- Plan management surfaced in the Companies view — Super Admin can see
  and change a company's plan tier from here
- Investigation UI: search + Group→Company→User drill-down + breadcrumb trail
- Read-only by default

### Session 6 — Group Admin + Company Admin, backend + UI *(merged)*
- Group Admin: scoped routes (companies-in-group only), aggregate
  analytics via N-query merge; dashboard (Overview, Companies, People,
  Operations, Goals, Analytics, Activity)
- Company Admin: thin layer — mostly reuse, since `leader` already covers
  most of it operationally; admin shell (Overview, Analytics, Automation,
  Activity, Settings) wrapping existing People/Work/Goals/Knowledge
- Includes the guest-invite surface at the company level

### Session 7 — AI chat cross-referencing
- Default: AI chat stays scoped to current chat
- Cross-reference capability: explicit, grantable, own permission check
- Decide grant level (company? group?) at the start of this session

### Session 8 — Company docs/archive
- Storage decision first (in-app vs. Drive vs. other), sized against the
  space constraint, before anything is built
- Likely external-integration-first to avoid Nexus storage costs — a call
  made at the start of this session, not assumed here

### Session 9 — Testing, hardening, final report
- Full isolation suite (org, guest, project axes): direct API access
  attempts, cross-company/cross-group/independent-company/guest 403s
- Analytics attribution tests (null group for independent companies,
  correct company/group tagging)
- Audit + AI usage tests
- Regression pass confirming existing NEXUS functionality untouched
- Final report per original spec's own execution rule: files changed,
  migrations, new services/endpoints/permissions, events tracked, tests
  run, unresolved issues — for sign-off before anything past this is touched

---

## 4. Dependency notes

- Session 3's `ai_usage` piece cannot start before its interface-change
  half is verified — kept as one session specifically so that ordering
  isn't lost across a session boundary.
- Sessions 5, 6 both require Session 1's authorization rule to already
  have passing isolation tests. Building a dashboard on an unverified
  authorization rule is the exact ordering risk this plan is structured
  to avoid.
- Session 2 (Projects) has no dependency on Sessions 3–6 and could run
  in parallel if needed, but is sequenced second because guest onboarding
  (Session 1) is more useful once guests have something to be scoped to.

---

## 5. Phase 2 — not built in the 9-session plan, sequenced for later

These aren't rejected — they're real future work, deliberately kept out of
the 9-session plan so the org/admin/guest/project foundation ships and gets
tested before anything is layered on top of it. Each becomes its own
session, taken up only after Session 9's sign-off.

### Session 10 — Billing & plan enforcement
- Real plan tiers (what plans exist, pricing, upgrade/downgrade flow)
- Wire actual enforcement into the `organizations.plan` hook built in
  Session 1 (today it's a flag with a gate check; this makes the gate mean
  something — e.g. blocking guest invites on a free plan for real)
- Super Admin's existing plan-change authority (Session 1) now triggers
  real consequences — proration, access changes, whatever the enforcement
  model requires — rather than just moving a flag
- Payment provider integration, invoicing, billing history
- Needs its own scoping conversation before it starts — provider choice
  (Stripe or otherwise), pricing model, and dunning/failed-payment handling
  are all open questions not addressed anywhere in this guide

### Session 11 — Impersonation
- Explicit, separate from investigation (investigation stays read-only by
  default, unchanged)
- Requires per the original spec: explicit confirmation, a stated reason,
  a full audit record, start/end timestamps, a persistent visible banner
  while active, a clear exit mechanism, and read-only mode by default
- Own permission gate, distinct from both `platform_admins` and the
  group-leader rule — impersonation should never be a side effect of
  holding either of those

### Session 12 — Advanced analytics
- Organizational health scoring, predictive analytics, benchmarking,
  anomaly detection, cross-company intelligence
- Advanced funnels, retention, cohorts, feature-adoption analysis,
  company/group comparisons, advanced cost allocation
- Custom reports, exports, full BI/data warehouse
- Depends on Sessions 4–6's analytics foundation (PostHog stub → real
  provider, `ai_usage`, system health) actually being live with real data
  flowing through it — this session doesn't start until that's confirmed
  useful in practice, not just built
