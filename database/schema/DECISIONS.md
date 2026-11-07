# Schema Decisions — Phase C prerequisites (PRD §9)

Resolves the three "before migration" items PRD §9 calls out, plus O6.
Scope of this first draft: `organizations`, `users`, `permissions`, `tasks`,
`goals`, `pending_ai_tasks`, `task_trends` — per SESSION_LOG Session 3 next
steps. Remaining §9.1 entity map tables land in later migrations.

## 1. Goals ↔ Pending AI Tasks ↔ Tasks

Three separate tables, not one polymorphic one:

- `goals` — the goal itself.
- `pending_ai_tasks` — AI-decomposed proposals awaiting Review Queue
  approval. `goal_id` FK to `goals`. `depends_on_pending_task_id` is a
  **self-referencing FK** (nullable), replacing the MVP's positional
  `Depends_On_Index` — an index into a sheet row is not a stable reference
  once rows move to a relational table with no fixed order.
- `tasks` — real tasks. `goal_id` FK (nullable — most tasks aren't
  goal-derived). `source_pending_task_id` FK back to the proposal it was
  approved from (nullable, for traceability — PRD §8.5 "approved tasks
  enter Master Tasks with dependency ordering").

Rejected alternative: a single `goal_tasks` table with a `state` enum
(`pending`/`approved`/`rejected`) spanning both proposal and real-task
rows. Rejected because `tasks` already carries a large, unrelated column
set (assignment, checklist, chat thread) that a pending proposal doesn't
have and shouldn't inherit — conflating them would mean nullable columns
in both directions. Two tables + an explicit provenance FK is the
straight-line version of PRD §9's instruction not to port column-by-column.

## 2. `task_trends` (O6)

**Decision: plain relational table with a `date` index, not TimescaleDB.**
v1 traffic (ABION-only, one daily snapshot row per user per day) doesn't
justify a time-series extension yet — TimescaleDB earns its complexity at
a row count and query pattern this table won't reach for a long time.
`(org_id, date)` composite index covers the actual access pattern (PRD
§8.7 chart, per-period). Revisit only if the table grows to a size where a
plain B-tree index measurably stops being enough — not preemptively.

## 3. RBAC → RLS

`permissions` table matches PRD §13.3 exactly (`user_id`, `org_id`,
`resource`, `action`, `granted_by`, `granted_at`). That's the
*application-layer* authorization check (endpoint-level).

Below that, every tenant-owned table also gets **Postgres Row-Level
Security** as the second, independent layer PRD §13.5 requires ("even if
the application layer has a bug, the database query constraint prevents
cross-tenant data leakage"). Implementation:

- Every tenant-owned table has a non-null `org_id`.
- RLS policy on each: `USING (org_id = current_setting('app.current_org_id', true)::uuid)`.
- The API sets `app.current_org_id` via `SET LOCAL` at the start of each
  request transaction, from the authenticated session — never from a
  client-supplied field.
- **Fails closed by design**: if `app.current_org_id` is never set (e.g. a
  bug in the not-yet-built auth hook), `current_setting(..., true)`
  returns NULL, the equality check is never true, and the query returns
  zero rows rather than all rows. Verified empirically against a real
  Postgres instance under a non-superuser role — see Session 4 log.
- RLS is enforced for a non-superuser application role
  (`nexus_app`, `NOSUPERUSER NOBYPASSRLS`) — RLS has no effect on
  superuser/BYPASSRLS roles, so the connection role matters as much as the
  policy itself.

This means `pending_ai_tasks` needs its own `org_id` column even though
it's reachable via `goal_id → goals.org_id` — a join-derived org_id can't
be checked by a `USING` clause. Denormalizing `org_id` onto every
tenant-owned table is therefore the rule, not an exception, for every
table from here forward.

## 5. Group → Company hierarchy + multi-org user membership (0006)

Supersedes the "one org per user" assumption sections 1–3 were written
against. Trigger: ABION is a group operating multiple companies, and a
person (e.g. the founder) genuinely holds different roles in different
companies simultaneously — not sequentially, not by switching accounts.

**Decision: keep flat `org_id` RLS (§3 above) exactly as-is. Add
hierarchy and multi-membership on top of it, not instead of it.**

- `organizations` gains `org_type` (`group`/`company`) and a
  self-referencing `parent_org_id`. A Group has no parent; a Company's
  parent is a Group. This models ABION Group → Company A/B/C directly.
- `users` is now a bare global identity (name, email, avatar) with no
  `org_id` — a person is not "of" one org.
- `org_memberships` (new) is the many-to-many join: `user_id`, `org_id`,
  `role` (same three-value enum PRD §3 already defines — unchanged,
  just now per-membership instead of per-user), plus a display-only
  `title` for things like "CEO" or "Board/Strategy" that aren't RBAC
  categories. Exactly one membership per user is flagged `is_home`
  (partial unique index) — the org a session lands in by default.
- `permissions` was `unique(user_id, resource, action)` — silently
  wrong the moment one user has different grants in two orgs. Now
  `unique(user_id, org_id, resource, action)`.
- **A session still scopes exactly one active org at a time**
  (`sessions.org_id`), same RLS-exempt mechanics as before (§4) — this
  document explicitly rejected widening RLS to "any org the user is a
  member of" in one query, because that would mean a single leaked
  `app.current_org_id` bug widens from "wrong tenant" to "every tenant
  the user happens to belong to," a strictly worse failure mode.
  Switching workspace = updating `sessions.org_id` to a different
  membership the user actually holds (checked at the app layer against
  `org_memberships`), not a broader query scope.
- **Corollary — "My Work" / unified cross-org view is an application-
  layer concern, not an RLS concern.** It is built by running N
  separately-scoped queries (one `SET LOCAL app.current_org_id` per org
  the user has explicit membership in) and merging results in the API
  layer, never by relaxing a policy's `USING` clause to match more than
  one org per query. This keeps the "fails closed to zero rows" property
  from §3 intact for every individual query in the merge.
- A brand-new session variable, `app.current_user_id`, is required
  alongside `app.current_org_id` so `org_memberships` can answer "what
  other orgs does this user belong to" (needed for the workspace
  switcher) independently of whichever org is currently active. This is
  a real API change (`withOrgContext` sets one `SET LOCAL`; it now needs
  two) — flagged in `0006_org_hierarchy_memberships.sql`, not yet made
  in `apps/api`.
- `organizations` itself now needs RLS for the first time (v1 had
  exactly one row, isolation was moot). Policy: visible if it's the
  current org, or the current org's parent group — a company-scoped
  user can resolve "which group am I under" without the group's own
  data (tasks, permissions, etc.) becoming visible, since none of those
  tables' policies grant on a parent/child relationship, only exact
  `org_id` match.

**Deliberately deferred, not built in 0006:** cross-company `projects`
with their own membership table (Company B contributing to a Company
A-owned project). The pasted architecture discussion treats this as a
fourth hierarchy level; the current PRD (§7.2) explicitly lists Projects
as "future — not in MVP, not in v1." The org hierarchy above doesn't
block adding it later — a `projects` table with `org_id` (owning org)
plus its own `project_memberships` (allowing a `user_id`/`org_id` pair
from a *different* org to hold project-scoped access) slots in cleanly
whenever that non-goal is revisited. Not building it now to avoid
speculative schema against a feature the PRD says is out of scope.

**External/unrelated tenants** (e.g. a company the same person works for
outside ABION entirely) need nothing new — that's just another
`organizations` row with no `parent_org_id` and no membership overlap
enforced anywhere. Isolation between it and ABION is the same flat
`org_id` boundary every other pair of unrelated orgs already gets; the
hierarchy fields are additive and irrelevant to it.

## 4. `sessions` — the one deliberate RLS exception

`sessions` (migration 0002) does **not** get the RLS policy every other
table gets. Reason: RLS needs `app.current_org_id` to already be set to
decide what's visible — but reading the session row *is* how the API
finds out which org a request belongs to in the first place. Applying the
same policy here would mean the very first query of every request sees
zero rows.

Instead, `sessions` rows are looked up by the sha256 hash of a 32-byte
random opaque token issued at login — effectively unguessable, which is a
tighter access guarantee for this one table than an `org_id` equality
check would add on top of. Once the session is read and its `org_id`
extracted, `SET LOCAL app.current_org_id` is issued for the rest of that
request's transaction, and every subsequent query against every other
table goes through RLS normally.

**Gotcha found in Session 5 testing, not by inspection:** a single query
that joins the RLS-exempt `sessions` table straight to the RLS-enforced
`users` table, before `withOrgContext` has run, silently returns zero
rows for every session — valid or not — because `users`' policy sees no
`app.current_org_id` yet. The fix is two queries: read `sessions` alone
first (RLS-exempt, gets you `org_id`), then read `users` inside
`withOrgContext(orgId, ...)`. Any future code that joins an RLS-exempt
table to an RLS-enforced one in a single statement will hit this same
failure mode — the general rule is: RLS-exempt lookups may only read
from other RLS-exempt tables, never join across the boundary.

## 6. Leave + Onboarding (0013) — check 4 applied to two more resources

**Leave** needed no new table — `leave_requests` (0009) already had the
right shape. Only `decision_note` was added (nullable, additive) so a
leader's approve/reject carries a short note distinct from the
requester's own `reason`. Permission shape is a direct copy of
`approvalService.ts`'s pending/approved/rejected lifecycle, minus the
dependency graph pending_ai_tasks needs and this doesn't: flat
`leave.approve` for the decision, own-record-or-`leave.read` for
listing (same fallback `tasks.ts`/`eod.ts` use), and a `leave.delete`-
or-own-pending-record check for cancellation — the one place this
resource needed the row-branch pattern, since "cancel my own request"
has no sensible flat grant (everyone can always cancel their own).

**Onboarding** got a real schema for the first time: `onboarding_steps`
(the adjustable checklist template) and `onboarding_progress` (one row
per user × step, absent = not started — same "absence means not-yet"
convention the rest of this schema already uses, rather than a redundant
`not_started` status column). Two independent permission surfaces:

- The **template** (steps) is leader/authorized-only to write
  (`onboarding.create`/`update`/`delete`), readable by anyone signed in —
  everyone needs to see the checklist to work through it, the same
  reasoning `people.ts` gives for its own unrestricted read.
- The **checklist** (progress) is check-4 self-service: reading/toggling
  your own progress needs no grant at all (mirrors `eod.ts`'s own-filing
  case), acting on someone else's needs `onboarding.update`. This is
  what "adjustable... by leaders, or those authorized" (the product ask)
  actually cashes out to — a leader is never special-cased in the route
  code, they just hold the grant, same as every other resource here.

Archiving a step sets `is_active = false` rather than deleting the row,
for the same reason tasks/goals archive instead of delete: deleting a
step out from under someone who already completed it would silently
erase their `onboarding_progress` history along with it (FK cascade).
Deactivated steps simply drop out of the live checklist
(`getChecklistForUser` only joins `is_active` steps) without touching
anyone's past completion record.

**Attendance was deliberately left untouched.** Per direction, it stays
derived from `eod_logs` (0007) rather than becoming its own record type —
there's no `attendance` table, service, or route, and `ia.ts`'s People →
Attendance subsection stays `built: false`. Analytics' EOD compliance
view is where that data already lives; duplicating it as a separate
People-section concept would just be two sources of truth for the same
underlying filings.

## 7. FileService (0015) — polymorphic attachments, no per-record trust yet

`files` follows `activity_log`'s polymorphic `resource_type`/
`resource_id` shape rather than a per-resource FK table, so any resource
can take attachments without a schema change — the first named consumer
(PRD §3) is EOD proof attachments, wired via `resourceType='eod_logs'`
in `EodReport.tsx`/`fileService.ts` (web), but the `files` table itself
doesn't know that; it's just another resource_type value to it.

Storage is S3-compatible (`@aws-sdk/client-s3` +
`s3-request-presigner`), not a Supabase-specific SDK — same reasoning
`db.ts`/DEPLOYMENT.md give for talking plain Postgres instead of the
Supabase client: whoever hosts the bucket (R2, S3, Supabase Storage's own
S3 endpoint) is a `STORAGE_*` env var decision, never a code dependency.
The API process never touches file bytes — `requestFileUpload` returns a
presigned PUT URL, the client uploads directly to the bucket, and
`confirmFileUpload` is what actually logs to `activity_log` (not the
presign step — a URL that's requested and never used shouldn't read as
"a file was created").

Permission shape is a flat `files.read/create/delete` grant, same as
`knowledge.ts` — **not** check-4 per-record trust. That's a deliberate
gap, not an oversight. The actual own-record case (an intern attaching a
proof file to their own EOD log) is now concrete — `EodReport.tsx` calls
`fileService.ts` (web) with `resourceType='eod_logs'` — but the
own-record branch itself is still intentionally on hold, per explicit
direction, rather than added in the same pass that made the case
concrete. Adding it means teaching `files.ts` that `resource_type=
'eod_logs'` implies "check `eod_logs.filed_by_user_id`/`user_id`" —
a resource-type-specific rule this generically-shaped table has no way
to express on its own. Revisit when that per-record trust work is
picked back up, not before.

Archive-not-delete, same convention as every other resource — but
unlike a normal archived row, the underlying *object* in the bucket is
deliberately not deleted either. The access-control boundary is the DB
row disappearing from list/download (RLS + `archived_at is null`), not
the bytes existing or not; actually deleting the object is a separate,
irreversible action reserved for an actual retention/GDPR requirement,
not bundled into every archive.

## 8. `ai_usage` (0018) — new dedicated table, not an extension of `audit_log`/`activity_log`

Same "new table, not an extension of an existing one" call `files` (0015)
made, for a different pair of reasons: `activity_log`/`permission_log`
are keyed to a single resource change, and this needs per-call
token/latency/model/feature columns none of those carry. Append-only
doctrine carried over from `audit_log` (0016) — written, never deleted
or updated, per PRD §13.10.

Two separate columns, deliberately not merged into one: `feature` (which
*product surface* asked — `goal_decomposition`/`chat`/`report`/
`agent_handoff`) versus `provider_target` (which *Settings > Integrations
slot* was actually resolved to serve it — `chat`/`report`). These
diverge today: `goal_decomposition` and `agent_handoff` both resolve the
`'chat'` target, per `aiService.ts`'s own choice. Collapsing them to one
column would silently lose "which model configuration actually served
this call" for two of the four features.

`model` is `not null`, including the literal string `'stub'` when an org
hasn't configured Settings > Integrations yet — a stub-served call still
counts as a real feature-usage event (at zero cost/tokens), not a gap in
the log. This is why `aiSettingsService.resolveProviderForOrg`'s return
type had to widen to `{ provider, model }` (previously just the
provider) as this session's own required first half, verified against
every one of its four call sites, *before* this table or
`aiUsageService.ts` were written — the guide's own ordering constraint,
not a stylistic preference.

`actor_user_id` is nullable, not `not null`: every current caller has a
real actor id in scope at its call site, so it's never actually null
today, but a future automation-triggered AI call (PRD §12's cron jobs,
none of which call `AIService` yet) shouldn't need a schema change just
to log usage.

No route/UI surface this session — `aiUsageService.ts`'s read side
(`listOrgUsage`/`getOrgUsageSummary`) exists for the Session 4/40 Super
Admin "AI & Costs" dashboard to call, same "schema/service now, route
later" split `audit_log`'s write side already took in 0016.

## 9. `org_billing` (0025) — effective-tier resolved in TS at read time, not cached or copied down

A company under a cascading parent group has no `org_billing` row of
its own reflecting the group's tier — `billingService.resolveEffectiveBilling`
walks org → parent group (exactly once; this codebase's hierarchy is two
levels deep by design, §5 above) on every call instead. Rejected: writing
the group's tier down onto every child company row on cascade-enable, or
caching the resolution beyond a single request. Both make "which plan is
actually in effect for this org" a question with a stale possible
answer — wrong for a decision that gates real spend (AI usage, storage,
automation). The extra query this costs is cheaper than the alternative
failure mode.

Companion decision, same table: `billing_status = 'past_due'` keeps
**full** feature access, identical to `active` — `hasFeature`/
`requireFeature` only ever hard-cut on `suspended`. This is the entire
point of the grace period (0025's own header, §1): a failed charge
degrades to a review flag for Super Admin, not an immediate feature
cutoff for users who did nothing wrong at the moment the charge failed.
The automated grace-period sweep (`automationJobs.ts`'s
`runBillingGraceCheck`) only ever escalates an *expired-grace* `past_due`
row to `pending_review` — it never suspends automatically either;
suspension is a Super Admin action via `resolve_billing_review`
(0025, Session 47 addition), same "the automated path proposes, a human
disposes" posture this table's `review_note`/`reviewed_by_user_id`
columns already existed to support before the review-queue routes that
actually write them were built.
