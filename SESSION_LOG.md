# NEXUS Session Log

Carry this file + `NEXUS-PRD.md` into any new session. That's all the context needed to continue.

---

## Session 1 — 2026-08-26

### Decisions made
1. **Skipped Track A entirely.** PRD §17.1 originally called for patching the live MVP (GAS/HTML) before starting the rebuild — rotating leaked passphrases (S1), fixing stored XSS (S3), fixing the `readTab` auth gap (S4). A partial S1 patch was drafted (nulled out the hardcoded `LEADER_PASSPHRASES`, documented the `setLeaderPassphrase` runtime action needed) but **discarded on explicit instruction** — going straight to the React rebuild instead. **The old MVP's security issues (S1–S6, PRD §13.1) are still live and unpatched.** If the MVP stays in production use during the rebuild, that risk is open and unaddressed — worth revisiting if cutover takes a while.
2. **Repo structure: monorepo, npm workspaces.** Chosen over two repos because: shared TS types between frontend/API, the Application API + Agent Runtime share one Node process at v1 anyway (PRD §6.4.2), small team means most PRs touch both sides together, and npm workspaces needs no extra tooling (fits the ₦0-budget constraint in §18). Split later is cheap if ever needed.
3. **Package manager: npm.**

### What exists now (in this repo)
- Root: `package.json` (workspaces), `tsconfig.base.json`, `.gitignore`, CI workflow (`.github/workflows/ci.yml` — typecheck, lint, build, `npm audit`).
- `packages/shared/src/index.ts` — first-pass shared types: `User`, `Role`, `Permission`, `Task`, `Goal`, `PendingAiTask`, `Execution`. Sourced from PRD §9 (entity map) and §13.3 (authorisation model) and §6.4.3 (execution status machine). **Not exhaustive** — only what's needed to unblock auth + tasks next.
- `apps/api` — Fastify server (`src/server.ts`) with security defaults wired in from the start per PRD §13: CORS allowlist, httpOnly cookie support, global rate limiting, an error handler that never leaks stack traces/SQL/paths (§13.4). Routes: `/api/v1/system/health` (live), `/api/v1/auth/session` (stub, 501).
- `apps/web` — Vite + React + TS shell. `App.tsx` is deliberately just a placeholder — **no modules/routes added yet**, on purpose (see gate below).
- `.env.example` in `apps/api` — documents required secrets (Google OAuth, DATABASE_URL, Gemini, Resend, n8n) without values.

### Explicit gate (do not skip)
Per PRD §17.1 Phase B: **Tier 1 design system + finalized 11-section IA must exist before any module (Dashboard, Work, etc.) gets built.** The IA itself has an open item — O8, "finalize IA reconciliation" — which is *itself* a blocker for Phase D. Don't start building Dashboard/Work/etc. React components until:
  (a) Tier 1 primitives (Button, Input, Modal, Table, etc. — full list PRD §14) exist, and
  (b) the IA reconciliation (PRD §7, open item O8) is signed off as final, not assumed.

### Next steps (in order)
1. **Finish Phase B foundation:**
   - PostgreSQL schema first draft (`database/schema/`) — start with `users`, `permissions`, `tasks`, `goals`, `pending_ai_tasks` per PRD §9. Goals↔PendingAiTasks↔Tasks ER model needs explicit design (PRD §9, decision #1) — don't port column-by-column from Sheets.
   - Wire real Google OAuth in `apps/api/src/routes/auth.ts` (currently a stub returning 501). Needs `GOOGLE_OAUTH_CLIENT_ID/SECRET` — real credentials, your call when to provision.
   - Session cookie handling (`@fastify/cookie` already registered in `server.ts`, not yet used).
   - RBAC middleware: implement the 4-check chain from PRD §13.3 (authenticated → org membership → role → per-resource trust) as a reusable Fastify hook/decorator, not per-route logic.
2. **Tier 1 design system** (`apps/web/src/components/ui/`) — the component list is fixed in PRD §14, build it before touching any module.
3. **IA reconciliation** (O8) — resolve as a standalone doc before Phase D module work starts.
4. Open items still unresolved and worth a decision before they block something: **O3** (AI provider — PRD default says Gemini, MVP was NIM — confirm), **O6** (Task Trends: plain table + date index vs TimescaleDB), **O4** (test tooling — Vitest/Playwright, not yet added to either app).

### Files referenced this session (not modified further)
- `NEXUS-PRD.md` — source of truth, unchanged.
- Old MVP files (`code.gs`, `index.html`, both audits, inventory doc) — read for context only; **no changes shipped to them**, decision was to abandon that track.

---

## Session 2 — 2026-08-26

Brought over the MVP's PWA/push layer. Verdicts (no open questions — all either directly settled by existing PRD decisions or a non-threatening straight port):

- **`gas-proxy.js` — discarded.** It's the exact CORS proxy PRD §18 already calls out for removal; Fastify's `@fastify/cors` (already in `server.ts`) replaces it outright.
- **Icons + `manifest.json` — ported as-is** into `apps/web/public/`. Brand/theme (`#080810` bg, purple/teal) already decided — linked from `index.html` (`<link rel="manifest">`, theme-color meta).
- **`sw.js` — ported**, one change: hardcoded old Vercel URL replaced with `self.location.origin` so it's deploy-target-agnostic. Registered from `apps/web/src/utils/registerServiceWorker.ts`, called in `main.tsx`. Cache renamed `nexus-v1` (fresh start, not `v5` carried over).
- **`404.html` — ported as-is** into `apps/web/public/` (static fallback).
- **Push sending (`send_push.js` + its standalone `package.json`) — re-homed, not discarded.** Same web-push/VAPID logic, but restructured to match the already-decided Service→Provider pattern (PRD §6) instead of living as an isolated Vercel function:
  - `apps/api/src/integrations/webPushProvider.ts` — the actual `web-push` call + VAPID config + stale-subscription (404/410) handling, ported directly from `send_push.js`.
  - `apps/api/src/services/notifications/notificationService.ts` — the Service layer above it. **Not yet wired to real data** — `notifyPush()` always sends; still needs the `push_subscriptions` table lookup and the two-axis preference model (PRD §10.4) before any route calls it for real.
  - `web-push` + `@types/web-push` added to `apps/api/package.json`. `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` added to `.env.example` (generate with `npx web-push generate-vapid-keys`).
- **Old `README.md`** — already superseded (Session 1).

### Still open from this batch
- No route yet exposes push subscribe/send — `notificationService.ts` is a leaf with no caller. Needs: `push_subscriptions` table (PRD §9), a `POST /api/v1/notifications/subscribe` route, and a real call site (e.g. on chat message / task assignment) once those features exist.
- `manifest.json` `start_url`/`scope` are `"."` — fine for now, revisit if the deploy path ever isn't root.

---

## Session 3 — 2026-08-26 — Tier 1 design system

Built all 23 components from PRD §14. Identity wasn't invented fresh — formalized what the MVP's brand assets (404.html, icons) already established: dark ops-console palette (`#080810` bg, `#5b52f0` indigo / `#00d4a0` teal accents), Syne for UI chrome, Space Mono for data/status/labels. Tokens live in `apps/web/src/styles/tokens.css`.

**Structural choice:** one shared stylesheet (`apps/web/src/styles/components.css`, `nx-` prefixed classes) instead of per-component CSS modules. Deliberate v1 simplification to move fast — revisit if class collisions become a real problem once modules start landing.

**What exists:** `apps/web/src/components/ui/` — Button, Input, Select, Checkbox, RadioGroup, Modal, Drawer, Card, Badge, StatusBadge, PriorityBadge, Avatar, Tabs, Dropdown, Tooltip, Toast (+ToastProvider/useToast), Table, DataGrid (sortable), EmptyState, LoadingState, ErrorState, DatePicker, ProgressBar. Barrel-exported from `index.ts`.

**Notes on specific components:**
- `StatusBadge`/`PriorityBadge` are domain-aware wrappers over `Badge` (task status/priority are used everywhere, so PRD keeps them in Tier 1 rather than Tier 2) — `StatusBadge` imports `TaskStatus` from `@nexus/shared`, first real cross-package usage.
- `DataGrid` is client-side sort only, no pagination/server filtering yet — needs the real API endpoints first (PRD §13.4 pagination enforcement). `Table` is the plain non-sortable version for small static lists (e.g. checklists).
- `Modal`/`Drawer`/`Toast` render via `createPortal`. `Dropdown`/`Tooltip` don't (simple absolute positioning) — fine for v1, revisit if they ever need to escape a scroll container.
- `DatePicker` is a styled native `<input type="date">`, not a custom calendar popover — cheaper, revisit only if it proves limiting.

**Verification:** `App.tsx` currently renders a temporary "kitchen sink" block exercising most primitives (remove once Dashboard, the first real module, lands). All three workspaces (`web`, `api`, `shared`) typecheck clean — `npm install` + `tsc --noEmit` run in each and confirmed. Also fixed a pre-existing typecheck error in `apps/api/src/server.ts`'s error handler (`err` was implicitly `unknown` — added an explicit type).

### Next steps (unchanged from Session 1, still the real options)
Postgres schema draft, Google OAuth wiring, or IA reconciliation (O8) — the last one now matters more since Tier 1 is done and PRD's stated gate before module work is Tier 1 + finalized IA, both.

---

## Session 4 — 2026-08-26 — Postgres schema draft

Also fixed a leftover from Session 1: `database/` contained a literal
`{schema,migrations,queries}` directory (unexpanded brace — the shell that
created it wasn't running in a mode that expands braces). Replaced with
the three real directories.

**Scope:** first migration covers `organizations`, `users`, `permissions`,
`tasks`, `goals`, `pending_ai_tasks`, `task_trends` — per the Session 3
next-steps note. Remaining §9.1 entity map tables (network_cos,
partnerships, chat_messages, etc.) are later migrations, not this one.

- **`database/schema/DECISIONS.md`** — resolves PRD §9's three required
  pre-migration questions plus O6:
  1. Goals ↔ Pending AI Tasks ↔ Tasks: three tables, not one polymorphic
     one. `pending_ai_tasks.depends_on_pending_task_id` is a
     self-referencing FK, replacing the MVP's positional
     `Depends_On_Index` (not stable once rows lose a fixed sheet order).
     `tasks.source_pending_task_id` traces an approved task back to its
     proposal.
  2. `task_trends` (O6): plain table + `(org_id, date)` index, not
     TimescaleDB — v1 traffic doesn't justify it yet.
  3. RBAC: `permissions` table matches PRD §13.3 for the app-layer check;
     **every tenant table also gets Postgres RLS** as the independent
     second layer PRD §13.5 requires. Policy checks
     `org_id = current_setting('app.current_org_id', true)::uuid`, set via
     `SET LOCAL` from the authenticated session per request — never from a
     client-supplied field. Fails closed if unset (NULL never equals
     anything). This is why `pending_ai_tasks` carries its own `org_id`
     even though it's reachable via `goal_id` — join-derived org_id can't
     back a `USING` clause, so denormalizing `org_id` onto every
     tenant-owned table is the rule going forward, not an exception.
- **`database/migrations/0001_init.sql`** — the DDL. `nexus_app` role is
  created `NOSUPERUSER NOBYPASSRLS` deliberately — RLS has no effect on
  superuser/BYPASSRLS roles, so a login as postgres would silently defeat
  the whole test.
- **Validated against real Postgres 16**, not just read for syntax:
  installed locally, ran the migration clean end-to-end (including the
  RLS-enabling `DO` block), then proved both directions empirically under
  `nexus_app` (non-superuser):
  - Two seeded orgs, one goal each → each org's session sees exactly its
    own 1 row, not the other's.
  - No `app.current_org_id` set at all → 0 rows, not all rows. Confirms
    the fail-closed claim in DECISIONS.md rather than just asserting it —
    a bug in the not-yet-built auth hook results in nobody seeing data,
    not everybody, which is the correct failure mode for a security
    control.
  - Caught one real bug this way: `pending_ai_tasks` was first drafted
    with only `goal_id`, no direct `org_id` — RLS couldn't apply. Fixed by
    denormalizing `org_id` onto it directly, per the rule above.
  - Test database and role dropped after verification; nothing left
    running.
- **`packages/shared/src/index.ts`** — `PendingAiTask` updated to match
  the real schema: added `orgId`, `createdAt`; replaced `dependsOnIndex:
  number` with `dependsOnPendingTaskId?: string`. `Task` gained
  `sourcePendingTaskId?: string`. Typechecks clean.

### Next steps
1. Wire real Google OAuth in `apps/api/src/routes/auth.ts` (currently a
   501 stub) + session cookie handling (`@fastify/cookie` already
   registered, unused) + the RLS `SET LOCAL app.current_org_id` call at
   the start of each authenticated request's transaction — the schema
   assumes this exists; it doesn't yet.
2. RBAC middleware: the 4-check chain from PRD §13.3 as a reusable
   Fastify hook, not per-route logic.
3. IA reconciliation (O8) — still unresolved, still blocks Phase D.
4. Remaining §9.1 tables (network_cos, partnerships, org_contacts,
   chat_messages, notifications, agent_handoffs, etc.) — later
   migrations, once the tables that actually unblock auth+tasks are
   proven out (this session).

---

## Session 5 — 2026-08-26 — Google OAuth, sessions, RBAC middleware

Closes out the three items Session 4 left open.

**`database/migrations/0002_sessions.sql`** — sessions table. Deliberately
**not** RLS-protected, unlike every table in 0001 — documented as
DECISIONS.md #4: reading the session is how org context gets established
in the first place, so RLS (which needs org context already set) can't
apply to its own bootstrapping query. Rows are instead scoped by the
sha256 of an unguessable 32-byte token.

**`apps/api/src/db.ts`** — `pool` (raw, sessions-table-only) +
`withOrgContext(orgId, fn)` (opens a transaction, issues `SET LOCAL
app.current_org_id`, runs the query, commits). This is what actually
switches RLS on for a request — not just a nicety, the enforcement
mechanism.

**Auth flow** (`services/googleOAuthService.ts`, `services/sessionService.ts`,
`routes/auth.ts`, `plugins/auth.ts`):
- `GET /google/start` → redirect to Google consent, CSRF `state` in its
  own short-lived cookie.
- `GET /google/callback` → verify `state`, exchange code, verify
  `id_token` (`google-auth-library`), look up the email in `users`.
- **Interim decision, not in the PRD:** an unrecognized email gets `403
  not_invited` rather than auto-provisioning a new user. PRD §3 describes
  a real invite-and-approval flow, but there's no `invites` table yet —
  that's separate scope for a later session, flagged here so it isn't
  silently skipped when it comes up.
- Session = opaque 32-byte random token in an httpOnly cookie; only its
  sha256 is stored (`sessions.token_hash`). Chosen over a stateless JWT
  specifically because PRD §13.2 requires real revocation on logout /
  permission downgrade — a JWT can't do that without a revocation-list
  table, which is just this table with extra steps.
- `POST /logout` sets `revoked_at`; `GET /session` returns the current
  user or 401.

**`plugins/rbac.ts`** — `requirePermission(resource, action)` preHandler
factory implementing checks 1–3 of PRD §13.3's four-check chain (4, the
per-record trust flag, is left as a documented route-level extension
point — it needs the actual row, which a generic middleware can't fetch).
Leaders bypass the `permissions` table lookup entirely, matching PRD
§13.3's own example grants (`Leader → tasks.* → read, create, update,
delete, approve`).

**Validated against a real running server + real Postgres**, not read for
syntax — booted the actual Fastify process, not just `tsc --noEmit`:
- Public `/health` works; protected `/auth/session` 401s with no cookie.
- Manually seeded a session row (no real Google credentials available in
  this environment) and confirmed the cookie → session → user chain
  returns the right identity end to end.
- `POST /logout` then replaying the *same raw token* → 401, and the DB
  row shows `revoked_at` set — confirms real server-side revocation, not
  just the client cookie being cleared.
- RBAC: added two throwaway routes gated on `tasks.read` and
  `tasks.delete`, confirmed leader bypass, confirmed a team_member with
  no grant gets 403, confirmed granting exactly `tasks.read` flips that
  route to 200 while `tasks.delete` still 403s for the same user (action-
  level granularity, not just resource-level) — then removed both routes
  before packaging.

**Two real bugs found by testing, not by inspection — fixed, and both
documented in DECISIONS.md so the next session doesn't rediscover them:**
1. `.env` was never loaded (`db.ts` reads `process.env.DATABASE_URL` at
   import time; nothing called `dotenv.config()`). First request hit a
   500 — which did correctly hide the real error from the client per PRD
   §13.4, confirming that control works too. Fixed: `dotenv` added,
   `import 'dotenv/config'` as the first line of `server.ts` (must
   precede any import that reads env vars at module-load time).
2. `verifySession`'s first draft was one query joining the RLS-exempt
   `sessions` table straight to the RLS-enforced `users` table — before
   org context was ever set, so `users`' policy silently returned zero
   rows for *every* session, valid or not. Every login looked like a
   401. Fixed by splitting into two queries: read `sessions` alone first
   (RLS-exempt), then read `users` inside `withOrgContext`. General rule
   now in DECISIONS.md: an RLS-exempt table can't be joined to an
   RLS-enforced one in a single statement.

Test database, test role, and the local `.env` (test secrets only, never
committed) were all removed after verification — nothing left running or
on disk from this session's testing.

### Next steps
1. **Invites table** — the `not_invited` interim decision above is a real
   gap against PRD §3's invite-and-approval flow. Needs an `invites`
   table + a leader-facing "invite by email" endpoint before OAuth
   matches the PRD spec exactly.
2. **Wire `withOrgContext` into real data routes** once they exist —
   nothing calls it yet outside `rbac.ts`'s own permission check; the
   first actual `tasks`/`goals` routes are the next real exercise of it.
3. Per-record trust check (PRD §13.3 check 4, the generalised
   `Trusted_*` flags) — deferred until Network/People land (§8.3/§8.4),
   flagged in `rbac.ts` so it isn't silently skipped.
4. IA reconciliation (O8) — still unresolved, still blocks Phase D.
5. Remaining §9.1 tables — same as Session 4's note, unchanged.

---

## Session 6 — 2026-08-26 — Invites table, closing the `not_invited` gap

Closes Session 5 next-step #1. (Next-step #2, real `tasks`/`goals`
routes, is still open — see below; this session covers only invites +
the rbac refactor those routes will need.)

**Real bug found by testing, not by inspection — same practice as
Session 4/5:** while building the pre-login "look this email up" path
for invites, ran the *existing* Session-5 OAuth callback against a real
Postgres instance for the first time (previous sessions only ever
verified the *session* → `users` chain with a manually-seeded row, org
already known — never the *email* → `users` chain from a cold
callback). It was broken: `users` has RLS `FORCE`'d and `nexus_app` is
`NOBYPASSRLS`, so `pool.query('select ... from users where email =
$1')` with no `app.current_org_id` set (the whole point — that's what
the query is supposed to determine) silently returned zero rows for
*every* email, not just unrecognized ones. Every real login would have
hit `not_invited` regardless of whether the account existed. Confirmed
empirically: seeded a user as `postgres`, queried as `nexus_app` with no
org context, got 0 rows back.

**Fix, and the shape of the invites work generally — `database/migrations/0003_invites.sql`:**
- A dedicated `nexus_bootstrap` role (`NOLOGIN`, `BYPASSRLS`) that owns
  two narrow `SECURITY DEFINER` SQL functions: `find_user_by_email(text)`
  and `find_invite_by_email(text)`. Each returns only the 3–4 columns a
  pre-login lookup needs — never `select *` — so the RLS bypass surface
  is exactly "resolve which org this email belongs to," not "read any
  row." `nexus_app` gets `EXECUTE` on the functions, not `SELECT` on the
  underlying tables, so a compromised API process still can't dump
  `users`/`invites` outside this one lookup shape. This is the same
  chicken-and-egg problem DECISIONS.md #4 solved for `sessions` — but
  `sessions` could just opt out of RLS table-wide because it holds
  nothing but a token hash; `users`/`invites` hold real org rosters, so a
  table-wide exemption wasn't an option, hence the narrower
  function-level one.
- `invites` table: `org_id`, `email`, `role`, `invited_by`, `expires_at`
  (14-day default), `accepted_at`/`accepted_user_id`, `revoked_at`. RLS
  enabled + forced like every other tenant table (DECISIONS.md #3). A
  partial unique index on `(org_id, lower(email))` allows at most one
  *live* (unaccepted, unrevoked) invite per email — can't also condition
  it on `expires_at > now()` since index predicates must be immutable, so
  `inviteService.createInvite` sweeps expired-but-live rows to `revoked`
  before inserting, specifically so re-inviting after expiry doesn't
  collide with the index.
- Validated against a real running Postgres 16 (installed fresh in this
  environment, not assumed available) — full lifecycle exercised at the
  SQL level first (create → pre-login lookup → accept-claim → re-accept
  blocked → duplicate-invite rejected → RLS blocks unscoped reads), then
  again through the actual TypeScript (`tsx`, not just `tsc --noEmit`)
  calling `inviteService`'s real exported functions and `rbac.hasPermission`
  against the same database. Database, roles, and the local `.env` were
  all dropped after verification, same as Session 4/5.

**`apps/api/src/plugins/rbac.ts`** — extracted `hasPermission(user,
resource, action)` as a standalone exported function; `requirePermission`
is now a thin preHandler wrapper around it. Needed for the "own record OR
general grant" shape `tasks` routes will use (a handler loads the row,
then checks `hasPermission(...)` OR `task.assignedToUserId ===
user.userId` inline — a generic preHandler can't see the row). Verified
the leader-bypass and action-level granularity (granting exactly
`tasks.read` doesn't also grant `tasks.delete`) still hold post-refactor,
same assertions as Session 5's manual route test, this time via direct
function calls against real Postgres rather than throwaway routes.

**`apps/api/src/services/inviteService.ts`** — `createInvite` (leader,
already-org-scoped, normal `withOrgContext` write — no bootstrap function
needed, only the *pre-login* lookups need that), `findLiveInviteByEmail`
(pre-login, via `find_invite_by_email`), `acceptInvite` (claims the
invite with `UPDATE ... WHERE accepted_at IS NULL` *before* creating the
`users` row — the atomic guard against a double-click or retried request
consuming the same invite twice — then creates the user inside
`withOrgContext(invite.orgId, ...)`, which is fine because by that point
the org *is* known), `revokeInvite`. `acceptInvite` takes an optional
`googleDisplayName` and uses it as the new user's `name`, falling back to
the email's local-part only if it's absent — verified end-to-end that a
real "Dana Okafor" display name lands in the `users.name` column instead
of the email address.

**`apps/api/src/routes/auth.ts`** — the OAuth callback's `users`
lookup now goes through `find_user_by_email` (fixing the bug above);
on no match, falls through to `acceptInvite` before rejecting. Two
distinct 403s: `not_invited` (no account, no pending invite — same
message as Session 5's original) and `invite_expired` (a pending invite
existed but its `expires_at` has passed — surfaced with `InviteError`'s
own message rather than the generic one, so a leader knows to send a
fresh invite rather than re-check spelling).

**All three touched workspaces (`shared`, `api`, `web`) typecheck
clean** (`tsc --noEmit` in each, `web` unaffected by this session but
checked for regressions anyway).

### What's still true from Session 5, unchanged
- Leader-facing "create invite" / "revoke invite" HTTP routes don't exist
  yet — `inviteService` is fully built and tested but has no caller
  besides the OAuth callback's `acceptInvite`. A `POST
  /api/v1/invites` (gated `requirePermission('users', 'create')` or
  similar) and `DELETE /api/v1/invites/:id` are the natural next step,
  possibly alongside the `tasks` routes below since both are "first real
  routes" work.
- Per-record trust check (PRD §13.3 check 4) — still deferred to
  Network/People, still flagged in `rbac.ts`.
- IA reconciliation (O8) — still unresolved, still blocks Phase D.
- Remaining §9.1 tables — unchanged.

### Next steps
1. **First real `tasks`/`goals` data routes** — Session 5's other
   flagged gap, untouched this session. This is what actually exercises
   `withOrgContext` outside `rbac.ts`'s own check, and the first real use
   of `hasPermission`'s standalone form for the "own record" case.
2. Leader-facing invite HTTP routes (create/revoke), per above.
3. Per-record trust check, IA reconciliation, remaining §9.1 tables —
   unchanged from Session 5.

---

## Session 7 — 2026-08-26 — Task CRUD routes, first real `withOrgContext` caller outside rbac.ts

Closes Session 6 next-step #1 (the `tasks` half; `goals` still open).

**Schema gap found before any route code was written:** `tasks` (0001_init.sql)
had no way to represent "archived" at all, but PRD §6.4.1 is explicit —
`DELETE /api/v1/tasks/:id → archive (not hard delete)`. Added
`database/migrations/0004_tasks_archive.sql`: an `archived_at timestamptz`
column plus a partial index (`where archived_at is null`) matching the
actual query shape every list/count call uses, rather than a plain
column index nothing would use. Added `archivedAt` to the shared `Task`
type and a new shared `TaskListQuery` type (both apps will want the same
list-filter shape once `apps/web` has a task list).

**`apps/api/src/services/taskService.ts`** — org-scoped CRUD, no
permission logic (routes own that, per rbac.ts's existing division of
labor). Notable design point: `listTasks` builds its WHERE clause and
bound params in a single `buildWhereClause` helper shared by the count
query and the select query, so the two can't drift out of sync. (First
draft renumbered placeholders after the fact for count vs. select and
got fragile fast — rewritten before it was ever wired to a route, not
after a bug.) Every function takes `orgId` as an explicit argument and
runs inside `withOrgContext` — never the raw `pool` — so RLS is still
the enforced second layer per PRD §13.5, not something this file could
accidentally bypass. `updateTask` only writes columns actually present
in the input object so a partial PATCH body doesn't null out untouched
fields. `archiveTask` is the only path that touches `archived_at`;
nothing in this file issues a real SQL DELETE. `isOwnTask` is a plain
exported function (no DB call) for routes to combine with `hasPermission`.

**`apps/api/src/routes/tasks.ts`** — first real exercise of the "own
record OR general grant" shape flagged as an open case since Session 6's
`hasPermission` extraction. PRD §13.3's own example grants (`Team Member
→ tasks.own → read, update (status, notes only)`) don't fit a flat
preHandler, since "is this my task" needs the row loaded first:
- `GET /` (list): no general `tasks.read` grant → force
  `assignedToUserId` to the caller's own id rather than 403 the whole
  list; a caller can't request someone else's `assignedToUserId` filter
  without the general grant either.
- `GET /:id`, `PATCH /:id`, `DELETE /:id`: load the task, then check
  `hasPermission(...)` OR `isOwnTask(...)`.
- `PATCH /:id` own-record case: silently drops any field outside
  `{status, description}` rather than 403ing the request for one extra
  field — `description` stands in for PRD's "notes" (no separate notes
  column exists in `tasks`).
- `POST /`: flat permission check — there's no row yet for "own" to
  mean anything.
- `DELETE /:id` calls `archiveTask`, never a hard delete, per §6.4.1.

**Verified against a real running Postgres 16** (installed fresh again
this session, per Sessions 4–6's practice), not just `tsc --noEmit`:
seeded two orgs, a leader + team member in org A, a leader in org B, and
hand-crafted session-token rows (sha256-hashed, matching
`sessionService`'s scheme) to drive the actual HTTP routes with `curl`
against a running `tsx src/server.ts`. Confirmed at the HTTP layer
against live data, not by reading the code:
- No cookie → 401.
- Team member with no `tasks.*` grants: `POST /` → 403; `GET /` returns
  only tasks assigned to her, not the org's other tasks.
- Team member `PATCH`ing her own task: `status` change applied,
  simultaneous `assignedToUserId` reassignment attempt silently dropped
  (confirmed via a follow-up `GET` as the leader).
- Org B's leader `GET`ing org A's task id → 404, not 403 — RLS
  (0001_init.sql) makes the row invisible rather than the app layer
  reasoning about cross-tenant access at all; this is the "even if the
  application layer has a bug" guarantee from PRD §13.5 actually being
  exercised through a business route for the first time, not just
  `sessionService`'s user lookup.
- Granting Dana a general `tasks.read` row: her next `GET /` returned
  the org's other task (the leader's, not assigned to her) too — the
  flat-grant branch, not just the own-record branch.
- Archived task disappears from the default list, still returns with
  `?includeArchived=true` and a populated `archivedAt` — confirmed it's
  a soft archive, not a delete.
- `?pageSize=99999` clamped to the documented max of 100.

Test database, seeded rows, the local `.env`, and the Postgres server
process were all removed/stopped after verification — same discipline
as every prior session.

**All three workspaces typecheck clean** (`shared` rebuilt first since
`Task`'s shape changed, then `api` and `web`).

### What's still true from Session 6, unchanged
- Leader-facing invite HTTP routes (create/revoke) still don't exist —
  `inviteService` still has no caller besides the OAuth callback.
- Per-record trust check (PRD §13.3 check 4) — still deferred to
  Network/People, still flagged in `rbac.ts`.
- IA reconciliation (O8) — still unresolved, still blocks Phase D.
- Remaining §9.1 tables — unchanged.

### Next steps
1. **`goals` routes** — the other half of Session 6's next-step #1,
   still open. Goal decomposition's Review Queue flow (PRD §8.5) is the
   more complex "AI proposes → human approves" contract and will want
   `pending_ai_tasks` read/approve/reject routes alongside plain `goals`
   CRUD — worth scoping as its own session rather than folding in here.
2. Leader-facing invite HTTP routes (create/revoke), per Session 6.
3. Per-record trust check, IA reconciliation, remaining §9.1 tables —
   unchanged.

---

## Session 8 — 2026-08-26 — Goals + Review Queue routes

Closes Session 7 next-step #1 (`goals` routes, the other half of Session 6's
original "first real tasks/goals data routes" item).

**Scope decision, made explicit before writing any code:** PRD §8.5's
lifecycle is "Create goal → AI decomposes into 4–10 tasks → Review
Queue → approve/reject → Master Tasks → progress tracked." AIService
(§10.2) is still just a TypeScript interface — no route in this codebase
calls a real AI provider. Rather than block goals/approvals work on
AIService existing, `POST /goals` and `POST /goals/:id/regenerate` take
a caller-supplied `proposedTasks: ProposedTaskInput[]` in the request
body in place of an actual decomposition call. This is documented
directly on the new `ProposedTaskInput` shared type (not left as a
route-level implementation detail) — swapping the caller from "whatever
the request body contained" to "whatever `AIService.generate({task:
'decompose', ...})` returns" is a change inside the route only, since
the propose→review→approve contract downstream of that point doesn't
care where the proposals came from. `dependsOnIndex` (an index into the
same request array, not a UUID — none exist yet at request time) lets a
caller express dependency order between proposals before they have real
ids; resolved server-side into the real self-referencing
`depends_on_pending_task_id` FK after insert.

**Schema gap found before route code, same practice as Session 7's
`archived_at` gap:** `pending_ai_tasks` (0001_init.sql) had a `status`
enum for the decision but nowhere to record *why* a proposal was
rejected, and PRD §6.4.1 is explicit — `POST /approvals/:id/reject →
reject with optional reason`. Added
`database/migrations/0005_pending_ai_tasks_rejection_reason.sql`
(`rejection_reason text`, nullable).

**Permission-action mismatch caught before it became a bug:** PRD
§13.3's own example grant text reads `Leader → goals.* → read, create,
approve, archive` — but the actual `permissions.action` CHECK constraint
(0001_init.sql) and `rbac.ts`'s `PermissionAction` type only allow
`read/create/update/delete/approve/export`; `archive` isn't one of them.
Rather than add a new action value (a schema change for a single route)
or silently typo past the type system, `DELETE /goals/:id` checks the
`delete` action — same convention `tasks.ts` already established:
the permission action tracks the HTTP verb, not the storage-level
behavior (archive-not-hard-delete) that verb triggers.

**`apps/api/src/services/goalService.ts`** — goal CRUD +
`insertProposedTasks` (shared by `createGoal` and `regenerateGoal`,
both need it alongside another write in the same transaction).
`getGoalWithProgress` (PRD §6.4.1 `GET /goals/:id → goal + constituent
tasks + completion %`) computes completion from non-archived
constituent tasks only — an archived task was removed from
consideration, not "not done" — and treats zero tasks as 0% (a goal
with nothing approved yet hasn't started, it isn't complete).
`regenerateGoal` marks any still-`pending` proposals from the prior
round `rejected` with a fixed "superseded" reason before inserting the
new batch, so the Review Queue never shows two competing generations of
the same goal; already-decided rows (approved or rejected) are left
alone since re-running decomposition can't undo either an already-created
task or an already-made rejection.

**`apps/api/src/services/approvalService.ts`** — kept as its own file
rather than folded into `goalService`, matching PRD §6.4.1 treating
`approvals/` as its own API domain; the "AI proposes → human approves →
system executes" contract (PRD §4, §8.5) is general enough that other
future agent workflows will feed the same Review Queue, not just goal
decomposition. `approvePendingTask` is dependency-aware: if a proposal
depends on another proposal that isn't approved yet, it throws
`dependency_not_approved` (retryable — approve the dependency, then
retry) rather than either silently dropping the dependency link (which
would defeat the entire point of "approved tasks enter Master Tasks with
dependency ordering," PRD §8.5) or auto-approving the dependency first
(which would approve something the leader hasn't reviewed). If the
dependency was rejected instead, that's `dependency_rejected` — a
distinct, permanent failure mode, not "try again later."

**`apps/api/src/routes/goals.ts`, `apps/api/src/routes/approvals.ts`** —
flat `hasPermission` checks throughout (no own-record branch like
`tasks.ts`'s: PRD §13.3's example grants only show `goals.*` at the
leader level, no `goals.own` case). Approvals routes gate on the
`goals` resource, not a separate `approvals` resource — a Review Queue
item only exists in service of a goal's decomposition, and PRD already
defines `approve` as a `goals.*` action.

**Verified against a real running Postgres 16** (installed fresh again
this session; same practice as Sessions 4–8), seeded the same two-org /
three-user fixture as Session 7, driven entirely through `curl` against
a running `tsx src/server.ts`. Confirmed at the HTTP layer, not by
reading the code:
- Team member with no `goals` grants: `POST /goals` → 403; `GET
  /approvals` → 403.
- Leader creates a goal with three chained `proposedTasks`
  (`dependsOnIndex: 0`, `dependsOnIndex: 1`) — response shows the chain
  resolved into real `dependsOnPendingTaskId` UUIDs, not the original
  indices.
- Approving the middle item before its dependency → `409
  dependency_not_approved`.
- Approving the dependency, then the middle item → `201`, and the
  created task's `dependsOnTaskId` points at the *real task* the
  dependency became (not the pending-task id) — the specific behavior
  PRD §8.5's "dependency ordering" phrase actually cash out to.
- Rejecting the third item with a reason → the pending row's
  `rejectionReason` reflects it.
- Re-approving an already-approved item → `409 already_decided`.
- `GET /goals/:id`: `completionPercent` was 0 with two `not_started`
  tasks, then 50 after marking one `done` via the existing tasks route
  — confirms goals and tasks share live data, not a cached/derived
  snapshot.
- `POST /goals/:id/regenerate`: old pending item disappears from the
  Review Queue (now `rejected`, superseded), new one appears.
- Archiving a goal, then regenerating it → `409 goal_archived`.
- Cross-org leader reading the goal → `404`, same RLS-driven invisibility
  as Session 7's tasks test.
- A forward `dependsOnIndex` (referencing a later array entry) → `400
  invalid_dependency` with the offending task named in the message.

Test database, seeded rows, the local `.env`, and the Postgres server
process were all removed/stopped after verification.

**All three workspaces typecheck clean** (`shared` rebuilt first —
`PendingAiTask.rejectionReason`, `ProposedTaskInput`, and
`GoalWithProgress` were all added there this session).

### What's still true from Session 7, unchanged
- Leader-facing invite HTTP routes (create/revoke) still don't exist.
- Per-record trust check (PRD §13.3 check 4) — still deferred to
  Network/People, still flagged in `rbac.ts`.
- IA reconciliation (O8) — still unresolved, still blocks Phase D.
- Remaining §9.1 tables — unchanged.
- AIService (§10.2) itself is still unbuilt — goal decomposition is
  request-supplied, per this session's scope decision above. Wiring a
  real provider behind it is future work, not blocked by anything built
  this session.

### Next steps
1. **Wire a real AIService call** behind `POST /goals` /
   `POST /goals/:id/regenerate` once §10.2's provider decision (O3) is
   made — the request body shape (`ProposedTaskInput[]`) is designed to
   be exactly what that call would need to return, so this should be a
   route-level change only.
2. Leader-facing invite HTTP routes (create/revoke), per Session 6/7.
3. Per-record trust check, IA reconciliation, remaining §9.1 tables —
   unchanged.

---

## Session 9 — 2026-08-26 — Invite HTTP routes, closing the Session 6 gap

Closes the "leader-facing invite HTTP routes don't exist yet" item
flagged since Session 6: `inviteService.ts` was fully built and tested,
but had no caller besides `acceptInvite` inside the OAuth callback —
the only way to get a row into `invites` was a manual SQL insert.

**`apps/api/src/routes/invites.ts`** — no new service logic, just the
missing HTTP layer over what already existed:
- `POST /api/v1/invites` — gated `requirePermission('users', 'create')`,
  not a separate `invites` resource: PRD §3 treats the invite itself as
  the approval step for a new `users` row, so it's the same permission
  a leader would need to manage the Team Members directory (§8.4).
  Validates email shape and role enum before calling `createInvite`.
- `DELETE /api/v1/invites/:id` — `requirePermission('users', 'delete')`,
  same reasoning as `tasks.ts`/`goals.ts`'s established convention (verb
  tracks the HTTP method).
- Both are flat permission checks via `requirePermission` (the
  preHandler-factory form `rbac.ts` already provides for exactly this
  shape) rather than hand-rolled `hasPermission` calls like
  `tasks.ts`/`goals.ts` — there's no per-record "own invite" case for
  PRD §13.3's chain to account for here, so the simpler existing
  primitive fit for the first time this session.

**Real gap found while testing the full loop, not by inspection:**
`createInvite` had no check for whether the target email already
belonged to an existing `users` row. Without one, a leader inviting an
already-registered address would silently create a dead invite —
`acceptInvite` is only ever reached from `routes/auth.ts` when
`find_user_by_email` comes back *empty*, so that invite could never be
consumed, and nothing would tell the leader why "the invite just sat
there." Fixed in `inviteService.ts` itself (not the route) since any
future caller of `createInvite` would want the same guard: reuses the
same `find_user_by_email` SECURITY DEFINER lookup `routes/auth.ts` and
`findLiveInviteByEmail` already call for the same pre-org-context
reason, and throws a new `InviteError('user_exists', ...)` mapped to a
409 at the route.

**Verified against a real running Postgres 16** (installed fresh again
this session), seeded a single org with a leader and a team member, and
drove the actual HTTP routes with `curl`:
- Team member (no `users.create` grant): `POST /` → 403.
- Malformed email → 400; invalid role value → 400.
- Leader sends a real invite with a mixed-case email → stored
  lowercased (matches `createInvite`'s existing normalization).
- Duplicate invite to the same address while the first is still
  pending → 409 `conflict` (pre-existing `inviteService` behavior,
  now reachable over HTTP for the first time).
- Team member (no `users.delete` grant): `DELETE /:id` → 403.
- Leader revokes the pending invite → 204; revoking the same id again →
  404 (already revoked, matches `revokeInvite`'s existing contract).
- Re-inviting the same address after revoke → 201, succeeds (the
  now-revoked row no longer blocks a fresh one).
- **Closed the loop end to end**: called `acceptInvite` directly (the
  same function `routes/auth.ts`'s OAuth callback calls) against an
  invite created through the new route — produced a real `users` row
  with the invited role, confirming the create-invite → accept-invite
  path actually connects, not just that each half works in isolation.
- Re-invited that now-accepted email → originally succeeded incorrectly
  (the gap above); after the `user_exists` fix, correctly 409s, while a
  genuinely fresh email still succeeds normally (regression check).

Test database, seeded rows, the local `.env`, and all server/Postgres
processes were force-stopped and removed after verification.

**Both workspaces typecheck clean** (no shared-type changes this
session — `Invite` was already fully defined in `inviteService.ts`
from the session that built it).

### What's still true from Session 8, unchanged
- Per-record trust check (PRD §13.3 check 4) — still deferred to
  Network/People, still flagged in `rbac.ts`.
- IA reconciliation (O8) — still unresolved, still blocks Phase D.
- Remaining §9.1 tables — unchanged.
- AIService (§10.2) — still unbuilt; goal decomposition still takes
  request-supplied proposals per Session 8's scope decision.

### Next steps
1. Per-record trust check (PRD §13.3 check 4) — first real candidate is
   whichever of Network/People lands first; both need it (COS/Partnerships
   trust flags, Team Member RBAC toggles).
2. IA reconciliation (O8) — a planning-document exercise, not code;
   blocks Phase D regardless of how much API surface exists underneath.
3. Wire a real AIService call behind goal decomposition once O3 (provider
   choice) is decided — route-level change only, per Session 8.

---

## Session 10 — 2026-08-28 — Reconciling two diverged Session-9 forks (org hierarchy + Analytics/EOD/Dashboard)

Two separate threads branched off the exact same Session 9 state and
built different things without knowing about each other: one built
`org_hierarchy_memberships` (multi-org membership model, replacing
`users.org_id`/`role`), the other built Dashboard/Analytics
Phase 1+2/EOD (see that thread's own Session 10 entry for the
Analytics/EOD detail — not duplicated here). Both claimed migration
number `0006`. This session reconciles them into one branch rather than
picking one and discarding the other.

**The org-hierarchy branch was schema-only when found — not functional.**
Its migration was verified against raw `psql`, but the application code
was never updated to match, and would have 500'd on every login:
- `find_user_by_email()` (0003_invites.sql) still selected `role`/`org_id`
  directly off `users`, both dropped by the org-hierarchy migration.
  Fixed *inside that same migration* (0006, not a follow-up) since it's
  what broke the function — same external contract (`id, org_id, role`),
  internals now resolve through `home_org_id` + `org_memberships` so
  `routes/auth.ts`/`inviteService.ts` needed no changes.
- `inviteService.acceptInvite` still inserted into
  `users(org_id, name, email, role)` — fixed to insert the user row with
  just `home_org_id`, then a separate `org_memberships` row
  (`is_home = true`).
- `sessionService.verifySession` still did
  `select role, name, email from users where id = $1` — fixed to join
  `org_memberships` on the session's active org, so `SessionUser.role`
  keeps meaning exactly what it always meant to callers ("this user's
  role in their current workspace") without `rbac.ts` or any route
  needing to change.
- `rbac.ts`'s `hasPermission` query was missing `org_id` — the
  org-hierarchy migration widened `permissions`' unique constraint to
  `(user_id, org_id, resource, action)` specifically so the same user can
  hold different grants in different orgs; the lookup wasn't updated to
  match and would have let a grant from one org silently authorize
  another.
- **A real ordering bug in the migration itself**, caught by re-running
  it clean end to end: `alter table users drop column org_id` ran
  *before* `drop policy tenant_isolation on users` — that policy
  references `org_id`, so Postgres refuses the drop
  ("policy ... depends on column org_id"). Moved the policy drop earlier.

None of these were found by reading the code — each came from actually
trying to run the migration chain and then the real login → session →
permission-check path against a fresh Postgres instance, the same
discipline every prior session in this log has used.

**Merge mechanics:**
- Org-hierarchy keeps `0006` (foundational — everything else sits on top
  of it). `eod_logs` renumbered `0006` → `0007`.
- `eodService.getMembersExpectedOn` also read `users.org_id` directly —
  same class of bug as the four above, fixed the same way (joined
  through `org_memberships` instead).
- `taskService.ts`'s `TaskRow`/`toTask` export (needed by
  `analyticsService.ts`) was re-applied — the org-hierarchy branch's copy
  of `taskService.ts` predated that export.
- Dashboard/Analytics/EOD web modules, components, and services (none of
  which existed in the org-hierarchy branch) copied over as-is — they
  talk to the API over HTTP, so the schema change underneath doesn't
  touch them.

**Verified against a real running Postgres 16** (installed, migrated
0001→0007, seeded, dropped after): full migration chain applies clean
from scratch; `verifySession` called directly confirms
`org_memberships`-resolved roles for both a leader and a team member;
then the same proof over real HTTP — `/auth/session`, `/analytics/*`,
`/eod/*` — including `eod/compliance` returning `expectedCount: 2` for
two seeded org-members, which only works if the new
`org_memberships`-joined `getMembersExpectedOn` query is actually
correct, not just type-correct. Both workspaces typecheck clean;
`apps/web` and `packages/shared` build clean.

**Explicitly deferred, not fixed:** the org-hierarchy migration's own
comment flags that `withOrgContext` should also
`SET LOCAL app.current_user_id`, for the not-yet-built workspace-switcher
feature (`org_memberships`' `self_or_current_org` policy has a
`current_user_id` branch, but its other branch — "membership row inside
your current org" — already works without it, and nothing built so far
needs the first branch). Changing `withOrgContext`'s signature would
ripple through every one of its ~20 call sites for a feature with zero
current callers — deferred per this project's own established
convention (`rbac.ts`'s own comment defers check 4 the same way, for the
same reason: no route needs it yet).

**Not reconciled — missing from the source, not skipped:** the other
thread's transcript also described building a Network domain migration
(COS/Partnerships/Org Database, `0007` in that thread) with real RLS
verification, but that file was never actually present in the uploaded
scaffold — only described secondhand. Needs a fresh export from that
thread before it can be merged in; not something to reconstruct from a
paraphrased description without risking a silent mismatch.

### What's still true, unchanged
- IA reconciliation (O8) — still unresolved, both Dashboard and Analytics
  remain unrouted previews behind `App.tsx`'s manual toggle.
- Per-record trust check (PRD §13.3 check 4) — still deferred to
  Network/People.
- AIService (§10.2) — still unbuilt.
- No login UI — Dashboard/Analytics previews still 401 without a manually
  minted session cookie.

### Next steps
1. **Network domain migration** — re-export from the other thread and
   merge in properly (would become `0008`), or rebuild from scratch
   against this now-reconciled base.
2. `withOrgContext`'s deferred `current_user_id` — do this properly (full
   signature change across all ~20 call sites) once the workspace-switcher
   feature that actually needs it gets scheduled, not before.
3. IA reconciliation (O8), login UI, AIService — unchanged from every
   prior session's next-steps list.
4. The full GAS+HTML source (uploaded this session) covers substantially
   more than either fork has touched — AI Analyst (NIM-backed reports/
   attention-queue/predictions/task-chat), full chat system with push
   notifications, meeting-notetaker ingestion (Fireflies → review queue),
   trusted-editor/per-tab permission grants, recurring tasks, calendar
   sync, multi-account Resend email failover, state security reports.
   None of these have a PRD-side home decided yet beyond their §8.x
   section headings — worth an explicit scoping pass before picking one
   to build next.

---

## Session 11 — 2026-08-29 — Network domain (0008), closing the last Failsafe category

The Network migration flagged as missing at the end of Session 10 was
provided directly this session (pasted, not re-exported from the other
thread) — `0008_network.sql` (renumbered from that thread's `0007`,
since `eod_logs` already holds `0007` here): `network_cos`, `partnerships`,
`org_contacts`, consolidating MVP tabs '2. COS' / '3. Partnerships' /
'4. Org Database' into one migration/service/route file per PRD §8.3's
"three CRM-ish views, one section" framing — not three copy-pasted
verticals, same DECISIONS.md #1 reasoning already applied to
goals/pending_ai_tasks/tasks.

**Backend, all new this session:**
- `networkService.ts` — full CRUD for all three tables. COS has no
  per-row owner (matches the MVP's own `OWNERSHIP_TABS` list exactly —
  `code.gs`'s comment on this was carried into the migration verbatim);
  Partnerships and Org Contacts do (`assigned_to_user_id` /
  `contact_owner_user_id`), same own-record shape as `taskService.ts`'s
  `isOwnTask`.
- `routes/network.ts` — `/cos`, `/partnerships`, `/org-contacts`. COS is
  a flat `network.cos` grant (no row to branch on, same shape as
  `goals.ts`). Partnerships/org-contacts follow `tasks.ts`'s load-then-
  decide pattern: flat `network.partnerships` / `network.org` grant OR
  the row's own assignee/owner. Partnerships' own-record update also
  ports the MVP's `enforceLeaderOnlyFields` split for that tab exactly:
  `assignedToUserId` and `documentStatus` are leader-only fields, silently
  stripped (not 403'd) from an own-record update — same silent-drop
  convention `tasks.ts` already uses for its own leader-only fields.
- `GET /analytics/failsafe/partners` — the 4th and last PRD §8.7/§8.9
  Failsafe category, unblocked now that `partnerships` exists. Reuses
  `network.partnerships` rather than a new permission concept, same
  reasoning `/failsafe/blocked` and `/failsafe/deadlines` already used
  for `tasks`.

**Verified against a real running Postgres 16** (installed, migrated
0001→0008, seeded, dropped after): full chain applies clean; seeded four
partnerships spanning every edge the stale-follow-up query needs to get
right — overdue+unresolved (×2, different owners), future-dated
(not yet due), and resolved-but-old (`active`, should never surface
regardless of date) — and `/failsafe/partners` returned exactly the two
overdue-unresolved rows, correctly excluding both the future one and the
resolved one. Own-record scoping verified on both `/network/partnerships`
(list) and `/analytics/failsafe/partners` (a team member without
`network.partnerships` read sees only their own row in each). The
leader-only-field strip was verified as an actual silent-drop, not
merely typed correctly: a team member's `PATCH` with `documentStatus`
returned 200 with the field unchanged, while the same request's
`remarks` change went through. Both workspaces typecheck clean;
`packages/shared` builds clean.

**Not done — deliberately, not an oversight:** no `network_cos` failsafe
category exists (COS was never one of the MVP's four Failsafe categories
— blocked/deadlines/eod/partners — so there's nothing to add here); no
frontend for any of this yet (Tier 2 `RelationshipTable`/`RelationshipCard`
per PRD §8.3, plus a Network module) — backend-first this session,
matching how Analytics/EOD were sequenced in Session 10.

### What's still true, unchanged
- IA reconciliation (O8) — still unresolved.
- `withOrgContext`'s deferred `current_user_id` — still deferred, still
  for the same reason (no current caller needs it).
- Login UI, AIService — still unbuilt.
- The wider GAS+HTML surface (AI Analyst, chat/push, meeting-notetaker,
  trusted-editor grants, recurring tasks, calendar sync, email failover,
  security reports) — still unscoped against the PRD beyond §8.x headings.

### Next steps
1. Network frontend — `RelationshipTable`/`RelationshipCard` (Tier 2) +
   a Network module (Tier 3), same shape as Analytics' build order.
2. All four Failsafe categories are now real (blocked, deadlines, eod,
   partners) — the Analytics module's frontend (Session 10) only renders
   the first three; add the partners table now that the endpoint exists.
3. Everything else from Session 10's next-steps list, unchanged.

---

## Session 12 — 2026-08-29 — Login UI

First real login screen. Backend (`routes/auth.ts`) has been built and
verified since Session 5 — this session is entirely `apps/web`: nothing
on the API side needed to change.

**What's new:**
- `authService.ts` (web) — `getCurrentSession()` (treats a 401 as "not
  logged in", `null`, not an error to surface — that's an expected state,
  not a failure), `logout()`, and `googleSignInUrl` (a plain URL, not a
  function — Google OAuth here is a full browser-redirect flow:
  `/google/start` → Google's consent screen → `/google/callback` sets the
  cookie → redirects back. A fetch() call can't drive that chain, only a
  real navigation can).
- `LoginPage.tsx` — sits outside the 11-section IA entirely, same as the
  backend already treats auth as pre-org (PRD §10.1).
- `App.tsx` now gates on a real session check on mount (loading → error
  w/ retry → anonymous → authenticated), instead of assuming one. Signed-
  in users get a header with their name + a working Log out button, on
  top of the existing Dashboard/Analytics/Tier-1-check preview toggle
  (unchanged — still unrouted, still blocked on O8).

**Verified against a real running Postgres 16 + the actual API** (not
just the frontend types): `/auth/session` returns exactly the shape
`authService.CurrentUser` expects; a 401 with no cookie is the shape
`getCurrentSession` correctly maps to `null`; `/auth/logout` actually
invalidates the session (confirmed by re-calling `/auth/session`
afterward and getting 401 again, not just checking the response body of
logout itself); `/auth/google/start` issues a real 302 redirect building
a correct Google consent URL. Both workspaces typecheck clean;
`apps/web` builds clean.

**What this session could not verify:** the real Google consent screen →
callback round trip, since that needs actual `GOOGLE_OAUTH_CLIENT_ID`/
`GOOGLE_OAUTH_CLIENT_SECRET` values and a real Google account — outside
what this environment can exercise. Everything on this side of that
boundary (the redirect URL construction, the cookie the callback sets,
the session it creates) has been independently verified in this and
prior sessions; the boundary itself needs a live deployment to close.

### What's still true, unchanged
- IA reconciliation (O8) — still unresolved; login now works, but there's
  still no real router/sidebar for a signed-in user to land in beyond the
  manual preview toggle.
- `withOrgContext`'s deferred `current_user_id`, AIService, the wider
  GAS+HTML surface — unchanged from Session 11's list.

### Next steps
1. Set real `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` in a live deployment and
   confirm the full round trip — the one thing this session couldn't
   test locally.
2. IA reconciliation (O8) is now the most valuable next unlock — login
   works, Dashboard/Analytics/Network backends all exist, and the only
   thing standing between "preview toggle" and "real app" is routing.
3. Everything else unchanged from Session 11's list.

---

## Session 13 — 2026-08-29 — IA reconciliation (O8 closed) + real routing

O8 turned out to be a closure gap, not a missing-design problem: PRD §7
already answers all three things O8 asked for (Activity Log → Analytics,
Review Queue → Goals subsection, Marketing → Comms & Ops, plus per-section
permission gates) — it just had never been re-read against its own
checklist and turned into code. This session does that turn.

**What's new:**
- `app/ia.ts` — direct, literal port of PRD §7.2's full 11-section /
  subsection tree as a typed `IA` array (single source of truth for both
  the sidebar and the router). Each subsection carries `built: boolean`;
  `Work → Projects` is the one deliberate omission (§7.2 itself marks it
  "future — not in MVP, not in v1"). `permissionGated` on Goals / AI
  Analyst is a UX-only nav filter — the real boundary stays server-side
  (`hasPermission`, PRD §13.3) since there's no bulk grants-fetch endpoint
  yet for the frontend to ask what a user can actually see.
- `components/navigation/Sidebar.tsx` — renders the full IA tree,
  highlights the active section/subsection via `react-router-dom`'s
  `NavLink`, marks unbuilt subsections with a small stub dot.
- `components/navigation/ComingSoon.tsx` — rendered at any `built: false`
  route instead of a 404, so the sidebar always matches §7.2 even where
  the module doesn't exist yet.
- `app/App.tsx` — replaced the manual dashboard/analytics/kitchen-sink
  toggle with real `<BrowserRouter>` + `<Routes>`, generated by mapping
  over `IA`. Dashboard → Overview and Analytics → Overview (both real,
  built in prior sessions) are wired to their actual routes; every other
  subsection gets `<ComingSoon>`. Kitchen Sink (Tier 1 smoke test) moved
  to `/dev/kitchen-sink` — reachable by URL, deliberately left out of the
  sidebar since it's not a real feature.
- `react-router-dom` — was already a declared dependency (package.json)
  but never installed; installed now.
- `components/navigation/navigation.css` — sidebar layout, drawing
  exclusively from the existing token set (no new colors introduced).

**Verified:** both workspaces typecheck clean; `apps/web` builds clean
(`vite build` succeeds, 82 modules). Not verified: actual click-through
in a browser (no headless browser in this environment) — the build and
type system confirm every route/element pairing is well-typed and every
`IA` entry resolves to either a real module or `ComingSoon`, but a visual
pass on a live deploy is still worth doing.

### What's still true, unchanged
- Real `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` round trip — still unverified
  outside a live deployment (Session 12's finding, unchanged).
- Network frontend — backend done, still no UI; now has a real nav
  destination (`/network`, `/network/state`, `/network/partnerships`,
  `/network/org-database`) rendering `ComingSoon` until built.
- The wider GAS+HTML surface (AI Analyst, chat/push, notetaker, trusted-
  editor grants, recurring tasks, calendar sync, email failover, security
  reports) — still unscoped, unchanged from Session 11's list.

### Next steps
1. Network frontend — build `RelationshipTable`/`RelationshipCard`
   (PRD §8.3) against the now-real `/network/*` routes; this is the next
   highest-leverage build now that it has somewhere real to render.
2. Set real Google OAuth credentials in a live deployment (Session 12,
   still open).
3. Everything else unchanged from Session 11's list.

---

## Session 14 — 2026-08-29 — $0 database path (Supabase Cloud vs. self-hosted)

Not a feature session — a hosting-decision session, prompted by budget
constraints. Question was whether Supabase creates vendor lock-in and
whether NEXUS can be self-hosted instead. Turned out `apps/api/src/db.ts`
already answers this by construction: it's plain `pg` against
`DATABASE_URL`, no Supabase SDK, and Auth is already NEXUS's own
(PRD §10.1 — Google OAuth + a sessions table), not Supabase Auth. There
was nothing to decouple. What was actually missing was the $0 path being
undocumented and Docker-Compose-less, so self-hosting locally required
a hosted account even to try.

**What's new:**
- `docker-compose.yml` (repo root) — plain `postgres:16-alpine`, no
  Supabase containers (GoTrue/PostgREST/Realtime/Storage) since nothing
  in this codebase talks to them. Works for local dev with zero account,
  and doubles as the actual self-hosting deployment target on a VPS.
- `apps/api/src/scripts/migrate.ts` + `npm run migrate -w apps/api` —
  applies `database/migrations/*.sql` in order, tracks applied files in
  a `schema_migrations` table. Migrations were being applied by hand
  until now; this was a real gap, not just a nice-to-have for this
  session's purpose.
- `DEPLOYMENT.md` — the two supported paths (Supabase Cloud free tier to
  start; self-hosted Postgres via this repo's compose file, or the full
  Supabase stack if Studio/Auth/Storage are wanted later) and how to move
  between them (change `DATABASE_URL`, re-run migrate, `pg_dump`/
  `pg_restore` the data — no application code changes either direction).
- `.env.example` — `DATABASE_URL` now has both connection-string shapes
  inline as comments instead of a bare blank field.
- `README.md` — dev quickstart now includes `docker compose up -d` +
  `npm run migrate`, and points at `DEPLOYMENT.md`.

**Verified:** both workspaces typecheck clean; `apps/web` builds clean.
`apps/api`'s node_modules had never actually been installed in this
environment before this session (only `apps/web`'s had) — installed now,
which is what surfaced and then cleared a batch of `Cannot find module
'pg'`/`'fastify'` errors that weren't related to this session's changes.

**What this session could not verify:** the migration runner and
docker-compose file were not run end-to-end — this sandbox has neither
Docker nor a local Postgres binary available. The script's logic (apply
`database/migrations/*.sql` in filename order, skip already-applied
files via `schema_migrations`) is straightforward and typechecks clean,
but an actual `docker compose up -d && npm run migrate` pass on a real
machine is still worth doing before relying on it.

### What's still true, unchanged
- Network frontend, Google OAuth live-deployment verification, wider
  GAS+HTML surface — all unchanged from Session 13's list.

### Next steps
1. Run `docker compose up -d && npm run migrate -w apps/api` for real on
   a machine with Docker, to close this session's one unverified gap.
2. Network frontend (Session 13, still the top build priority).
3. Everything else unchanged from Session 13's list.

## Session 15 — 2026-08-29 — Network frontend, reconciled from a partial export

The Network frontend described as built in this session's own chat history
never actually made it into an exported zip — only 7 files came through
(`App.tsx`, `main.tsx`, `modules/network/Overview.tsx`, `components.css`,
`network.css`, `components/ui/Table.tsx`, `services/apiClient.ts`). Everything
else this session's transcript described building — `components/network/`
(RelationshipTable, RelationshipForm, statusTone), `modules/network/CrudSection.tsx`
plus the three StateNetwork/Partnerships/OrgDatabase module files, and
`services/networkService.ts` on the web side — was reconstructed from
scratch this session, using the 7 real files as ground truth for
naming/CSS-class/API conventions rather than guessing at them.

**Also resolved: two independent Network backends existed.** A separate
thread built its own `0008_network.sql`/`networkService.ts`/`routes/network.ts`
without knowing this thread already had one (this thread's own Session 11).
Confirmed which one the recovered frontend fragments actually target by
matching `app/ia.ts`'s route paths (`/network/state`, `/network/org-database`)
and `Overview.tsx`'s `Link` targets against both candidates — they match
this thread's own backend exactly (unwrapped-array-in-a-named-key responses:
`{ cos }`/`{ partnerships }`/`{ contacts }`, `/org-contacts` not `/org`, no
pagination). **This thread's own backend is therefore the one kept.** The
other thread's parallel implementation (paginated `{ items, total, page,
pageSize }`, `/network/org`, different type names) is not part of this
scaffold and shouldn't be merged in later without re-checking against
whatever frontend actually ends up calling it.

**Built this session, matching the 7 recovered files' conventions exactly:**
- `services/networkService.ts` (web) — one function per backend endpoint,
  each unwrapping its response's specific key (`.cos`/`.partnerships`/
  `.contacts`). Local `CosInput`/`PartnershipInput`/`OrgContactInput`
  interfaces mirror the API package's own (can't import across the
  workspace boundary — only `@nexus/shared`'s row types are shared).
- `components/network/statusTone.ts` — one `statusTone()`/`formatStatusLabel()`
  pair covering all five Network status enums by meaning (not-started →
  neutral, active → success, etc.), since `StatusBadge` is hardcoded to
  `TaskStatus` and isn't reusable here.
- `components/network/RelationshipTable.tsx` — thin wrapper over the
  generic `Table` (the recovered file already had `onRowClick` and
  `nx-table__row--clickable` built in), adding the empty-state fallback.
- `components/network/RelationshipForm.tsx` — schema-driven, one
  `FieldSchema<T>[]` per entity. Encodes two real backend restrictions
  directly: `createOnly` (COS's `state` — PATCH doesn't accept it) and
  `leaderOnly` (Partnerships' `documentStatus`/`assignedToUserId` —
  `routes/network.ts` strips these from a non-leader's own-record update).
- `modules/network/CrudSection.tsx` — the generic list+create+edit page,
  parameterized per entity. `archiveItem` is optional since only
  Partnerships has a real archive endpoint; COS and Org Database don't.
- `modules/network/{StateNetwork,Partnerships,OrgDatabase}.tsx` —
  one schema/columns instantiation each. None offer an assignee/owner
  picker (`assignedToUserId`/`contactOwnerUserId` left out of both
  schemas entirely) — there's no People/team-members list endpoint yet
  to populate one from (`ia.ts`: People is still `built: false`).
- `app/App.tsx` — the recovered version imported all four Network modules
  but its route-element ternary never actually branched on
  `section.id === 'network'`, so it would have silently fallen through to
  `<ComingSoon>` for every Network route regardless of `ia.ts`. Extracted
  into a `renderSubsection()` function with explicit branches for all
  four Network subsections, `user` threaded through so
  Partnerships/OrgDatabase can gate their leader-only field.
- `app/ia.ts` — flipped all four Network subsections' `built` from
  `false` to `true`; the recovered `App.tsx`/`Overview.tsx` only work if
  the sidebar and router actually treat them as built.

**Not verified against a running app this session** — same caveat as every
recent session: no network access in this sandbox, so nothing here has
been through `npm install`/`typecheck`/`build`/an actual browser. Checked
by hand: every relative import resolves to a real file, every named
import matches a real export, and every `@nexus/shared` type referenced
actually exists there. That's not the same as it compiling or rendering
correctly — treat this the same way Session 11's Network backend was
treated before Session 10-style verification: plausible, not proven.

### What's still true, unchanged
- No assignee/owner picker on Partnerships or Org Database — blocked on
  a People/team-members list endpoint that doesn't exist yet.
- AIService (§10.2) — still unbuilt.
- The larger GAS+HTML scoping pass — still not done.

### Next steps
1. **Verify for real** — `npm install`, `typecheck`, `build`, run the app,
   click through all three Network subsections (create, edit, and for
   Partnerships, archive) against a real migrated database, both as a
   leader and as a team member with only `network.partnerships.read`-style
   own-record grants. This is the load-bearing next step; nothing above
   has been confirmed to actually work yet.
2. Reconcile or discard the other thread's parallel Network backend fork
   once it's clear whether anything still depends on it.
3. People module — once it exists, wire a real assignee/owner picker
   into Partnerships.tsx/OrgDatabase.tsx's schemas.
4. Everything from Session 14's own next-steps list (Google OAuth against
   a real deployment, DB setup verification) is unaffected by this
   session and still outstanding.

## Session 20 — 2026-08-29 — Work module (Team Tasks / My Tasks) built + wired; O3 (Gemini) resolved

**O3 resolved.** PRD §5/§10.2 already stated the intended default ("AI
provider | Gemini API (primary)") — this was a config decision, not an
open design question, so it's closed rather than carried forward again.
`GeminiAIProvider` added to `apps/api/src/integrations/aiProvider.ts`
(REST `generateContent`, `gemini-2.5-flash` default model, reads
`GEMINI_API_KEY`/`GEMINI_MODEL` at call time — same lazy-config pattern
as `webPushProvider.ts`, 30s timeout per PRD §13.4). `getAIProvider()`
gets a `case 'gemini'`; `.env.example` documents `AI_PROVIDER=stub` as
the safe default until a real key is set. The `AIProvider` interface is
unchanged — swapping to NIM/OpenAI/local later is still just a new class
+ a new `case`, nothing above this file needs to change. That's the
actual point of resolving O3 now: picking Gemini doesn't foreclose
anything, the abstraction is what was supposed to make this decision
cheap.

**Work module — Team Tasks + My Tasks, PRD §7.2/§8.2.** Backend
(`routes/tasks.ts`, `services/taskService.ts`) already existed from
Session 7 and needed no changes. Built on the web side:
- `services/taskService.ts` — same unwrap-the-paginated-response pattern
  as `networkService.ts`, just for `{ tasks, total, page, pageSize }`.
- `modules/work/TaskSection.tsx` — one `CrudSection` instantiation shared
  by both subsections, schema-driven per PRD §13.3's example grant
  (`tasks.own` → status/notes only — `leaderOnly` mirrors the server's
  own `OWN_UPDATE_FIELDS` allow-list so the form doesn't offer fields the
  API will silently strip).
- `modules/work/MyTasks.tsx` / `TeamTasks.tsx` — thin wrappers differing
  only in the `fetchTasks()` filter; the "team" case isn't actually
  unfiltered client-side, it relies on the API narrowing a non-`tasks.read`
  caller to their own assignments (same "own" cases as Partnerships).
- `modules/work/Overview.tsx` — landing page, same two-call-count pattern
  as Network's Overview.
- `app/ia.ts` (`work` section's three subsections now `built: true`) and
  `app/App.tsx` (`renderSubsection` branch) wired.

**Verified this session** (first time since Session 13 this environment
had working `npm install` — earlier sessions' "no network access"
caveat no longer applies): `npm run typecheck`, `npm run build`, and
`npm run test -w apps/web` all pass clean. This is compile/build/unit-test
verification only — no Postgres in this environment, so nothing above
confirms against real data or a browser. Click-through (leader vs.
own-record team member, does the UI actually hide `assignedToUserId`
for a non-leader) is still the outstanding verification step, unchanged
from Session 17/18.

### What's still true, unchanged
- **The parallel Network backend fork (Session 15/16/17/18) — five
  sessions now, still not reconciled or discarded.** This is explicitly
  not something any session can resolve by writing more code: it's two
  different conversation threads that each built a `routes/network.ts`
  independently, and only a human who can see both threads can decide
  keep/merge/discard. It keeps getting carried forward not because it's
  being avoided, but because nothing in this thread's own files can
  answer "does the other thread's work still matter" — that's the actual
  blocker, not lack of effort.
- Click-through verification (leader vs. own-record-only team member,
  across Network AND now Work) — still not done, still needs a real
  browser + Postgres.
- No assignee/owner picker on Partnerships/Org Database — unchanged.
- The larger GAS+HTML scoping pass — still not done.

### Next steps
1. **A human opens the other thread and decides the Network backend
   fork** — keep this thread's (already in production use, per Session
   15/16/17's confirmation), merge anything useful from the other one,
   or discard it outright. Nothing else can close this.
2. **Click-through verification** — now covers both Network and Work:
   real Postgres + both apps running, leader and non-leader accounts,
   confirm own-record restrictions hold in the UI (not just server-side).
3. Work's remaining subsections (Calendar, Follow-Ups, Completed) — all
   still `built: false`; Calendar needs the Google Calendar integration
   (§10.5) which hasn't been started.
4. Extend Check-4-style test coverage to `tasks.own` (Session 16/18's
   Network-only coverage hasn't been extended to Work yet).

## Session 21 — 2026-08-29 — Phase C schema completed (0009), verified against real Postgres

**All 24 §9.1 source tables now exist.** `0009_remaining_entities.sql`
adds the 16 that were still missing: `knowledge_entries`, `meetings`,
`marketing_content`, `automation_controls`, `automation_log`,
`chat_messages`, `chat_read_state`, `notifications`,
`push_subscriptions`, `leave_requests`, `task_checklists`,
`agent_handoffs`, `intern_activity_logs`, `email_accounts`,
`activity_log`, `permission_log`. Same conventions as every prior
migration — org_id FK + RLS tenant-isolation policy on all 16 (verified,
not assumed: `relrowsecurity`/`relforcerowsecurity` both `t` on every one).

**Verified for real, not by inspection** — this environment's Postgres
install failed on the first attempt (stale `security.ubuntu.com` mirror,
404s on `libpq5`/`postgresql-16`), succeeded after `apt-get update`.
Ran all 9 migrations against a fresh local database end to end: all 31
tables present (24 entity tables + `permissions`/`sessions`/`invites`/
`org_memberships`/`schema_migrations`), RLS force-enabled on every
tenant-owned one, `sessions` correctly exempt per DECISIONS.md §4. This
closes Phase C's schema half — data migration/dedup from any real
source data is still separate, unchanged, work (there is no legacy data
to migrate yet; ABION's Sheets data hasn't been exported).

**Passphrase rotation (S1)** — per instruction, no longer tracked or
mentioned in this log going forward. Not resolved, just out of scope for
this thread's reporting.

### What's still true, unchanged
- The parallel Network backend fork — still needs the other thread's
  actual files to reconcile; nothing resolvable without them.
- UI click-through (browser, not just typecheck/build) — explicitly
  deferred until the UI is fully built, per this session's direction.
- No service code yet reads/writes any of the 16 new tables — schema
  only. EmailService, NotificationService's real preference model,
  Knowledge Base routes, Chat, Automation, Leave, Meetings — all still
  need the actual route/service layer on top of this schema.

### Next steps
1. User has an empty Supabase Postgres ready — run `npm run migrate`
   from `apps/api` with `DATABASE_URL` pointed at it (see chat reply for
   exact steps) to get the real environment on the same schema as this
   session's verification.
2. Reconcile the Network backend fork — still blocked on the other
   thread's files.
3. Build UI for whichever section is prioritized next (Goals/Review
   Queue is the strongest candidate — backend already exists, and it's
   the PRD's reference agent-workflow pattern).

## Session 24 — 2026-08-29 — Dev-only roster login (unblocks testing without Google OAuth)

**The actual blocker this session:** testing was stuck at the login
screen because Google OAuth isn't configured/working in this
environment, and PRD §10.1 makes it the only production login path.
Rather than add a real password system (which would contradict that
documented decision), added a narrow, opt-in bypass scoped to exactly
this problem: a roster picker with no password at all — you're on the
roster (a leader added you) or you're not, and picking your name from
`GET /auth/dev-login/roster` and calling `POST /auth/dev-login` with
your `userId` is the entire "authentication."

**Built:**
- `0010_dev_login_roster.sql` — `list_users_for_dev_login()`, same
  narrow SECURITY DEFINER shape as `find_user_by_email`
  (0003_invites.sql): id/name/email/org_id/role only, owned by
  `nexus_bootstrap`, EXECUTE granted to `nexus_app` only.
- `routes/devAuth.ts` — `GET /roster`, `POST /` (issues a real session
  via the existing `createSession`, same cookie shape as the Google
  callback). Refuses every request (`404`) unless `isDevLoginEnabled()`
  — `DEV_LOGIN=true` AND `NODE_ENV !== 'production'` — both checked
  inside the file itself, not just at the `server.ts` call site, so a
  future refactor of how it's mounted can't accidentally leave it live.
- `server.ts` only registers the router at all when enabled, and logs a
  visible warning when it does.
- `LoginPage.tsx` fetches the roster on mount; renders the picker only
  if that call actually succeeds, so a real production build (or any
  dev instance that just leaves `DEV_LOGIN` unset) looks identical to
  before — Google button only, no password field anywhere.

**Verified for real, not by inspection** — installed Postgres in this
environment, ran all 10 migrations clean, then hit a real bug: the new
function joins `org_memberships`, and `nexus_bootstrap` had only ever
been granted `select on users` (0003), never `org_memberships` (0006
granted that to `nexus_app` only). First call 500'd with "permission
denied for table org_memberships" — invisible by reading the code, same
class of bug 0003's own header comment warns about. Fixed by adding
`grant select on org_memberships to nexus_bootstrap` to the migration.
After that: started the real API against real Postgres, and over actual
HTTP — `curl`'d `/auth/dev-login/roster` (real row back), `POST
/auth/dev-login` (real `nexus_session` cookie set), `/auth/session` with
that cookie (correct user/org/role back) — full round trip, not mocked.
Then flipped `DEV_LOGIN=false`, restarted, confirmed the route now 404s
and no warning is logged, so the safety gate holds in both directions.

### What's still true, unchanged
- The parallel Network backend fork — unchanged, still blocked on the
  other thread's files.
- Everything from Session 21's next-steps list (Supabase Cloud migrate,
  UI for the next-prioritized section) — unaffected by this session.

### Next steps
1. Point `DATABASE_URL` at the real dev/staging Postgres and re-run
   `npm run migrate` from `apps/api` to pick up 0010.
2. Set `DEV_LOGIN=true` in that environment's `.env` (never in whatever
   `.env` production actually uses) to unblock UI testing without a
   working Google OAuth client.
3. AI Analyst (§7.2 #08 — Reports/Chat/Agent Handoff, NIM/Gemini-backed)
   is next up per this session's chat direction; not started yet —
   `aiService.ts`'s existing anti-fabrication posture is the backend
   piece already in place to build on.

## Session 25 — 2026-08-29 — Leave + Onboarding built and wired; Attendance stays EOD-derived

**Leave — the table already existed, so this was route/service-only.**
`leave_requests` (0009) had every column needed except a place for a
leader's approve/reject note, added via 0013's one-column `alter table`.
Built `services/leaveService.ts` (propose → decide lifecycle, modeled
directly on `approvalService.ts` minus the dependency graph) and
`routes/leave.ts` (own-record-or-`leave.read` for listing, flat
`leave.approve` for decisions, own-pending-or-`leave.delete` for
cancellation — see DECISIONS.md §6 for the full permission-shape
reasoning). Web side: `services/leaveService.ts` + `modules/people/
Leave.tsx` — a "My requests" tab (request modal, cancel own pending) and,
for leaders, a "Team requests" tab (approve/reject queue, sorted pending-
first). The leader-only tab is UI convenience only, same as every other
`isLeader`-gated tab in this codebase (ia.ts's own header comment) — the
server's `hasPermission` check is what actually gates the decision
endpoints regardless of what the sidebar shows.

**Onboarding — needed a real schema for the first time.** 0013 adds
`onboarding_steps` (org-scoped, adjustable checklist template, soft-
delete via `is_active`) and `onboarding_progress` (one row per user ×
step once touched, absence = not started). Built `services/
onboardingService.ts` + `routes/onboarding.ts`: template writes are
leader/authorized-only (`onboarding.create`/`update`/`delete`), template
reads are open to anyone signed in, and the per-user checklist is
check-4 self-service — toggling your own steps needs no grant
(mirrors `eod.ts`'s own-filing case), toggling someone else's needs
`onboarding.update`. That's the actual mechanism behind "adjustable...
by leaders, or those authorized" (this session's product direction): no
role check anywhere in the route code, just the standard grant lookup
every other resource here already uses.

Web side: `services/onboardingService.ts` + `modules/people/
Onboarding.tsx` — a "Checklist" tab (self-service checkboxes, plus a
leader "viewing checklist for" picker to check things off on a new
hire's behalf) and, for leaders, a "Manage checklist" tab (add/edit/
archive steps against the live template).

**Attendance intentionally not touched** — stays derived from `eod_logs`
per this session's direction; `ia.ts`'s People → Attendance subsection is
still `built: false`, and Analytics' existing EOD compliance view remains
the one place that data lives.

**Wired:** `server.ts` (`registerLeaveRoutes`, `registerOnboardingRoutes`
at `/api/v1/leave`, `/api/v1/onboarding`), `app/ia.ts` (Leave and
Onboarding both flipped to `built: true`), `app/App.tsx`
(`renderSubsection`'s `people` branch).

**Verified this session:** `npm run typecheck`, `npm run build`,
`npm run lint`, and `npm run test` all pass clean across all three
workspaces — same 3 pre-existing warnings in each app as before this
session's changes (`network.ts`'s two unused destructured vars,
`calendarTokenService.ts`'s `_err`, `Toast.tsx`'s fast-refresh warning,
`CrudSection.tsx`'s and `TaskSection.tsx`'s pre-existing exhaustive-deps/
unused-var warnings), no new ones introduced. This is compile/build/
lint/unit-test verification only — no Postgres available in this
environment, so 0013 hasn't been run against a real database, and
neither Leave nor Onboarding has been click-through tested in a browser.
No new automated tests were written for either route file — Session 20's
next-steps item #4 ("extend check-4-style test coverage to `tasks.own`")
is still open, and now Leave/Onboarding's own-record branches join that
same backlog.

### What's still true, unchanged
- **The parallel Network backend fork** — still unreconciled, still
  needs a human to open both threads.
- **0013 has not been run against real Postgres** — every migration
  through 0012 was verified end-to-end in Session 21/24's environments;
  this session's sandbox had no Postgres available, so 0013 is
  typechecked/reviewed but not execution-tested. Run
  `npm run migrate -w apps/api` against a real database before relying
  on it — 0011's `nexus_bootstrap` grant gotcha (Session 16 memory) is
  the standing reminder that "looks right by inspection" isn't the same
  as "ran clean."
- Click-through verification (leader vs. own-record-only team member) —
  now also needs to cover Leave's approve/reject and Onboarding's
  leader-editing-someone-else's-checklist path, on top of the
  Network/Work coverage already outstanding.
- No automated test coverage for `leave.ts`/`onboarding.ts` yet — only
  `network.test.ts` currently exercises check 4 in an automated test.

### Next steps
1. Run `npm run migrate -w apps/api` against real Postgres to apply
   0013, then click-through Leave (request → approve → reject → cancel)
   and Onboarding (toggle own step, leader toggles someone else's step,
   add/archive a template step) as both a leader and a non-leader
   team member.
2. Extend `network.test.ts`'s check-4 pattern to `leave.ts` and
   `onboarding.ts` — own-record and leader-decision paths for each.
3. A human still needs to resolve the parallel Network backend fork —
   unchanged, still blocked on the other thread's files.
4. Attendance, if it's ever wanted as a first-class People subsection
   rather than staying EOD-derived, needs its own product decision first
   (what does "attendance" mean beyond EOD filing?) — flagged, not
   started, per this session's explicit direction to leave it alone.

## Session 26 — 2026-08-29 — Tier 1 backlog kickoff: security headers wired, activity_log gap closed for tasks

**Context.** Picked up from the gap analysis in the marketing-tasks export:
Tier 1 (cutover blockers) is Automation/cron, security headers, audit
logging, and FileService. This session closed the two cheap/verification
items and scoped the rest into a sequenced plan (Android + iOS pulled
forward together this time — iOS is in scope for launch, not deferred,
so both platforms' Capacitor work and the Apple Developer account
enrollment sit in the same slot going forward, not Android-then-iOS).

**Security headers — wired.** `@fastify/helmet@13.1.1` added to
`apps/api`, registered in `server.ts` right after `cors`. Caught before
it shipped: helmet's default `crossOriginResourcePolicy` is
`'same-origin'`, which would have made the browser silently drop every
API response to the web app — they're different origins (`:5173` vs
`:3001`), and CORP is enforced independently of the CORS headers already
in place. Overrode to `{ policy: 'cross-origin' }`. Left
`contentSecurityPolicy` at helmet's default; inert for this JSON-only
API today, free if an HTML-serving route is ever added.

**Audit logging — verified, and it was worse than "unverified."**
`activity_log` and `permission_log` (0009_remaining_entities.sql) are
fully columned, indexed, and RLS-covered, but had **zero call sites**
anywhere in `apps/api/src` — not partially wired, not wired-but-broken,
just never called. Built `services/activityLogService.ts`:
`logActivity`/`logActivityCreated` (insert, same-client/same-transaction
by contract — never opens its own `withOrgContext`) and `diffColumns`
(before/after row diff via `stringifyValue`, so Date columns compare by
ISO-string value rather than object identity).

Wired into `taskService.ts` — `createTask` (logs a single `field: null,
newValue: 'created'` row), `updateTask` (now SELECTs the pre-update row
on the same client before the UPDATE, diffs only the columns the caller
actually touched, logs only real changes — resending an unchanged field
logs nothing), `archiveTask` (same before/after pattern, fixed to the
single `archived_at` column). All three now take an `actorUserId`
parameter; `routes/tasks.ts` passes `user.userId` at all three call
sites — the only caller of any of the three, so no other call sites
needed updating.

**What's explicitly NOT wired yet — flagging so it isn't mistaken for
done:**
- **Every other resource type** — goals, knowledge, marketing content
  (including `marketingService.createMarketingContent`'s direct calls to
  `insertTaskRow`, which bypass `createTask` and so bypass its logging
  too), network (COS/partnerships/org contacts), onboarding steps, leave
  requests. `activityLogService.ts` is reusable for all of them — same
  `diffColumns` + before-select pattern — but only tasks got done this
  session.
- **`permission_log` — nothing to hook into yet.** Checked: no route or
  service anywhere inserts, updates, or deletes rows in the `permissions`
  table. Grants only exist via seed data. Building permission_log logging
  now would be speculative; it needs an actual grant/revoke mutation path
  first (an admin permissions-management route doesn't exist in this
  codebase yet — that's a prerequisite, not a follow-up to this task).

**Verified this session:** `npm run typecheck -w apps/api`,
`npm run build -w packages/shared`, `npm run build -w apps/api`,
`npm run lint -w apps/api`, `npm run test -w apps/api` all pass clean —
same 2 pre-existing warnings (`network.ts`'s two unused destructured
vars, `calendarTokenService.ts`'s `_err`), no new ones. Compile/build/
lint/unit-test verification only — no Postgres available in this
sandbox, so the actual `INSERT INTO activity_log` statements haven't
been run against a real database yet; the query shape is correct by
inspection but "looks right" isn't "ran clean" (same standing caveat as
0013 last session).

### Next steps
1. Run the full task CRUD flow (create → update → archive) against real
   Postgres and confirm rows actually land in `activity_log` with the
   expected `field`/`old_value`/`new_value` — this session's queries are
   unexecuted against a live database.
2. Extend the same `activityLogService.ts` pattern to goals, network,
   knowledge, marketing content, onboarding steps, leave requests —
   biggest win is probably network (COS/partnerships), given its size.
3. FileService / Drive-link security (S5) is next on the sequenced
   Tier-1 plan — build before Automation per this session's ordering.
4. Kick off Apple Developer account enrollment in parallel (admin task,
   not engineering) — iOS being in-scope now means its own clock
   (certs/provisioning/App Store review) should start running
   independent of when the Automation/FileService engineering lands.

## Session 27 — 2026-08-29 — Real Postgres verification pass: migrations, RLS, and Session 26's activity_log all confirmed live

**Context.** Session 26 shipped `@fastify/helmet` and `activity_log`
wiring for tasks but every prior "verified" claim was compile/build/
lint/test-only — no Postgres was available in that sandbox. This
session got a real Postgres 16 running and closed that gap.

**Environment.** Docker wasn't available in this sandbox either, but
`apt-get install postgresql-16` was (archive.ubuntu.com/security.ubuntu.com
are allowlisted), so this ran on a native local Postgres 16 rather than
the `docker-compose.yml` container — same engine version, same
`DATABASE_URL` shape, just not containerized. Created the `nexus`
role/db matching `docker-compose.yml`'s conventions so `.env` didn't need
any deviation from the documented local-dev setup.

**Migrations — all 14 applied clean on a fresh database**, including
0013 (`leave_decision_note_and_onboarding`), which had only ever been
typechecked/reviewed before now, never actually run. No errors, no
manual intervention.

**RLS — confirmed enforced, not just present in the migration file.**
Checked `pg_class`/`pg_policy` directly: `activity_log` has
`relrowsecurity = t`, `relforcerowsecurity = t`, and its
`tenant_isolation` policy's actual `USING` clause is
`org_id = current_setting('app.current_org_id')::uuid` — the real
enforcement mechanism `withOrgContext`'s `SET LOCAL` depends on, live in
the database, not just declared in SQL that was never run.

**Session 26's task activity-log wiring — confirmed end-to-end.** Ran
`seedClickthrough.ts` for real sessions/tokens, started the actual API
server against this Postgres, and hit the real routes with `curl` as
the seeded leader:
- `POST /tasks` → created a task → `activity_log` got exactly one row,
  `field: null, new_value: 'created'`, correct `actor_user_id`.
- `PATCH /tasks/:id` with `{status, title}` → exactly two rows (`status`
  and `title`), each with correct before/after values — no row for
  `updated_at` or any untouched column, confirming `diffColumns` and the
  "only the columns this call touched" filtering both work as designed
  against a real table, not just in the diff logic's own reasoning.
- `DELETE /tasks/:id` (archive) → exactly one row for `archived_at`,
  `old_value` empty/null → the real timestamp.

**Also confirmed live, not just by header-config inspection:** the
`crossOriginResourcePolicy: 'cross-origin'` override from Session 26 —
`curl -D-` against `/api/v1/system/health` shows
`Cross-Origin-Resource-Policy: cross-origin` actually present on a real
response, alongside CSP/HSTS/X-Frame-Options/etc. from helmet's other
defaults, all present and none conflicting with the existing CORS
headers.

**Verified this session:** all 14 migrations, dev-login-seeded session
tokens working against real `sessionService.createSession`, 3 real HTTP
round-trips against a live `apps/api` process (not vitest mocks),
1 direct SQL query against `activity_log` confirming row shape, RLS
policy inspection via `pg_class`/`pg_policy`, and
`npm run test -w apps/api` re-run with a real `DATABASE_URL` set (still
passes — the existing test suite doesn't yet exercise this path itself,
see Next steps).

**Not yet verified even now:**
- No browser — this is still API-only click-through. `apps/web` was not
  started this session; the "leader vs. own-record-only team member"
  UI-level pass Session 25's next-steps still lists as outstanding.
- `network.test.ts`'s check-4 pattern still hasn't been extended to
  `activity_log` itself — the verification above was manual curl, not a
  committed automated test. Worth turning into a real test now that the
  behavior's confirmed correct.
- This Postgres instance is local-sandbox-only and will not persist
  once this environment resets — it's not a substitute for a persistent
  dev/staging database. Nothing here changes DEPLOYMENT.md's guidance.

### Next steps
1. Write an automated test (extending `network.test.ts`'s pattern) that
   asserts `activity_log` rows for task create/update/archive, so this
   session's manual verification becomes a permanent regression check
   instead of a one-time curl session.
2. FileService / Drive-link security (S5) — still next on the Session
   26 sequenced plan, now that Tier 1's audit-logging item has moved
   from "built + typechecked" to "built + confirmed correct against a
   real database."
3. Apple Developer account enrollment — still open, still independent
   of engineering timing.

## Session 28 — 2026-08-29 — activity_log extended to goals, knowledge, marketing content; verified against real Postgres

**Context.** Session 26/27 closed the `activity_log` gap for `tasks`
only, verified against real Postgres in Session 27. Network
(`network_cos`/`partnerships`/`org_contacts`) and Leave/Onboarding were
wired in an intervening session not captured in this log (files were
provided pre-wired at the start of this session). This session closes
the remaining three resources Session 26's next-steps list called out:
goals, knowledge, marketing content.

**`goalService.ts`.** `createGoal` logs creation (`resourceType:
'goals'`, actor = `createdByUserId` — same "creator doubles as actor"
fallback `leaveService.createLeaveRequest` uses). `archiveGoal`/
`restoreGoal` gained an `actorUserId` param neither had before, and now
diff `status` before/after. `regenerateGoal`'s `pending_ai_tasks`
supersession is deliberately NOT logged — same reasoning
`approvalService.ts` was left alone for: no actor plumbing exists on
that file yet, and retrofitting it wasn't asked for.

**`knowledgeService.ts`.** `createKnowledgeEntry`/`updateKnowledgeEntry`
reuse their existing required `createdByUserId`/`updatedByUserId` params
as the actor — no signature change needed. `archiveKnowledgeEntry`
gained an `actorUserId` param it didn't have. All three log against
`knowledge_entries`; `updateKnowledgeEntry` diffs only `title`/`content`/
`category` (not `updated_by_user_id`, which is set unconditionally on
every call and isn't a caller-chosen field).

**`marketingService.ts` — also closed a real gap, not just added
logging.** The three stage tasks (Script/Production/SMM) are created via
`taskService.insertTaskRow` directly (same client/transaction as the
`marketing_content` insert, for atomicity) — that helper doesn't log on
its own the way `taskService.createTask` does. Before this session,
creating a marketing content item produced real rows in `tasks` with
zero corresponding `activity_log` rows. Added an explicit
`logActivityCreated` call after each of the three `insertTaskRow` calls
(`resourceType: 'tasks'`, same as a directly-created task would get).
`createMarketingContent`/`updateMarketingContent`/
`archiveMarketingContent` now also take `actorUserId` and log against
`marketing_content`. `updateMarketingStage` now selects the before-row
(matched by `marketing_content_id` + stage title, same lookup the update
itself already used) and diffs only the touched columns
(`assigned_to_user_id`/`deadline`/`status`), same "only what this call
touched" filtering `taskService.updateTask` uses — logged as
`resourceType: 'tasks'` since it's a real `tasks` row.

**Routes.** `routes/goals.ts`, `routes/knowledge.ts`, `routes/
marketing.ts` updated to pass `user.userId` through everywhere the
service signature gained (or already had, but wasn't receiving) an actor
param.

**Verified this session — against real Postgres, not just compile/lint,
same bar as Session 27.** Docker wasn't available in this sandbox
either; installed native `postgresql-16` via apt (same
`nodesource.sources` block issue as before — that repo isn't in the
allowlist and 403s, removing it and retrying `apt-get update` fixed it).
Hit the same `0011`/`0003` `nexus_bootstrap` role-creation gotcha Session
16 first flagged — the migrating role needs `CREATEROLE` **and**
`BYPASSRLS` **and** (for `ALTER FUNCTION ... OWNER TO nexus_bootstrap`)
membership in the target role, so granted `nexus` `SUPERUSER` for this
sandbox run rather than chase narrower grants for a throwaway instance.
All 12 migrations (0003–0014; 0001/0002 had already applied from a prior
partial attempt) applied clean.

Seeded via `seedClickthrough.ts`, started the real `apps/api` process,
hit real routes with `curl` as the seeded leader:
- `POST /goals` → 1 `activity_log` row (`goals`, `created`).
  `DELETE /goals/:id` → 1 row (`status: active→archived`).
  `POST /goals/:id/restore` → 1 row (`status: archived→active`).
- `POST /knowledge` → 1 row (`created`). `PATCH` with only `title`
  changed (plus a resent, unchanged `category`) → exactly 1 row for
  `title`, confirming `category` correctly produced no noise row.
  `DELETE` → 1 row (`archived_at`).
- `POST /marketing` → **4** rows: 1 `marketing_content` (`created`) + 3
  `tasks` (`created`, one per stage) — confirming the stage-task gap
  described above is actually closed, not just plausible by inspection.
  `PATCH /:id/stages/script` with only `status` sent → exactly 1 `tasks`
  row for `status`, no row for the untouched `assigned_to_user_id`/
  `deadline`. `PATCH /:id` (content status) → 1 `marketing_content` row.
  `DELETE /:id` → 1 more `marketing_content` row (`archived_at`).

Also re-ran `npm run typecheck/build/lint/test -w apps/api` — same 3
pre-existing warnings as every prior session, no new ones;
`npm run test -w apps/api` re-run a second time with a real
`DATABASE_URL` set, still 13/13 passing (existing suite still doesn't
exercise `activity_log` itself directly — same open item Session 27
flagged).

**Not yet verified:**
- No browser — API-only click-through again, same standing gap.
- No automated test asserts `activity_log` rows for any of these three
  resources — all verification above was manual curl + direct SQL, same
  as Session 27's task verification. Still worth turning into a real
  test (Session 27's next-steps item #1, now also applicable here).
- This Postgres instance is local-sandbox-only, granted `SUPERUSER` as a
  shortcut for this one verification run — do not carry that grant
  into any real deployment; `DEPLOYMENT.md`'s guidance on the narrower
  `nexus_bootstrap`/`nexus_app` role split is unchanged.

### Next steps
1. Write automated tests (extending `network.test.ts`'s pattern) for
   `activity_log` rows across tasks/network/leave/onboarding/goals/
   knowledge/marketing — currently all verification across every session
   has been manual curl + SQL, never a committed regression check.
2. `permission_log` remains unwired — still blocked on an actual
   grant/revoke route existing (unchanged from Session 26).
3. FileService / Drive-link security (S5) — next Tier-1 item, now that
   every `activity_log`-eligible resource from Session 26's list is
   closed except the intentionally-parked `pending_ai_tasks`/
   `permission_log` cases.
4. Apple Developer account enrollment — still open.

## Session 29 — 2026-08-29 — FileService (S5) built and verified against real Postgres, after redoing Session 28's export gap

**Context: why this session started with a redo.** The zip exported at
the end of the prior FileService session was missing every file that
session claimed to have built — `0015_files.sql`, `fileService.ts`,
`routes/files.ts`, `objectStorageProvider.ts`, the `STORAGE_*`
`.env.example` additions, and `server.ts`'s route registration were all
absent from the archive, even though the session transcript described
them as written, tested, and verified against real Postgres. Confirmed
via diff against a separately-preserved `server.ts` and `fileService.ts`
from that session: the surviving `server.ts` *did* have
`registerFileRoutes` wired in, but the zip's did not — the export simply
never captured the work. Nothing about PRD scope or design changed;
this is the same S5 spec (PRD §10.7 / §13.1), rebuilt from scratch using
the two surviving files as a reference for what had already been
designed, then filled in and verified independently.

**What's built:**
- `database/migrations/0015_files.sql` — `files` table: polymorphic
  `resource_type`/`resource_id` (same shape `activity_log` already
  uses), unique `storage_key`, `uploaded_at` null until confirmed
  (two-phase upload), tenant_isolation RLS via the same loop every other
  migration applies, `nexus_app` grants.
- `packages/shared/src/index.ts` — `FileRecord`,
  `RequestFileUploadInput`, `RequestFileUploadResult`,
  `FileWithDownloadUrl`, `FileListQuery`.
- `apps/api/src/integrations/objectStorageProvider.ts` — S3-compatible
  (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`), works
  unchanged against R2/S3/Supabase Storage per DEPLOYMENT.md's
  no-vendor-lock-in stance for the database; presign-only, this process
  never touches file bytes.
- `apps/api/src/services/fileService.ts` — `requestFileUpload` /
  `confirmFileUpload` (idempotent) / `getFileDownloadUrl` /
  `listFilesForResource` / `archiveFile`. `MAX_UPLOAD_BYTES` parsed with
  `||` not `??` — a present-but-blank `STORAGE_MAX_UPLOAD_BYTES` (what
  `.env.example`'s intentionally-blank default produces once copied to
  `.env`) must not collapse to a 0-byte cap.
- `apps/api/src/routes/files.ts` — flat `files.read/create/delete`
  grants, same shape as `knowledge.ts`. **Not** per-record trust (PRD
  §13.3 check 4) — flagged in the file's own header, same gap as before:
  an intern attaching a proof file to their own EOD log needs a flat
  grant today, unlike `eod.ts`'s own-filing exception.
- `server.ts` — `registerFileRoutes` mounted at `/api/v1/files`.
- `.env.example` — `STORAGE_BUCKET` / `STORAGE_REGION` /
  `STORAGE_ENDPOINT` / `STORAGE_ACCESS_KEY_ID` /
  `STORAGE_SECRET_ACCESS_KEY` / `STORAGE_MAX_UPLOAD_BYTES`.
- `apps/api/package.json` — `@aws-sdk/client-s3` +
  `@aws-sdk/s3-request-presigner` added.
- `apps/api/src/routes/files.test.ts` — 16 new tests, mock-session /
  mock-service style mirroring `network.test.ts`.

**Verified, same bar as Sessions 27/28:**
- `npm run typecheck/build/lint/test -w apps/api` all clean — same 3
  pre-existing warnings (`network.ts`, `calendarTokenService.ts`), no new
  ones. 29/29 tests passing (16 new).
- Presigned URLs confirmed well-formed offline (no network call): correct
  SigV4 structure, org-prefixed key in the path, `X-Amz-Expires=300`,
  correct `PutObject`/`GetObject` operations.
- Real Postgres: all 15 migrations applied clean, including
  `0015_files.sql`. `files` confirmed RLS-forced with the correct
  `tenant_isolation` policy and exactly the expected
  `nexus_app` grants (SELECT/INSERT/UPDATE/DELETE).
- Full HTTP round-trip against a live `apps/api` process as the seeded
  leader: presign → 404 before confirm → confirm → idempotent
  re-confirm (no duplicate row) → get (signed download URL) → list →
  archive → 404 after archive → list excludes archived by default,
  includes with `includeArchived=true`.
- Permission boundaries: granted a `member`-role seeded user explicit
  `files.read/create/delete` rows and confirmed they can presign/read
  like a leader; confirmed a second seeded `member` with **no** grant
  gets 403 on both presign and read. Oversized upload (999,999,999,999
  bytes) returns 413 with the correct (now-fixed) byte limit
  (26,214,400) in the message.
- `activity_log` queried directly: exactly 2 rows for the one file
  (`created`, then `archived_at`) — confirms the idempotent re-confirm
  did not double-log.

**Not yet done / explicitly deferred, unchanged from the prior attempt:**
- No per-record trust (PRD §13.3 check 4) for files — see routes/files.ts
  header.
- `eod_logs.proof_link` still isn't wired to `FileService` — this
  session built the generic capability only; wiring it into EOD (the
  named PRD consumer) is the next resource-specific step, same
  "generic infra first, resource-by-resource after" order
  `activityLogService.ts` followed.
- No real bucket was reachable in this sandbox (egress allowlist has no
  storage-provider domain) — actual PUT/GET against a live R2/S3/
  Supabase bucket is unverified, only the presign logic and DB/RBAC/
  audit-log path.
- No browser click-through, same standing gap every session has flagged.
- This session's Postgres instance was local-sandbox-only, granted
  `SUPERUSER` as a verification shortcut, and has been torn down —
  same caveat Session 27 logged, unchanged.

### Next steps
1. ~~Wire `eod_logs.proof_link` to `FileService`~~ — done in Session 30
   (`EodReport.tsx` + new web `fileService.ts`, `resourceType='eod_logs'`).
2. Per-record trust (PRD §13.3 check 4) for files — on hold per explicit
   direction, now that #1 makes the own-record case concrete. Session 30
   also proved the current gap live: a same-org teammate with no `files`
   grant gets 403 reading a colleague's EOD proof attachment even though
   they can already read the EOD entry itself.
3. Confirm the export/handoff step itself (whatever produces the zip)
   isn't dropping files again before relying on any future "verified and
   built" summary at face value — Session 30 re-verified this explicitly
   (fresh extract diffed against the source tree, zero drift) and it held.
4. O3: AI provider decision (NIM vs. Gemini) — unchanged, still open.
5. ~~App-layer verification~~ — done in Session 30: real Postgres,
   real running `apps/api`, full HTTP round-trip through the new EOD/
   files flow, permission-boundary check, `activity_log` check. Actual
   bytes PUT to a live bucket remains unverified (no storage-provider
   domain reachable from this sandbox), and there's still no real
   browser click-through of `apps/web` itself.
6. **NEW — large, not started:** `FUTURE_SCOPE_ADMIN_ANALYTICS.md`
   (repo root) tracks a full Admin/Analytics/Investigation/Observability
   spec — Groups/Companies hierarchy, Super/Group/Company Admin scopes,
   PostHog, AI cost tracking, audit investigation UI, system health.
   None of it exists in this codebase today (today's `organizations`
   table is explicitly "v1 has exactly one row," per its own comment).
   This is its own planning/approval cycle per the spec's own agent
   execution rule (§43) — do not fold into ordinary next-steps items,
   do not start without a Phase 1 architecture-mapping pass and
   sign-off first.

## Session 31 — 2026-08-29 — Per-record file trust (lifted off hold) + Automation Controls (PRD §8.10)

Picked up two of Session 30's next-steps items directly, by explicit
direction: #2 (per-record file trust — previously deliberately on hold)
and the next unbuilt production section (Automation, PRD §8.10/§10 —
nothing under `/api/v1/automation` existed before this session despite
`automation_controls`/`automation_log` having had a schema since 0009).
Did **not** touch #6 (Admin/Analytics) — still gated on its own Phase 1
sign-off, untouched this session.

**Part 1 — Per-record file trust (PRD §13.3 check 4):**
- `apps/api/src/services/fileResourceAuth.ts` (new) — a registry
  dispatching "can this user read/write attachments on this specific
  record" to whatever service already knows how to authorize that
  resource type, rather than re-implementing per-resource logic inside
  files.ts. One entry registered: `eod_logs`, which mirrors eod.ts's own
  rule exactly (own the entry, or hold `eod.read`/`eod.create`). A
  resourceType with no registered authorizer falls through to the flat
  `files.*` grant only — the exact pre-Session-31 behavior, so nothing
  got silently more permissive by adding this file.
- `apps/api/src/services/eodService.ts` — added `getEodLogById`, the one
  new lookup the authorizer needed.
- `apps/api/src/services/fileService.ts` — added `getFileResourceRef`
  (resourceType/resourceId for a file id, needed *before* the route
  knows whether the caller has the flat grant, to decide which
  authorization path applies).
- `apps/api/src/routes/files.ts` — every one of the five endpoints
  (request-upload, confirm, list, download, archive) now checks the flat
  grant first, then the per-record fallback. Stale header comment
  ("deliberately still on hold") removed along with the gap it
  described. `packages/shared/src/index.ts`'s `FileRecord` comment
  updated to match.
- `apps/api/src/routes/files.test.ts` — 7 new tests (owner without a
  flat grant; a teammate with `eod.read` but not ownership — the exact
  Session 30 scenario; that same teammate correctly denied write/archive
  since `eod.read` isn't `eod.create`; a stranger with neither still
  denied; an unregistered resourceType still flat-403s). 23/23 passing.

**Part 2 — Automation Controls (PRD §8.10, toggle-panel half only):**
- `packages/shared/src/index.ts` — `AUTOMATION_CONTROL_KEYS` (the closed
  set of 9 PRD §12 jobs, named individually — §12 calls these "a
  migration checklist, not a design question," so the set is fixed, not
  an open string a PATCH could invent), `AutomationControl`,
  `AutomationLogEntry`.
- `apps/api/src/services/automationService.ts` (new) —
  `listAutomationControls` seeds any of the 9 keys an org doesn't have a
  row for yet (default `enabled=true`, matching the MVP sheet's own
  default) via one `insert ... select ... on conflict do nothing`, not a
  loop; `setAutomationControl` upserts and writes the `automation_log`
  audit row in the same transaction (even a no-op toggle-to-the-same-
  value is logged — PRD §13.10 wants every action recorded, not just the
  ones that changed something); `listAutomationLog` with pagination
  enforcement (PRD §13.4, capped at 200).
- `apps/api/src/routes/automation.ts` (new) — `GET /`, `PATCH /:key`,
  `GET /log`. Flat `automation` resource grant only — a toggle panel has
  no "own record" case, same reasoning eod.ts's own aggregate endpoints
  give for having no `.own` branch.
- `apps/api/src/server.ts` — registered at `/api/v1/automation`.
- `apps/api/src/routes/automation.test.ts` (new) — 9 tests (read vs.
  update grant separation, unknown-key rejection, non-boolean body
  rejection, log pagination validation). 9/9 passing.
- **Deliberately not built:** the other half of §8.10, "cron job health
  view (when each job last ran, last result, next run time)." No job is
  actually wired to a scheduler yet — that's Phase H (PRD §17.1), still
  ahead of this session — so there is no true last-run data to show.
  Faking it would be worse than the panel not existing; this stays
  flagged rather than stubbed with placeholder timestamps.
- No web UI for the toggle panel this session — backend only.

**Verified, same bar as Sessions 27–30:**
- `npm run typecheck/build/lint/test -w apps/api` all clean — same 3
  pre-existing warnings (`network.ts`, `calendarTokenService.ts`), no new
  ones. 45/45 tests passing (16 new: 7 files.ts + 9 automation.ts).
- Real Postgres (installed fresh in this session's sandbox — apt, not
  Docker; `docker-compose.yml`'s own header already documents this as an
  equivalent path, just plain `postgresql-16` via apt this time): all 15
  migrations applied clean on a fresh `nexus` database.
- A throwaway verification script (same non-idempotent, prints-and-exits
  shape as `seedClickthrough.ts`; written, run, then deleted — not left
  behind as a permanent fixture) asserted, against real
  `withOrgContext`/RLS, not mocks: owner can read/write their own
  eod_logs attachment with no flat grant; a teammate with `eod.read` (not
  the owner) can read but not write; a stranger with neither can do
  neither; `listAutomationControls` seeds exactly 9 rows and is
  idempotent on a second call; a toggle writes exactly one audit row with
  correct previous/new values; an unknown key is rejected; a second org
  gets its own independently-seeded 9 controls, unaffected by the first
  org's toggle (tenant isolation).
- Full HTTP round-trip against a live `apps/api` process (dev-login
  roster sessions, real cookies, not `app.inject` mocks): owner GET file
  → 200; teammate-with-`eod.read` GET file → 200; stranger GET file →
  403; teammate DELETE (archive) file → 403 (no `eod.create`); leader GET
  `/automation` → 200 with 9 controls; stranger GET `/automation` → 403;
  teammate-with-`automation.read` GET `/automation` → 200; teammate PATCH
  `/automation/:key` → 403; leader PATCH → 200; leader PATCH an unknown
  key → 400 `unknown_key`; leader GET `/automation/log` → correct
  previous/new values across two toggles. Every result matched
  expectation.
- `pg_policies` and `information_schema.role_table_grants` queried
  directly against the real database: `tenant_isolation` RLS policy and
  the expected `nexus_app` SELECT/INSERT/UPDATE/DELETE grants both
  confirmed present on `files`, `automation_controls`, and
  `automation_log` (all three pre-existing tables, unmodified by this
  session — confirmed rather than assumed).
- No real bucket reachable in this sandbox (same standing caveat as
  Session 29/30 — egress allowlist has no storage-provider domain), so
  the file-upload assertions above exercise the presign/DB/RBAC/audit
  path for real but not an actual bucket PUT/GET.
- No browser click-through — same standing gap every session has
  flagged; still no `apps/web` dev server exercised.

### Next steps
1. Web UI: Automation toggle panel (`apps/web/src/modules`) — no module
   directory exists for Automation yet; this session was API-only.
2. Cron job health view (other half of §8.10) — blocked on Phase H
   (wiring the actual 9 jobs to n8n/a scheduler); don't stub fake
   last-run data before that exists.
3. Per-record file trust: only `eod_logs` has a registered authorizer in
   `fileResourceAuth.ts`. Any other resource type that later grows a
   `FileService` consumer (task attachments, knowledge base attachments,
   etc.) gets flat-grant-only behavior until it's explicitly added to the
   registry — not a bug, but worth flagging each time a new attachable
   resource type shows up so it doesn't get silently skipped.
4. O3: AI provider decision (NIM vs. Gemini) — unchanged, still open.
5. Confirm the export/handoff step isn't dropping files again before
   relying on any future "verified and built" summary at face value —
   same standing instruction Session 30 gave itself; carry it forward.
6. `FUTURE_SCOPE_ADMIN_ANALYTICS.md` — unchanged, still gated on its own
   Phase 1 architecture-mapping pass and sign-off. Not started.

## Session 32 — 2026-08-29 — Automation Toggles web UI (retroactive entry — see note)

**This entry is written after the fact, from a later session, not from
the session that actually did the work.** The handoff zip this repo was
exported from (`nexus29-session32-final.zip`) contains
`apps/web/src/modules/automation/AutomationToggles.tsx`, wired into
`ia.ts` (`built: true`) and `App.tsx`'s router — real, working code, not
a stub — timestamped after Session 31's own SESSION_LOG entry was
written. Session 31's own "Next steps" list said in plain words *"Web
UI: Automation toggle panel — no module directory exists yet; this
session was API-only."* That was true when written; it stopped being
true later in the same work session, and SESSION_LOG was never updated
to say so. Per this project's own standing rule — "deferred scope must
be explicitly flagged, not silently skipped" — an *un*deferred piece of
scope going undocumented is the same failure in the other direction, so
it gets its own entry rather than being folded silently into Session 33.

**What actually shipped (reconstructed from the code, not from a live
session transcript):**
- `apps/web/src/modules/automation/AutomationToggles.tsx` (new) — the
  toggle panel PRD §8.10 calls for. Renders all `AUTOMATION_CONTROL_KEYS`
  jobs (label/schedule/description sourced from a local `JobMeta` map,
  PRD §12's own table — kept presentational, not promoted to
  `@nexus/shared`, per this file's own header comment on why). Toggling
  calls `PATCH /automation/:key`; the panel also renders the audit log
  (`GET /automation/log`) underneath the toggle list.
- `apps/web/src/services/automationService.ts` (new) — thin wrapper
  around the three Session 31 endpoints, same unwrap convention as
  `aiSettingsService.ts`/`networkService.ts` (server envelopes in
  `{controls}`/`{entries}`, unwrapped here so callers get the array
  directly).
- `apps/web/src/app/ia.ts` / `App.tsx` — Automation → Automation Toggles
  flipped to `built: true` and routed. Schedule Status stays `built:
  false`, correctly — that half is still blocked on Phase H, same
  reasoning `automationService.ts` (API) gives for not stubbing fake
  last-run data.
- Permission handling follows the pattern `Leave.tsx` already set for
  non-approvers: no client-side role gate before rendering the toggle
  switches themselves; a caller without `automation.update` gets a real
  403 from the PATCH and the toggle visually reverts. `ErrorState`
  covers a 403 on the initial `GET /` for a caller without even
  `automation.read`.

**Caught and fixed this session (not part of the retroactive UI work
itself):** `npm run typecheck -w apps/web` was failing on this file — a
bogus `truncate: 1` inline-style property (not a real CSS property; the
intended effect needs `overflow`/`textOverflow`/`whiteSpace` together)
on the audit-log control-key label. This means the file, despite being
real working code wired into the router, had never actually been run
through `npm run typecheck` before landing in the handoff zip — the
same class of gap Session 30 flagged about "verified and built" claims
needing to actually be checked, not asserted. Fixed to the correct
three-property ellipsis pattern; `npm run typecheck -w apps/web` is
clean as of this session.

**Verification status:** typecheck now clean (fix above); no dedicated
component test exists for `AutomationToggles.tsx` and none was added
here — this entry's job is closing the documentation gap and the one
concrete bug it hid, not doing a full first-time QA pass on work this
session didn't originate. Flagged as a real gap below, not silently
carried forward.

### Next steps
1. `AutomationToggles.tsx` has no test coverage (unlike every backend
   route from Session 31 it calls). Worth a component test pass
   whenever web-side testing conventions get established more broadly —
   `apps/web` currently only has one test file total (`Button.test.tsx`).
2. Whatever produces the handoff zip export should be checked to
   confirm it isn't silently including uncommitted/unlogged work again —
   this is the second time a "final" export has contained something
   SESSION_LOG didn't know about (see Session 30's own note about the
   export/handoff step). Worth resolving at the source, not just
   re-catching it here each time.
3. Everything else carried forward from Session 31 unchanged (cron job
   health view blocked on Phase H, O3 still open, Admin/Analytics still
   gated on its own sign-off).

## Session 33/34 — 2026-08-30 — Chat: real-time (SSE) + WhatsApp-style history

Per the locked session-plan decisions: SSE over WebSocket (unidirectional
is all chat needs; clients still write via the existing `POST /chat`),
and S33+S34 merged into one session since the SSE endpoint is ~40 lines
of Fastify and the history work is entirely inside `Chat.tsx` — same
file, same session, per the plan's own merge rationale.

**Backend — SSE fan-out (S33):**
- `apps/api/src/services/sseHub.ts` (new) — `Map<orgId, Set<ServerResponse>>`,
  single-process, in-memory. `subscribeToChatStream` registers a
  connection and returns an unsubscribe closure; `broadcastChatMessage`
  writes one SSE frame to every live connection for an org, swallowing
  a single write failure rather than letting one dead/slow subscriber
  block delivery to the rest (that connection's own `close` handler,
  not this catch, is what actually removes it from the set). Scale note
  carried directly from the plan: this map is single-process only —
  swap `broadcast`'s body to Redis pub/sub when a second API process
  exists; the public subscribe/unsubscribe/broadcast shape doesn't need
  to change, so the swap never touches `routes/chat.ts`.
- `apps/api/src/routes/chat.ts` — `GET /stream`: same `requireAuth` +
  `hasPermission(user, 'chat', 'read')` gate as every other chat route,
  then `reply.hijack()` + raw `ServerResponse.writeHead` for the SSE
  headers (`text/event-stream`, `no-cache, no-transform`,
  `X-Accel-Buffering: no` for reverse-proxy compatibility). A 25s
  heartbeat comment line keeps the connection alive across proxy idle
  timeouts; `req.raw`'s `close` event is what actually unregisters the
  connection — the only reliable "client went away" signal Node's http
  module gives.
- `apps/api/src/services/chatService.ts` — `insertMessage` now broadcasts
  after `withOrgContext`'s `COMMIT` has actually returned, not from
  inside the still-open transaction — a subscriber must never be able to
  observe (or re-query) a row that isn't durably committed yet. Wired
  into `insertMessage` itself (not `sendChatMessage`) so both the user's
  message and the AI's reply broadcast identically, and no future
  `insertMessage` caller can accidentally skip it.
- Auth: cookie-based, same `nexus_session` httpOnly cookie as every
  other route — browsers attach cookies to `EventSource` requests
  automatically with `withCredentials: true`, so no separate
  token-in-URL scheme was needed (which would have reopened PRD §13.2's
  "never in URL query strings" rule for exactly this one endpoint).

**Backend — WhatsApp-style history (S34):**
- `apps/api/src/services/chatService.ts` — `listChatMessagesPage(orgId,
  {before, limit})`. Cursor is a message **id**, not a raw timestamp:
  `created_at` has no uniqueness guarantee (two messages can land in the
  same millisecond), so a raw `created_at < :ts` cursor can skip or
  duplicate a row at a same-millisecond page boundary. Cursoring on id
  (via a subquery back to that row's own `created_at`) avoids the class
  of bug entirely. Fetches `limit + 1` to answer "is there more?"
  without a second `COUNT(*)` round trip. `limit` clamped to [1, 200] —
  PRD §13.4 pagination enforcement, same cap `automationService.ts`'s
  `listAutomationLog` already uses, kept consistent rather than
  inventing a second magic number.
- No history cap for new members: the query has no date filter anywhere
  — RLS already scopes every row to `org_id`, so a member who joins
  today can page all the way back to message one, per the plan's own
  "new members get full history from day 1" decision.
- `exportChatThread(orgId)` — full thread, no `HISTORY_LIMIT`/page cap
  (export exists specifically so a leader gets *everything*), plain
  text, oldest-first, names resolved via a `left join users` rather than
  bare `user_id`s — the one caller in the chat path that actually needs
  a human-readable name, kept local rather than promoting a shared
  "resolve user names" helper for a single consumer.
- `apps/api/src/routes/chat.ts` — `GET /chat` now takes `before`/`limit`
  query params and returns `{messages, hasMore}` (new shared type
  `ChatMessagePage`) instead of a flat array — a breaking response-shape
  change, but this endpoint has exactly one consumer
  (`apps/web/src/services/chatService.ts`), updated in the same session.
  `GET /chat/export` — plain-text download,
  `Content-Disposition: attachment`, gated on `hasPermission(user,
  'chat', 'export')`. `'export'` was already a member of
  `rbac.ts`'s `PermissionAction` union (defined, never previously used)
  — reused rather than adding a new action type. Leaders get this for
  free via `rbac.ts`'s existing role bypass (`role === 'leader'`
  short-circuits the permissions-table lookup entirely); any other role
  needs an explicit `chat`+`export` grant, which delivers the plan's
  "leaders only" intent without hardcoding a role check anywhere in the
  route — every other resource in this codebase deliberately avoids
  that pattern in favor of `hasPermission`.

**Frontend:**
- `apps/web/src/services/chatService.ts` — `fetchChatMessages({before,
  limit})` returns `ChatMessagePage`; `connectChatStream(onMessage)`
  wraps `EventSource` with `withCredentials: true`, returns a cleanup
  function; `downloadChatExport()` is a plain `window.open()` navigation
  rather than a `fetch()` — the response is already
  `Content-Disposition: attachment`, so the browser handles the save
  dialog itself and cookies travel with a normal cross-origin
  navigation with no extra `credentials` plumbing needed.
- `apps/web/src/modules/ai-analyst/Chat.tsx` — rewritten:
  - SSE subscription via `connectChatStream`; incoming messages are
    de-duped by id against the sender's own optimistic append from
    `POST /chat`'s response (every *other* tab/session sees a message
    for the first time via SSE; the sender's own tab already has it).
  - "Load earlier" button, shown when `hasMore` is true. Scroll position
    across a prepend is preserved via a `useLayoutEffect` keyed off a
    `scrollIntentRef` ('bottom' vs. 'preserve') set right before each
    state update — distinguishing "a new message arrived, scroll down"
    from "older messages were just prepended, hold position" was the
    actual problem here, since both mutate the same `messages` state and
    would otherwise trigger identical auto-scroll behavior. The
    correction runs pre-paint (`useLayoutEffect`, not `useEffect`) so
    there's no visible scroll-jump flash.
  - WhatsApp-style date separators ("Today" / "Yesterday" / formatted
    date), computed inline per adjacent-message-pair, not stored — no
    schema change needed, this is pure render-time grouping.
  - Export button, gated on `user.role === 'leader'` client-side. This
    is a convenience gate, not the real authorization boundary (the API
    route's `hasPermission` check is) — chosen because `rbac.ts`'s own
    role bypass means "is this user a leader" is a reliable enough
    signal without an extra round trip to check for an explicit
    `chat.export` grant a non-leader might hold. A non-leader who's been
    given that grant won't see the button; flagged below as a real, if
    minor, gap rather than left silent.
- `packages/shared/src/index.ts` — added `ChatMessagePage`.

**Verified, same bar as Sessions 27–32:**
- `npm run typecheck/build/lint/test` clean across both workspaces (root
  `npm run build`, `apps/api`/`apps/web` individually). API: same 3
  pre-existing lint warnings (`network.ts` ×2, `calendarTokenService.ts`)
  as every prior session, no new ones. Web: same 3 pre-existing warnings
  (`Toast.tsx`, `CrudSection.tsx`, `TaskSection.tsx`), no new ones.
- `apps/api` test suite: 60/60 passing (15 new — 10 in the new
  `routes/chat.test.ts`, 5 in the new `services/sseHub.test.ts`).
  `chat.test.ts` follows the established mock-everything-below-the-route
  strategy (`files.test.ts`/`automation.test.ts`); `GET /stream` is only
  exercised for its pre-hijack 403 path there — a live, never-ending SSE
  connection isn't something `app.inject` can cleanly assert against, so
  the actual fan-out logic is unit-tested directly in `sseHub.test.ts`
  against fake `ServerResponse`-shaped objects instead (delivery within
  an org, no cross-org delivery, unsubscribe stops delivery and cleans
  up an emptied org's map entry, a broadcast to zero subscribers is a
  no-op, one subscriber's `write()` throwing doesn't block delivery to
  the rest).
- Real Postgres (installed fresh in this session's sandbox — apt,
  `postgresql-16`, same equivalent path `docker-compose.yml`'s own
  header documents): all 15 migrations applied clean on a fresh `nexus`
  database. Seeded two orgs, a leader + team member in org-1, a leader
  in org-2, and an explicit `chat.read`/`chat.create` grant for the
  team member (verifying the non-leader path, not just the leader
  role-bypass path).
- Full HTTP round-trip against a live `apps/api` process (dev-login
  roster sessions, real cookies, not `app.inject` mocks): leader sends
  3 messages, each getting a real AI-stub reply (no AI connection
  configured — the existing zero-config fallback path, not mocked for
  this test); a real `curl -N` SSE client subscribed as the team member
  received both the user message and the AI reply, correctly framed
  (`event: message` + JSON `data:`), the instant the leader posted them
  — confirming the fan-out works over an actual open HTTP connection,
  not just in the unit-level `sseHub.test.ts` mocks; a second SSE
  subscriber in org-2 received nothing when org-1 posted (tenant
  isolation on the stream itself, not just on `GET /chat`); cursor
  pagination (`?limit=3` then `?before=<oldest id>&limit=3`) returned
  the correct next-older page with no gap or duplicate at the boundary;
  `GET /chat/export` returned a correctly-headered
  (`Content-Disposition: attachment`) plain-text file with real names
  resolved via the `users` join, a non-leader without the grant got a
  real 403, and org-2's leader got `(no messages yet)` rather than
  org-1's thread.
- `pg_policies` and `information_schema.role_table_grants` queried
  directly against the real database: `tenant_isolation` RLS policy and
  the expected `nexus_app` SELECT/INSERT/UPDATE/DELETE grants both
  confirmed present on `chat_messages` (pre-existing table, unmodified
  by this session — confirmed rather than assumed, same posture Session
  31 took for `files`/`automation_controls`/`automation_log`).
- Test database, roles, and the running API process were torn down
  after verification (`DROP DATABASE`, killed the `tsx` process, removed
  the session's `.env` and cookie-jar scratch files) — nothing from this
  sandbox pass was left behind.
- No browser click-through — same standing gap every session has
  flagged; the SSE reconnect behavior, the `useLayoutEffect` scroll
  restoration, and the date-separator rendering were all validated by
  code inspection + `EventSource`'s documented reconnect contract, not
  an actual browser session against `apps/web`'s dev server.

### Next steps
1. Web click-through remains the standing gap across every session — SSE
   reconnect-after-drop, the scroll-preservation effect on Load Earlier,
   and date-separator boundaries have none of them been eyeballed in an
   actual browser.
2. The export button's client-side gate (`user.role === 'leader'`) won't
   show for a non-leader holding an explicit `chat.export` grant, even
   though the API would honor it. Minor, but a real gap — worth a
   `CurrentUser`-level permissions surface at some point rather than
   role-name gating scattered per-component (this file, `Leave.tsx`,
   `AutomationToggles.tsx` all do their own version of this today).
3. Session 35 next: task drawer + task-scoped threads + the AI Analyst
   Chat "My Tasks"/task-picker tabs. Per the plan's own note, this
   session also needs to confirm whether `supporting`/`supervisor` are
   real columns on `tasks` yet — a quick check against the live schema
   during this session's own real-Postgres pass confirms `tasks` already
   has `support_user_id` and `supervisor_user_id` columns (visible in
   this session's own `\d users` foreign-key listing), so the migration
   the plan flagged as possibly-needed for S35 turns out not to be —
   worth confirming that's still current at the start of S35 rather than
   assuming it from this note alone.
4. Whatever produces the handoff zip export — flagged again per Session
   32's note above — should be checked before relying on the next one.

### Next steps (append to Session 33/34's / Session 35's own "Next steps")

7. **NEW — Admin/Org Hierarchy/Guests/Projects build is now locked and
   ready to start.** Phase 1 planning (architecture inspection against
   this repo, called for in `FUTURE_SCOPE_ADMIN_ANALYTICS.md`'s own
   "do not start without a Phase 1 pass" rule) is done — see
   `ADMIN_BUILD_GUIDE.md` (repo root). Key finding: the org hierarchy this
   plan needs (`org_type`/`parent_org_id`/`org_memberships`) already exists
   from migration `0006_org_hierarchy_memberships.sql` — built for an
   unrelated reason, but sufficient foundation. Everything else (Super
   Admin, Group/Company Admin UI, guests, projects, AI usage tracking,
   audit log, PostHog) is confirmed not built.
   `FUTURE_SCOPE_ADMIN_ANALYTICS.md` is updated to point here rather than
   its own superseded original spec.

   The guide's own "Session 1" through "Session 9" are this repo's
   **Session 36 through Session 44** (log numbering continues from
   Session 35; the guide's internal numbering is relative to itself,
   not this file — don't let the two collide when logging each one).

   Locked decisions worth restating here so they aren't re-litigated
   mid-build: Company Admin = existing `leader` role, no new role; Group
   Admin = `leader` + read-scoped access to child companies (single
   highest-risk new authorization rule in the build — isolation tests for
   it must pass before Sessions 36+5/+6 build any dashboard on top of it);
   Super Admin = new `platform_admins(user_id)` table, checked ahead of
   the org-scoped chain, not an org row; cross-org reads are always
   N separately-scoped queries merged at the API layer, never a widened
   RLS policy (extends `DECISIONS.md` §5, doesn't override it); guests get
   the full project-container model via `project_memberships`, not
   per-record assignment.

   Sequencing: Session 36 (auth foundation + org/guest mgmt, merged) →
   37 (projects) → 38 (AI provider interface + usage tracking, merged) →
   39 (Super Admin backend, audit/health/analytics folded in) → 40 (Super
   Admin UI) → 41 (Group Admin + Company Admin, merged) → 42 (AI chat
   cross-referencing) → 43 (company docs/archive) → 44 (testing/hardening/
   final report — sign-off gate before Phase 2). Phase 2 (billing/plan
   enforcement, impersonation, advanced analytics) stays explicitly out of
   scope until Session 44 signs off.

## Session 37 — 2026-08-30 — Admin/Org/Guest foundation (ADMIN_BUILD_GUIDE.md §1), corrected numbering

**Numbering correction, stated plainly so it isn't re-litigated:** Session
33/34's own appended note said the admin/org/guest/projects build would
run as Sessions 36 through 44, with 36 = auth foundation + org/guest
management and 37 = Projects. What Session 36 actually shipped, checked
against the live repo rather than assumed from that note, was narrower:
`PermissionAction` moved to `@nexus/shared`, `PERMISSION_RESOURCE_ACTIONS`
added, and `permissionService.ts`/`TeamRoles.tsx`'s grant-revoke UI —
none of `ADMIN_BUILD_GUIDE.md §1`'s actual scope (`platform_admins`,
`guest` role, `organizationService.ts`, `audit_log`, the group-read rule)
existed yet. Since Projects (guide's Session 2) depends on that
foundation, this session is the guide's **Session 1**, not Session 2 —
repo numbering continues at 37 regardless. Projects becomes Session 38.

### What shipped
- `0016_admin_foundation.sql`: `platform_admins(user_id)` (global, not
  org-scoped, RLS deliberately not applied — see file header);
  `organizations.plan`/`active` (hook only, no billing enforcement);
  `org_memberships.role` check constraint widened to include `guest`;
  `users.password_hash` (nullable, guest-login only — every OAuth user
  stays null, PRD §13.2's OAuth-only decision for leader/team_member/
  intern is unchanged); new `audit_log` table, schema only per the
  guide (write side is a later session), append-only grants (select+
  insert, no update/delete, per PRD §13.10).
- **The one new authorization rule** (guide's own "highest-risk" flag):
  `organizations`' RLS policy widened from "see your own org or your
  parent group" to also "see your direct children" — a group can now
  list companies where `parent_org_id = <the group>`. Scoped to the
  `organizations` directory row only (name/plan/active), not business
  data; DECISIONS.md §5's N-separately-scoped-queries doctrine for
  actual tenant data (tasks/goals/etc.) is unchanged and is what
  `withAuthorizedOrgContext` below is built to preserve.
- `authorizationService.ts` (new): consolidates `hasPermission` (moved
  as-is from `rbac.ts`) + two new checks — `isPlatformAdmin` (raw-pool,
  same exemption class as `sessions`/DECISIONS.md #4) and `canReadOrg`
  (the group-read rule: own org, or platform admin, or leader-of-a-group
  reading a direct child company — read-only, confirmed by its own
  doc comment not to imply write access). `withAuthorizedOrgContext`
  wraps `canReadOrg` + `withOrgContext` in one call so future cross-org
  reads (group dashboards, Super Admin drill-downs) share one gate
  rather than each re-deriving it — still one org per call, callers loop
  and merge themselves for a cross-org view, per DECISIONS.md §5.
  `rbac.ts` is now a two-line re-export, kept rather than deleted so
  none of the ~15 existing route files importing from it needed
  touching this session.
- `organizationService.ts` (new): create/edit/deactivate group & company,
  assign/remove company↔group (including → independent), plan changes.
  Every write here is platform-admin gated except a same-org leader
  editing their own org's name — `group_read` scope from `canReadOrg`
  is explicitly read-only and does not authorize any write in this file.
  `listCompaniesInGroup` is the read side of the new rule, run through
  `withOrgContext` (not the raw pool) specifically so it's exercised
  against — and protected by — the real RLS policy, not just trusted
  application logic.
- `guestService.ts` (new): guest credential generation + login
  verification. Password hashing is Node's built-in `scrypt` (already
  used elsewhere in this codebase for token hashing — see
  `sessionService.ts`) with a per-password random salt, not a new
  bcrypt/argon2 dependency for one code path. `createGuestCredential`
  returns the temp password exactly once, at creation; nothing
  retrievable after that point.
- `routes/guests.ts` (new, leader-gated by a direct `role === 'leader'`
  check — same posture `TeamRoles.tsx`'s own `canManage` already takes
  client-side, not a `permissions` table grant) + `POST /auth/guest-login`
  added to `routes/auth.ts` — the one deliberate exception to "OAuth is
  the only login path" (PRD §13.2), scoped narrowly to `guest` accounts.
  Both registered in `server.ts`.
- `routes/admin/` and `modules/admin/` — empty shells per the guide,
  each with a README pointing at which later session fills them in
  (`superAdmin.ts` → Session 39/40 per the guide's numbering; Group/
  Company Admin routes → Session 41). Nothing here is registered in
  `server.ts` yet, on purpose.
- `@nexus/shared`: `Role` gains `'guest'`; new `INVITABLE_ROLES` (the
  three roles the existing invite flow actually offers — guest is
  deliberately excluded, provisioned via `guestService.ts` instead);
  new `OrgType`, `Organization`, `PlatformAdmin` types.
- **Fallout from widening `Role`, caught by `tsc`, not by inspection:**
  three `Record<Role, ...>` / `Record<Person['role'], ...>` label maps
  in `apps/web` (`people/Overview.tsx`, `people/TeamMembers.tsx`,
  `settings/TeamRoles.tsx`) failed to compile once `Role` had a fourth
  member. Each got a `guest` entry with a short note that guests aren't
  expected to actually populate these screens yet — they're satisfying
  the type, not adding real guest-management UI (that's Session 41).

### Verification
- `authorizationService.test.ts` (new, 15 tests, db.js mocked — this is
  authorization logic under test, not an RLS integration test): the
  guide's four named isolation scenarios all pass — group A blocked
  from group B, group A blocked from an independent company, group A
  blocked from a sibling company under a different group, company admin
  (leader of a company, not a group) blocked cross-company entirely.
  Plus: platform admin bypasses everything; a non-leader role never
  gets group-read scope even inside a group org; `hasPermission`'s
  guest case confirms the "most restrictive default" — no grant, no
  access, but an explicit grant is still honored (restriction is "no
  default," not "no path"); `withAuthorizedOrgContext` throws
  `OrgAccessDeniedError` and never touches `withOrgContext` when access
  is denied.
- Full `apps/api` suite run: 97 passed, 1 failed
  (`chat.test.ts`'s SSE-stream-open test, a 5s timeout on a long-lived
  connection — unrelated to this session, nothing here touches
  `chat.ts`/`sseHub.ts`; flagged rather than silently ignored).
- `tsc --noEmit` clean on `packages/shared`, `apps/api`, and `apps/web`.

### Gap — not closed this session
The fifth isolation scenario the guide names ("Guest sees only their
project(s), nothing else") can't be tested yet — `project_memberships`
doesn't exist until Projects (Session 38). What's verified here instead
is the precondition that scenario depends on: a guest has zero default
permissions, so until project-scoped visibility is wired, a guest can
authenticate but reach nothing. Re-run/extend this specific isolation
test once Session 38 lands `project_memberships`, per the guide's own
sequencing note ("Session 2 has no dependency on 3–6, sequenced second
because guest onboarding is more useful once guests have something to
be scoped to").

Also not built this session, deliberately (guide scopes these to later
sessions, restated here so they aren't assumed done): any HTTP route
for `organizationService.ts`'s CRUD (Session 39/40's `superAdmin.ts`),
the guest-invite UI surface (Session 41), `auditLogService.ts`'s write
side (Session 39/40 — this session is schema only), and the real RLS
verification-against-live-Postgres pass every prior schema-touching
session has done manually (Sessions 21/27 precedent) — flagged the same
way this file has flagged that gap before, not silently skipped.

### Next steps
1. Session 38: Projects & `project_memberships` (guide's Session 2) —
   now actually unblocked. `ProjectWithTasks` mirrors `GoalWithProgress`
   exactly (goalService.ts is the reference implementation); list view
   with inline expand + `ProjectDetail` drill-in mirrors `ActiveGoals`/
   `GoalDetail`'s actual route pattern; guest visibility wires to
   `project_memberships` using this session's `guest` role.
2. Run this session's migration against a real Postgres instance and
   confirm the widened `organizations` RLS policy behaves as designed
   (group sees children, children still see parent, unrelated orgs see
   neither) — the standing verification gap noted above.
3. `chat.test.ts`'s SSE-stream timeout (flagged above) is worth a look
   independent of this session — possibly the same "no browser
   click-through" class of gap Session 33/34 already flagged, now
   showing up as a flaky/hanging test in CI rather than just an
   untested code path.

### Backlog — added 2026-08-30, not yet scheduled

- **UI rehaul.** Flagged for a future session, not sized yet. Every
  admin/org/guest/project frontend built from Session 38 onward has been
  going in matching the *existing* component vocabulary (Card/Badge/
  Table/etc. from Tier 1, same page-shell pattern as Goals/Work) purely
  to keep this build unblocked — that is a deliberate "match what's
  there," not a design decision that the current look is where NEXUS
  should land. Needs its own session once the functional surface (this
  admin/org/guest/project build, Sessions 37–45) is far enough along to
  redesign against a stable feature set rather than a moving one.

## Session 38 — 2026-08-30 — Projects & project memberships (ADMIN_BUILD_GUIDE.md §2)

Unblocked by Session 37. "The Goals precedent, applied a third time"
(guide §2) — this file mirrors `goalService.ts`'s actual structure, not
just its output shape, on the theory that a future reader who already
knows one pattern should recognize the other immediately rather than
re-derive it.

### What shipped
- `0017_projects.sql`: `projects` (owning `org_id`, same active/archived
  status shape as `goals`); `project_memberships` — the cross-org access
  grant `DECISIONS.md` §5 sketched and explicitly deferred out of 0006
  ("a `projects` table... plus its own `project_memberships` allowing a
  `user_id`/`org_id` pair from a *different* org"); `tasks.project_id`
  alongside the existing `goal_id`, same nullable/non-exclusive shape.
  RLS on both new tables is the plain `org_id = current_org` policy
  every other table gets — **no widening**, unlike Session 37's
  `organizations` policy. Cross-org project reads go through an
  authorized-context pattern in `projectService.ts`, not a loosened
  policy on a business table — DECISIONS.md §5's doctrine on that point
  holds even for this new cross-org case.
- `@nexus/shared`: `Project`, `ProjectWithTasks` (mirrors
  `GoalWithProgress` exactly, per the guide — no completion percent
  though, since a project isn't framed around driving to 100% the way a
  goal is), `ProjectMember`; `Task.projectId` / `TaskListQuery.projectId`;
  `projects` added to `PERMISSION_RESOURCE_ACTIONS`.
- `taskService.ts`: `project_id` wired through row mapping, list
  filtering, create, and update — every place `goalId` already appears,
  `projectId` now does too, same shape.
- `projectService.ts` (new): two read paths, not one.
  - `getProjectWithTasks`/`listProjectsWithTasks` — normal same-org
    path, gated by the caller's own `projects` permission at the route.
  - `getProjectForMember`/`listProjectsForMember` — the
    `project_memberships` path. Authorizes against that table on the
    raw pool first (same "check outside RLS, then read inside a
    correctly-scoped `withOrgContext`" shape
    `authorizationService.withAuthorizedOrgContext` already established
    in Session 37), then reads the rest of the project's data using the
    **project's own `org_id`**, not the caller's session org — this is
    what makes a genuinely cross-org collaborator's read work at all,
    not just a same-org guest's.
- **A real bug caught mid-session, not just a design note:** `users`'
  RLS policy (0006) only shows a user row to someone who shares an
  `org_memberships` row in the *current* org. A cross-org collaborator
  — added to a project via `project_memberships` alone, exactly the
  case DECISIONS.md §5 sketched, with no membership in the project's
  owning org — would have silently resolved to zero rows for their own
  member-list entry under that policy, not an error, just a name that
  quietly never renders. Fixed by resolving member identity (name/email)
  via the raw pool for the specific, already-membership-verified set of
  user ids, mirroring `authorizationService.canReadOrg`'s own "checked
  outside RLS on purpose" pattern — this is not a general `users` query,
  it's scoped to ids `project_memberships` already told us are
  legitimate. Documented inline in `projectService.ts` rather than
  fixed silently, since it's the kind of gap that's easy to reintroduce
  if a future edit moves that query back onto `client`.
- `routes/projects.ts` (new, mirrors `goals.ts`): list/detail routes try
  the flat `hasPermission` check first, and fall back to the
  `project_memberships` path when it's false — rather than 403ing —
  so a guest reaches their project(s) through the real HTTP route, not
  only through calling `projectService` directly. 404, not 403, for a
  membership-less caller hitting a real project id — same
  don't-confirm-existence posture the rest of this codebase's
  auth-adjacent responses already take.
- Frontend: `services/projectService.ts` (API client), `ProjectsList.tsx`
  (list with inline expand — the list payload already carries each
  project's tasks, so the row expands with no second fetch; guide §2's
  "trimmed inline task summary"), `ProjectDetail.tsx` (full drill-in,
  mirrors `GoalDetail.tsx`'s route pattern, plus membership add/remove
  UI gated the same `role === 'leader'` way `TeamRoles.tsx`'s own
  `canManage` already is). Wired into `ia.ts` (Work section's "Projects"
  subsection, previously the one deliberate PRD §7.2 omission — the
  guide's whole premise is revisiting that "future — not in MVP, not in
  v1" call) and `App.tsx`. **Not leader-gated at the route level** —
  `/work/projects` and `/work/projects/:id` are reachable by anyone,
  same as the rest of Work; what a guest actually sees there is entirely
  determined by `routes/projects.ts`'s server-side fallback, matching
  guide §2's "Guest visibility is this same view, scoped" — the
  component doesn't render differently for a guest, the data it
  receives already is scoped.

### Verification
- `projectService.test.ts` (new, 5 tests, `db.js` mocked): confirms
  `getProjectForMember` returns `null` — not an error, and without ever
  opening an org context — for a membership-less caller; confirms it
  reads using the **project's** `org_id`, not any org id the caller
  might supply; confirms an orphaned membership (row exists, project
  doesn't) still returns `null` cleanly; confirms
  `listProjectsForMember` groups by owning org and runs one
  `withOrgContext` per distinct org, not per project.
- `routes/projects.test.ts` (new, 10 tests, same mocking strategy as
  `permissions.test.ts`): this is what actually closes the isolation
  gap Session 37's own log entry flagged by name — "Guest sees only
  their project(s), nothing else" is now a real, passing test. Confirms
  a caller with a blanket grant gets the full org list; a caller with
  no grant but a real membership row gets exactly their project(s) via
  the fallback; a caller with neither gets an empty list, not an error;
  a guest reaches their own project's detail; **a guest hitting a
  *different*, real project id gets 404, not 403** (proving the
  fallback doesn't leak existence); an outsider with no grant and no
  membership anywhere gets 404 on the guest's own project too.
- Full `apps/api` suite: 112 passed, 1 failed — the same pre-existing,
  unrelated `chat.test.ts` SSE-stream-open timeout flagged in Session
  37's entry (still un-investigated, still not touched by anything in
  this session).
- `tsc --noEmit` clean on `packages/shared`, `apps/api`, and `apps/web`;
  `vite build` succeeds for the web app.

### Gap this session closes, and what's still open
Session 37's fifth isolation scenario ("Guest sees only their
project(s)") is now genuinely tested, per above — that gap is closed.

Still not built, deliberately out of scope for this session: a
dedicated "create task in this project" UI action (the field is wired
end-to-end — `taskService`, the shared type, the DB column — but
`ProjectDetail.tsx` doesn't yet expose an "Add task" control; the
existing task drawer/creation flow elsewhere in Work already supports
setting a `projectId`, just not from this page yet); and the standing
gap from Session 37 (running 0016/0017 against real Postgres for a live
RLS verification pass) is unchanged and still open.

### Next steps
Session 39: AI provider interface + usage tracking (merged) — no
dependency on this session, genuinely parallel-safe per the guide's own
dependency notes.

## Session 39 — 2026-08-30 — AI provider interface + usage tracking (ADMIN_BUILD_GUIDE.md §3)

### What changed
Two-half change, done in the guide's own required order — interface
change first, verified against every caller, before the usage-tracking
table/service existed at all:

- **`AIProvider.complete()` return shape** (`integrations/aiProvider.ts`):
  now returns `AICompletionResult` (`text`, optional `promptTokens` /
  `completionTokens` / `totalTokens`, required `latencyMs`) instead of a
  raw string. `StubAIProvider` reports real near-zero latency and no
  token counts (nothing to report on); `OpenAICompatibleProvider` times
  the fetch and parses the OpenAI-compatible `usage` object when the
  provider returns one, trusting it as-is rather than estimating.
- **`aiSettingsService.resolveProviderForOrg`** now returns
  `{ provider, model }` instead of just the provider — `model` is
  needed for usage attribution, including the literal `'stub'` when an
  org hasn't configured Settings > Integrations yet, so a stub-served
  call is still counted as a real feature-usage event at zero
  cost/tokens rather than silently unlogged. `testAiConnection`'s direct
  `.complete()` call site updated for the new shape; deliberately still
  not logged to `ai_usage` (a connectivity check, not a feature call —
  no `actor_user_id`/`feature` to attribute it under).
- **`0018_ai_usage.sql`** (new) — mirrors `audit_log`'s shape/doctrine:
  append-only, plain `tenant_isolation` RLS (no `audit_log`-style
  nullable-org_id carve-out, since every AI call here is always
  org-scoped). `actor_user_id` is nullable for a future
  automation-triggered call (none exist today); `feature` is which
  product surface called in (`goal_decomposition` / `chat` / `report` /
  `agent_handoff`); `provider_target` is which Settings > Integrations
  slot actually served it (`chat` / `report`) — these diverge for
  `goal_decomposition` and `agent_handoff`, which both resolve the
  `'chat'` target today.
- **`packages/shared`**: `AiUsageFeature`, `AiUsageRecord`,
  `AiUsageSummary` types added.
- **`aiUsageService.ts`** (new) — `recordAiUsage` / `recordAiUsageSafely`
  (the latter never throws: a usage-logging failure must not turn a
  successful AI feature call into a user-facing error) plus read-side
  `listOrgUsage` / `getOrgUsageSummary`, computed on read, for the
  Session 4/40 "AI & Costs" dashboard to call — nothing calls the
  read side yet, same "schema/service now, route later" split
  `0016_admin_foundation.sql`'s `audit_log` already took.
- **`aiService.ts`** rewritten around a shared `completeAndRecord`
  helper — all four `DefaultAIService` methods (`decomposeGoal`,
  `chatReply`, `generateReport`, `agentHandoffFallback`) now resolve
  provider+model, call it, and log usage via `recordAiUsageSafely` on
  both the success and failure path (a failed completion is still
  counted — feature-usage and cost tracking both care that an attempt
  was made, not just that it worked).
- Every real call site updated to pass `actorUserId` through:
  `routes/goals.ts` (both `resolveProposedTasks` call sites —
  create and regenerate), `chatService.ts`'s `sendChatMessage`,
  `aiReportService.ts`'s `generateAiReport` + `routes/aiReports.ts`,
  `agentHandoffService.ts`'s `createAgentHandoff`.

### Verification
- `tsc --noEmit` clean on `packages/shared`, `apps/api`, and `apps/web`.
- `eslint` clean (0 errors) on both `apps/api` and `apps/web`; the two
  pre-existing warnings in `routes/network.ts` and
  `calendarTokenService.ts` are unrelated and untouched by this session.
- **`aiService.test.ts`** (new, 6 tests, `aiSettingsService.js` and
  `aiUsageService.js` mocked): confirms each of the four methods
  resolves the correct provider target (`chat` for
  `goal_decomposition`/`chat`/`agent_handoff`, `report` for
  `generateReport`) and logs exactly one `ai_usage` row via
  `recordAiUsageSafely` per call; confirms the failure path logs
  `success: false` with the provider's error message and no
  token counts, and still rethrows to the caller; confirms a
  malformed-but-successfully-returned decomposition response still logs
  `success: true` (the provider call itself succeeded — parsing failed
  afterward, which is a separate concern from usage logging).
- Full `apps/api` suite: 118 passed, 1 failed — the same pre-existing,
  unrelated `chat.test.ts` SSE-stream-open timeout flagged in Sessions
  37 and 38's own log entries (confirmed again this session by running
  it against the unmodified Session 38 baseline in isolation — it fails
  there too, so nothing in this session's changes caused or worsened
  it; still un-investigated, still not touched).

### Not yet done
- **`aiUsageService.test.ts`**: not written this session — the guide's
  own required ordering put the `aiService.ts` usage-logging tests
  first (they're what actually exercise `completeAndRecord`), and
  session budget ran out before `aiUsageService.ts`'s own
  `recordAiUsage`/`getOrgUsageSummary` got direct unit coverage. Real
  gap, carried to next session, not quietly skipped.
- Lint/typecheck/test suite had not been re-run since the interface and
  service changes landed, prior to this reconciliation pass — done now
  (see Verification above).
- No route or UI surface for `ai_usage` yet — correctly out of scope
  per the guide; that's Session 4/40's Super Admin backend/dashboard
  (`getOrgUsageSummary` exists for that future caller, not because
  anything calls it today).
- Repackaging/delivering the zip had not happened before this session's
  reconciliation pass.

### Next steps
Session 4/40: Super Admin backend + "AI & Costs" dashboard route,
consuming `aiUsageService.listOrgUsage`/`getOrgUsageSummary` for the
first time, per `FUTURE_SCOPE_ADMIN_ANALYTICS.md`'s own planning/
approval-pass requirement. Also carries forward: `aiUsageService.test.ts`
(see Not yet done above), and the standing open items from prior
sessions (browser click-through of `apps/web`, NIM vs. Gemini provider
decision, per-record trust for files — still on hold).

## Session 40 — 2026-08-30 — Super Admin backend (ADMIN_BUILD_GUIDE.md §3 "Session 4")

### What changed

**Live-Postgres bug hunt (four real, pre-existing bugs found and fixed —
two were flagged going into this session, two more surfaced while
actually wiring the code this session needed to build):**

1. **`organizations` RLS recursion** (0016) — its own policy queried
   `organizations` from inside itself under FORCE RLS, causing
   `ERROR: infinite recursion detected in policy for relation "organizations"`.
   Fixed in `0019_super_admin_backend.sql` via a `nexus_bootstrap`-owned
   `current_org_parent_id()` SECURITY DEFINER function, same pattern as
   `find_user_by_email` (0003).
2. **`audit_log` could never record a platform-level (`org_id is null`)
   event** — its policy had no `WITH CHECK`, so Postgres reused the
   `USING` clause, which is never true for a null `org_id`. Fixed in
   0019 by splitting into separate SELECT/INSERT policies.
3. **NEW, found this session**: even with #1/#2 fixed, every
   `organizationService.ts` write (`createOrganization`,
   `updateOrganization`, `assignCompanyToGroup`) still failed live,
   because all three use `returning *`, and Postgres re-checks a
   RETURNING row against the table's **SELECT** policy — a brand-new
   org, or one written with no `app.current_org_id` set, can never pass
   `tenant_isolation_select`. Fixed in `0020_organizations_platform_writes.sql`:
   three narrow `nexus_bootstrap`-owned SECURITY DEFINER functions
   (`create_organization_row`, `update_organization_row`,
   `assign_company_to_group_row`), `organizationService.ts` updated to
   call them instead of raw insert/update. Also caught two of
   `organizationService.ts`'s raw validation `select`s (parent-group
   existence, company existence) that would have silently 0-rowed under
   the same RLS shape — routed through `search_organizations` (0019)
   instead.
4. **NEW, same root cause as #3, found while building `auditLogService.ts`**:
   `audit_log`'s platform-level insert (fix #2) still failed with
   `returning` for the same RETURNING-vs-SELECT-policy reason. This is
   almost certainly what a prior session's own still-open investigation
   (see this file's earlier Session 40 entry, now superseded) was
   actually running into — the minimal repro table it built had no
   RETURNING and a different policy shape, so it never hit this.
   Fixed in `0021_audit_log_platform_insert_fn.sql`
   (`insert_platform_audit_log`), same pattern as #3.
5. **CRITICAL, found while verifying #3/#4**: `authorizationService.canReadOrg()`'s
   `group_read` branch — the one new authorization rule this whole
   guide phase is built around ("leader-of-a-group → read-scoped access
   to companies where `parent_org_id = group`") — has never actually
   worked. Its two lookups were plain `pool.query(select ... from
   organizations where id = $1)` with no org context, which silently
   returns 0 rows under RLS (not an error — worse, a false negative that
   looks like "not found"). Confirmed live: the exact query returned 0
   rows for a real, existing org id. Fixed by routing both lookups
   through `search_organizations` instead. This shipped in Session 37
   and has been silently broken since; every isolation test that
   exercised it must have been mocking the DB layer rather than running
   against real Postgres, which is exactly what this session's
   discipline (validate against a live instance) exists to catch.

All five verified live against a real local Postgres instance this
session (`create_organization_row`/`update_organization_row`/
`assign_company_to_group_row`/`insert_platform_audit_log` called
directly as `nexus_app`; `canReadOrg`'s new query shape confirmed
against a real group/company pair; `organizations`' SELECT policy
confirmed to admit a real parent/child pair under a valid context).

**New this session:**
- `auditLogService.ts` — write side (`logOrgAction`/`logOrgActionSafely`
  for the common org-scoped case, `logPlatformAction`/
  `logPlatformActionSafely` for the null-org platform case) plus a read
  side (`searchAuditLog`, routed through 0019's `search_audit_log`).
- `systemMetricsService.ts` — skeleton per the guide's own wording: a
  real `database` check (`select 1` against the live pool), `api`
  self-check, and five named `unknown`-status placeholders (ai, email,
  n8n, notifications, webhooks) with a stable shape for Session 5's
  dashboard to render against.
- `postHogAnalyticsService.ts` — the guide's "analyticsService.ts —
  PostHog no-op stub", named differently because `analyticsService.ts`
  already exists in this repo (PRD §8.7 Task Trends, unrelated,
  real, wired-up) — see this file's own header for why colliding names
  was the wrong call.
- `routes/admin/superAdmin.ts` — registered at `/api/v1/admin/super`.
  Organizations CRUD (create/patch/deactivate/assign-group,
  plan-change folded into PATCH), investigation search
  (`/investigate/organizations`, `/investigate/users`), platform
  analytics overview (N-query merge: org counts by type/active, user
  count, platform admin count), system health, audit log query/filter.
  Every route gates on `isPlatformAdmin()` first via a shared
  `requirePlatformAdmin` helper.
- `packages/shared`: `AuditLogEntry`, `AuditLogQuery`, `AuditResult`,
  `SubsystemHealth`, `SystemHealthReport`, `SubsystemStatus`,
  `PlatformUserSummary`, `PlatformAnalyticsSummary` types added.

### Verification
- All 21 migrations (0001–0021, including this session's 0019/0020/0021)
  applied cleanly against a fresh local Postgres instance.
- `tsc --noEmit` clean on `packages/shared`, `apps/api`, `apps/web`.
- Full `apps/api` suite: 118 passed, 1 failed — the same pre-existing,
  unrelated `chat.test.ts` SSE-stream-open timeout flagged in Sessions
  37, 38, and 39's own log entries; unchanged and untouched by this
  session's diffs, confirmed still the only failure.
- Live-Postgres verification of every bug/fix above (see list),
  performed directly against `nexus_app`'s actual privilege level, not
  assumed from reading the SQL.

### Not yet done (real gaps, carried forward, not silently skipped)
- **No route/service test files added this session** for
  `auditLogService.ts`, `systemMetricsService.ts`, or `superAdmin.ts` —
  session budget went into the live-Postgres bug hunt above (five real
  bugs, three found only by actually running the code), which is a
  higher-value use of the same budget than mocked-DB unit tests that
  would not have caught any of them. Real gap for next session.
- The pre-existing `chat.test.ts` SSE timeout — still un-investigated,
  fourth session in a row it's been flagged and not touched.
- Group Admin scoped routes + Company Admin admin-shell routes —
  correctly out of scope, Session 41 per the guide.
- `apps/web` Super Admin dashboard UI — correctly out of scope, Session
  5/41 per the guide (`modules/admin/` is still an empty shell).
- Browser click-through of `apps/web`, NIM vs. Gemini provider decision,
  per-record trust for files — standing items from prior sessions,
  unchanged.

### Next steps
Session 41 (guide's Session 5/6, merged per this repo's own numbering
pattern): Super Admin dashboard UI consuming this session's routes;
Group Admin + Company Admin backend+UI. Also carries forward: test
coverage for this session's three new services/route file (see Not yet
done above).

## Session 40 (continuation) — 2026-08-30 — Test coverage for Super Admin backend

Scope was fixed coming in: tests for exactly `auditLogService.ts`,
`systemMetricsService.ts`, and `routes/admin/superAdmin.ts` (the gap
this session's own log entry above flagged), mocked-DB only, no
re-verification of 0019–0021.

### Added
- `services/auditLogService.test.ts` (4 tests) — `logOrgAction` writes
  through `withOrgContext` and maps nulls to `undefined`;
  `logPlatformAction` routes through `insert_platform_audit_log` on the
  raw pool with no `withOrgContext` call; both `*Safely` wrappers
  swallow a rejected write and resolve `undefined` instead of throwing.
- `services/systemMetricsService.test.ts` (2 tests) — `worstOf`'s
  priority ordering exercised through `getSystemHealth()`, the only
  angle available since `worstOf` itself isn't exported: a healthy db
  check still yields overall `'unknown'` (the five still-unwired
  placeholder subsystems outrank `'ok'`); a failed db check yields
  overall `'down'` (outranks `'unknown'`).
- `routes/admin/superAdmin.test.ts` (13 tests) — 401 with no session;
  a parameterized 403 check (`it.each`, 7 cases) across one representative
  route from every route family (organizations create/update/deactivate,
  investigate, analytics, health, audit) confirming `requirePlatformAdmin`
  actually gates each handler rather than one being a silent pass-through;
  one happy-path 200/201 per route group (orgs CRUD, investigate,
  analytics, health, audit).
- Total: 19 new tests, within the ~15-20 cap for this pass.

### Bugs found
None. All three files behaved as documented on first pass — no inline
fix was needed to get a test passing.

### Verification
- `tsc --noEmit` clean on `packages/shared`, `apps/api`, `apps/web`.
- Full `apps/api` suite, run once at the end: 137 passed, 1 failed —
  the same pre-existing `chat.test.ts` SSE-stream-open timeout flagged
  in Sessions 37–40's own log entries; still open, still untouched,
  confirmed still the only failure.

### Not yet done / still open (explicitly not opened this pass)
- `chat.test.ts` SSE timeout — still un-investigated, fifth session in
  a row flagged and not touched (out of scope for this pass by
  explicit instruction).
- `systemMetricsService.ts`'s five placeholder subsystems (ai, email,
  n8n, notifications, webhooks) still have no real check behind them —
  unchanged, real checks remain their own later piece of work per this
  file's own header comment.
- Everything else carried forward from the Session 40 entry above is
  still carried forward (Group/Company Admin, Super Admin dashboard UI,
  browser click-through, NIM vs. Gemini, per-record file trust).

## Session 41 — 2026-08-30 — Group Admin backend (ADMIN_BUILD_GUIDE.md §3 "Session 6", backend half only)

Scope: Group Admin scoped routes (companies-in-group only) + group-scoped
aggregate analytics via N-query merge. Company Admin (backend or UI) and
the Session 6 dashboard UI are explicitly not part of this pass — per
the guide, Company Admin is mostly a thin reuse layer and the guide
itself merges it with Group Admin only at the session-numbering level,
not as one undifferentiated task.

### Added
- `authorizationService.isGroupAdmin(user)` — the one new gate this
  session needs: `leader` role *and* the caller's own current org is
  `org_type = 'group'`. Deliberately reads `organizations` through
  `withOrgContext(user.orgId, ...)` rather than `canReadOrg`'s
  `search_organizations` bootstrap path — the caller's own org id is
  covered by 0016's tenant_isolation policy's first clause directly, so
  the RLS-bypass mechanism `canReadOrg` needs for a *different* org's
  metadata isn't needed for "what's my own org's type."
- `packages/shared`: `GroupAnalyticsSummary` type (same family as
  `PlatformAnalyticsSummary`, scoped to one group).
- `routes/admin/groupAdmin.ts`, registered at `/api/v1/admin/group`:
  - `GET /companies` — reuses `organizationService.listCompaniesInGroup`
    as-is, called with the caller's own `orgId` as the group id (a Group
    Admin's group *is* their current org, so `canReadOrg`'s `'own'`
    branch already covers this without touching the `group_read` rule).
  - `GET /analytics/overview` — N-query merge, N = however many
    companies this group actually has (not a fixed platform-wide
    handful): total/active company counts from the list above, plus a
    per-company `org_memberships` count merged in JS. Each per-company
    count goes through `withAuthorizedOrgContext` (not a plain
    `withOrgContext`) specifically so `canReadOrg`'s `group_read` rule —
    the highest-risk logic in the whole build per the guide's own
    table, fixed and verified live in Session 40 — is genuinely
    re-exercised per child org, not assumed from the earlier companies
    read (that read authorized the group's own directory row; this one
    authorizes each child's own tenant data, a different target).
- Tests: 3 new cases in `authorizationService.test.ts` for
  `isGroupAdmin` (non-leader short-circuits with no DB call; leader of a
  group; leader of a company, not a group); `routes/admin/groupAdmin.test.ts`
  (7 tests) — 401 with no session, a company-leader-but-not-group-leader
  403 on both routes, a team-member-inside-a-group-org 403 on both
  routes (role alone isn't enough), and one happy path per route.
  `withAuthorizedOrgContext` is left real in the route test (only
  `isGroupAdmin` itself is mocked) so the analytics route's per-company
  `canReadOrg` calls run for real against scripted `pool.query`
  responses, rather than being trusted on the strength of the unit test
  covering `isGroupAdmin` alone.

### Bugs found
None.

### Verification
- `tsc --noEmit` clean on `packages/shared`, `apps/api`, `apps/web`.
- Full `apps/api` suite: 147 passed, 1 failed — the same pre-existing
  `chat.test.ts` SSE-stream-open timeout, sixth session in a row
  flagged and unchanged; confirmed still the only failure.

### Not yet done (real gaps, carried forward)
- `chat.test.ts` SSE timeout — still open, still untouched.
- Company Admin backend (thin reuse layer per the guide) — Session 6's
  other half, not started.
- Group Admin + Company Admin dashboard UI — not started.
- Super Admin dashboard UI (Session 5) — still not started, unchanged
  from Session 40's entry.
- `systemMetricsService.ts`'s five placeholder subsystems — unchanged.
- Browser click-through of `apps/web`, NIM vs. Gemini provider decision,
  per-record trust for files — standing items, unchanged.

### Next steps
Company Admin backend (thin layer, mostly `leader`-role reuse per the
guide) to close out Session 6, then Session 6's combined dashboard UI
for both Group Admin and Company Admin.

## Session 42 — 2026-08-30 — Group Admin + Company Admin dashboard UI, guest-invite surface

Scope: the UI half of Session 6 (backend for both — group and company —
was already complete going into this session, confirmed by inspection
rather than re-built). Delivers exactly the three items requested:
Group Admin dashboard, Company Admin dashboard shell, guest-invite
surface.

### Added
- **`GET /api/v1/admin/group/activity`** (`groupAdmin.ts`) — the one
  real backend gap found: the Session 6 dashboard shell names an
  Activity tab for Group Admin, but Session 41's backend pass only
  shipped Companies + Analytics. Added with the same `searchAuditLog` +
  mandatory-orgId shape as `companyAdmin.ts`'s own `/activity`, plus a
  test case in `groupAdmin.test.ts` (11 tests total in that file now)
  and a `routes/admin/README.md` update. No other backend changes were
  needed or made — the `audit_log` RLS/RETURNING issues from Session 40
  were already fixed in migrations 0019–0021 and didn't need touching.
- **`GET /session` now returns `isPlatformAdmin` / `isGroupAdmin` /
  `isCompanyAdmin`** (`auth.ts`, three already-built
  `authorizationService` gates folded into the one call the client
  already makes on load) — `CurrentUser` (web) updated to match. Same
  "convenience, not the real boundary" posture as `permissionGated`:
  every `/admin/*` route still re-checks server-side.
- **`ia.ts`**: new `IaSection.adminGate?: 'group' | 'company'` field,
  layered on top of `permissionGated` (App.tsx's `visibleSections`
  filter now checks both) — Group Admin and Company Admin are each a
  *subset* of leaders, not every leader, so the existing `isLeader`-only
  check wasn't fine-grained enough. Two new IA sections (`admin-group`,
  `admin-company`), both numbered `12` / pathed `/admin` — mutually
  exclusive per session since a leader's own org is either `group` or
  `company`, never both, so there's no real route collision even though
  both entries share a path.
- **`apps/web/src/modules/admin/`** — filled in from Session 37's empty
  shell:
  - Group Admin: `GroupOverview`, `GroupCompanies`, `GroupPeople`,
    `GroupOperations`, `GroupGoals`, `GroupAnalytics`, `GroupActivity`.
    Companies/Analytics/Activity call the three group-scoped admin
    routes; People/Operations/Goals deliberately call the *existing*
    session-cookie-scoped `peopleService`/`automationService`/
    `goalService` directly — a Group Admin's session orgId *is* their
    group, so those routes already return exactly the group's own data
    with no group-specific backend needed.
  - Company Admin: `CompanyOverview`, `CompanyAnalytics`,
    `CompanyAutomation`, `CompanyActivity`, `CompanySettings`. First
    four call the four company-admin routes; `CompanySettings` is a set
    of links into the real Settings modules (TeamRoles, Account, the
    new GuestInvites) rather than a duplicate build — matches the
    guide's own "mostly reuse" framing for Company Admin.
  - `components/admin/AuditLogTable.tsx` — one shared presentational
    table for both dashboards' Activity tabs (`AuditLogEntry[]` in,
    same division of labor as `FailsafeTable`/`MissingEodList`).
- **`apps/web/src/services/groupAdminService.ts`**,
  **`companyAdminService.ts`**, **`guestInviteService.ts`** — thin
  wrappers, same one-function-per-route convention as every other
  `*Service.ts`.
- **`modules/settings/GuestInvites.tsx`** + new `guests` Settings
  subsection (`/settings/guests`) — the UI half of `guestService.ts`'s
  backend (Session 37); `routes/guests.ts`'s own header comment named
  this exact deferred surface. Gated client-side the same
  `role === 'leader'` way `TeamRoles.tsx`'s `canManage` already is; no
  orgType restriction since `POST /guests` applies none itself. Shows
  each guest's one-time temp password after creation, with an explicit
  note that it can't be retrieved again.

### Not built (explicitly out of scope for this pass)
- **Super Admin dashboard UI** — not part of this session's requested
  deliverable list (only Group Admin, Company Admin, guest-invite
  surface were asked for). Backend (`superAdmin.ts`) and
  `CurrentUser.isPlatformAdmin` are both already in place for whenever
  it's built.
- `systemMetricsService.ts`'s five placeholder subsystems — unchanged.
- `chat.test.ts` SSE timeout — still open, still untouched, seventh
  session in a row flagged and unchanged (out of scope by design: it
  predates and is unrelated to every diff in this session).
- Browser click-through of the new pages against a live Postgres
  instance — verification this session was `tsc --noEmit` +
  `vite build` (both clean) + the `apps/api` suite (166 passed / 1
  pre-existing failure); no browser or live-DB session was run. Real
  gap, flagged rather than assumed away — the new admin-shell components
  follow existing, already-verified module patterns closely (same
  load/error/ready state machine as `analytics/Overview.tsx`, `people/
  Overview.tsx`, etc.) but haven't themselves been clicked through.

### Verification
- `tsc -p` clean on `packages/shared`, `apps/api`.
- `apps/web`: `tsc -b && vite build` — clean, production bundle built
  successfully (167 modules transformed, no type errors).
- Full `apps/api` suite: 166 passed, 1 failed — the same pre-existing
  `chat.test.ts` SSE-stream-open timeout, unchanged, confirmed still the
  only failure.

### Next steps
Browser click-through of the new `/admin` and `/settings/guests` routes
against a live session (group leader, company leader, and non-leader
cases) — the standing gap this session's own entry flags above. Super
Admin dashboard UI, if/when requested. `chat.test.ts` SSE timeout,
eighth session running.

## Session 43 — 2026-08-30 — Super Admin dashboard UI (ADMIN_BUILD_GUIDE.md §3 "Session 5")

Scope: the one remaining unbuilt piece of the guide's 9-session admin
plan with a fully-shipped backend behind it — `routes/admin/superAdmin.ts`
(Session 40) and `CurrentUser.isPlatformAdmin` (Session 42) existed with
no UI consuming them. Priority this session was delivery: finish this
gap, fix only what's required for it to actually work, ship.

### Bug found and fixed (required for the implementation to function)
While building the Overview tab's first real caller of
`GET /admin/super/analytics/overview`, live-verified (see below) that the
route's organization/user counts were silently broken under a real
production connection:

- `organizations` and `users` both carry `force row level security`.
  `routes/admin/superAdmin.ts`'s analytics handler ran plain
  `select ... from organizations group by ...` / `select count(*) from
  users` on the raw pool — no `app.current_org_id` set, so
  `tenant_isolation`'s `id/org_id = current_setting(...)` is never true
  and both queries return **zero rows, always**, regardless of how much
  real data exists.
- Masked in every prior session because local dev's own `DATABASE_URL`
  (docker-compose's `POSTGRES_USER=nexus`) is a Postgres superuser,
  which bypasses RLS unconditionally — nothing before this session ran
  that query as the real, non-superuser `nexus_app` role the security
  model actually specifies (0001_init.sql's own comment: "never a
  superuser / BYPASSRLS role").
- Confirmed live this session: installed Postgres locally, created
  `nexus`/`nexus_app`/`nexus_bootstrap` exactly matching the migrations'
  own role setup, ran all 22 migrations clean, seeded a real org and
  user as the superuser, then queried as `nexus_app` specifically —
  `select count(*) from users` and the organizations group-by both
  returned 0 with real rows present. `platform_admins` was unaffected
  (that table never had RLS enabled at all).
- Fix: `0022_platform_analytics_counts.sql` — two narrow,
  `nexus_bootstrap`-owned `SECURITY DEFINER` functions
  (`platform_organization_counts()`, `platform_user_count()`), same
  isolated-function-per-need shape as 0019/0020/0021's own fixes, not a
  general query helper. `superAdmin.ts`'s analytics handler and its
  mocked-DB test updated to match the new field names
  (`org_count`/`platform_user_count`). Re-verified live post-fix: both
  functions return real counts as `nexus_app`.

### Added
- **`superAdminService.ts`** (web) — thin wrapper, same one-function-
  per-route convention as every other `*Service.ts`: platform analytics,
  system health, organizations search/create/update/deactivate/assign-
  group, platform user search, audit log query.
- **`modules/admin/SuperOverview.tsx`** — platform-wide metric row
  (groups/companies/active orgs/users/platform admins) + a subsystem
  health strip, same "landing page previews what the tabs drill into"
  pattern `GroupOverview.tsx` already established.
- **`modules/admin/SuperOrganizations.tsx`** — one CRUD surface for both
  Groups and Companies (same `Organization` shape either `orgType`,
  filtered client-side rather than split into two components per the
  guide's own two-tab framing — there's no different behavior behind
  either filter). Create modal, edit/plan-change/deactivate/assign-to-
  group drawer.
- **`modules/admin/SuperUsers.tsx`** — platform-wide user investigation
  search (name/email), read-only per the guide ("Read-only by default").
- **`modules/admin/SuperAudit.tsx`** — platform-wide audit log with
  action/result filters, reusing the existing `AuditLogTable` component
  Group/Company Admin's own Activity tabs already share.
- **`ia.ts`**: `IaSection.adminGate` gains a third value, `'platform'`,
  and a new `admin-platform` section (`/admin/platform`, distinct from
  Group/Company Admin's shared `/admin` — `platform_admins` is a
  separate non-org-scoped table per the guide, so unlike Group vs.
  Company Admin there's no structural guarantee a platform admin can
  never also hold a group/company leadership membership, so no shared-
  path "mutually exclusive per session" argument applies here).
- **`App.tsx`**: `visibleSections` filter checks `isPlatformAdmin`;
  `renderSubsection` wires the four new modules.

### Not built (explicitly out of scope for this pass, flagged not dropped)
- **"Operations" and "AI & Costs"** tabs named in the guide's own Session
  5 outline — no backend route exposes platform-wide `ai_usage`
  aggregation yet (`aiUsageService.ts`'s own header comment already
  names this as later work, not this session's), and there's no
  "Operations" concept at the platform tier distinct from what
  Organizations/Audit already cover. Wiring a real platform-wide AI-cost
  endpoint was deliberately not attempted this pass — it's new backend
  surface, not "finishing" an existing one, and this session's priority
  was closing the guide's one fully-backed, UI-less gap, not opening a
  new one.
- **Investigation drill-down / breadcrumb** (guide: "Group→Company→User
  drill-down + breadcrumb trail") — Users tab's `homeOrgName` column
  already answers the actual question ("which org is this person in");
  a separate click-through view would just re-render the Organizations
  tab's own row for one org. Real simplification, not an oversight, but
  flagged in case the guide's literal breadcrumb UX is still wanted.
- `chat.test.ts` SSE timeout — still open, still untouched, ninth
  session in a row flagged and unchanged (out of scope by design: predates
  and is unrelated to every diff in this session).
- Browser click-through of the new `/admin/platform/*` routes against a
  live session (platform admin, and non-admin 403 case) — verification
  this session was `tsc -b` + `vite build` (both clean) + the `apps/api`
  suite, run against a real local Postgres instance for the migration
  itself (166 passed / 1 pre-existing failure, same as every prior
  session). No browser session was run for the new UI specifically.

### Verification
- `tsc -p` clean on `packages/shared`, `apps/api`.
- `apps/web`: `tsc -b && vite build` — clean, 172 modules transformed.
- All 22 migrations (0001–0022) applied cleanly against a fresh local
  Postgres instance (installed this session specifically to get a real,
  non-superuser `nexus_app` connection — the exact gap that let the
  analytics bug above go unnoticed for three sessions).
- Full `apps/api` suite: 166 passed, 1 failed — the same pre-existing
  `chat.test.ts` SSE-stream-open timeout, unchanged, confirmed still the
  only failure.
- `0022`'s two new functions live-verified as `nexus_app` specifically
  (not the dev superuser), both before (0 rows, confirmed the bug) and
  after (real counts, confirmed the fix) the migration.

### Next steps
Browser click-through of the new Super Admin routes against a live
session — the standing gap this session's own entry flags above.
Platform-wide AI usage aggregation + an "AI & Costs" tab, if the guide's
literal Session 5 scope is still wanted beyond what shipped this pass.
Guide's Session 7 (AI chat cross-referencing) is next in the guide's own
sequencing once Session 5/6 (now both done) are considered closed.
`chat.test.ts` SSE timeout, ninth session running.

## Session 44 — 2026-08-30 — AI chat cross-referencing (ADMIN_BUILD_GUIDE.md "AI chat cross-referencing", guide's own Session 7)

Scope: the guide's own three-bullet decision — default stays scoped to
current chat, cross-referencing task/company data becomes an explicit,
grantable permission with its own check, decide the grant level up front.

### Decision made at the start of this session (per the guide's own instruction)
**Grant level: org (company), not group.** `permissions` is
`unique(user_id, org_id, resource, action)` (DECISIONS.md §5) — every
existing grant in this table is already org-scoped, and DECISIONS.md's
own corollary is that a cross-org view is N separately-scoped queries
merged at the API layer, never a single widened read. Chat
cross-referencing has no merge step of its own (it's one org's assistant
answering about that one org's own data), so there's no case here that
needs more than `hasPermission(user, 'ai_cross_reference', 'read')`
against the caller's current `org_id`. A group-rollup variant is real
future work if a concrete need shows up, not built preemptively — same
posture DECISIONS.md #2 takes for task_trends/TimescaleDB.

### Added
- **`ai_cross_reference: ['read']`** — new resource in
  `PERMISSION_RESOURCE_ACTIONS` (`packages/shared`), its own resource
  rather than a `chat` action, per the guide's own "not implicit in
  existing AI Analyst access" instruction. Read-only (nothing to
  create/update/delete — it's a pure capability flag). Surfaces
  automatically in TeamRoles.tsx's grant picker (it derives its options
  from this same const) — no frontend picker changes needed.
- **`apps/api/src/services/chatContextService.ts`** (new) —
  `buildChatCrossReferenceContext(orgId)`, a bounded, deterministic org
  snapshot (org name, people count, active goal count, open/blocked task
  counts, upcoming-deadline count, capped lists of recent open + blocked
  tasks). Reuses aiReportService.ts's own precedent
  (`getBlockedTasks`/`getUpcomingDeadlines`) plus `listTasks`/
  `listGoals`/`listOrgPeople` rather than duplicating queries — this is
  the second caller of the "AI narrates, doesn't invent" deterministic-
  signal pattern, not a one-off. Capped at 15 rows per list
  (`TASK_SNAPSHOT_LIMIT`) — a chat prompt payload, not a report export;
  every extra row is tokens spent on every future turn in the
  conversation, not a one-time cost.
- **`aiService.ts`**: `ChatReplyInput.crossReferenceContext` (optional).
  Presence, not a separate boolean, switches `chatReply` between
  `CHAT_SYSTEM_PROMPT` (unchanged, byte-for-byte, from before this
  session) and a new `CHAT_CROSS_REFERENCE_SYSTEM_PROMPT` that tells the
  model it now has a live snapshot and must only cite figures/tasks that
  actually appear in it. `buildChatUserPrompt` appends the snapshot as
  its own labeled JSON block after the transcript when present. Still
  resolves the `'chat'` provider target and logs `feature: 'chat'` —
  cross-referencing isn't a different product surface (DECISIONS.md §8),
  it's the same chat feature with a richer prompt, so no new
  `AiUsageFeature` value was added.
- **`chatService.ts`**: `sendChatMessage` gains a 5th param,
  `crossReferenceEnabled` (default `false`), decided entirely by the
  caller (routes/chat.ts) — no permission logic added to this file, same
  split every other service here already keeps. When true, builds a
  fresh context via `chatContextService.ts` (never cached across turns —
  a snapshot from three messages ago could already be stale) and passes
  it to `aiService.chatReply`; `SendChatMessageResult.crossReferenced` is
  set `true` only when a context was actually built and used. Ignored
  entirely on a task-scoped thread (task threads get no AI reply at all,
  per Session 35) — defensively, not just left to the route to remember.
- **`routes/chat.ts`**: `POST /` now checks
  `hasPermission(user, 'ai_cross_reference', 'read')` — only for the
  org-wide `'ai'` thread (`!body.taskId`), never spent on a task-thread
  send since `sendChatMessage` would ignore it there anyway — and passes
  the result through as the new 5th argument.
- **`SendChatMessageResult.crossReferenced?: boolean`** (`@nexus/shared`)
  — deliberately not a field on `ChatMessage`/`chat_messages` itself:
  it's a property of how *this specific reply* was generated, not of the
  message row, so it doesn't need a migration or to survive a reload or
  travel over the SSE broadcast the way the message body does. Absent
  (not `false`) when unused, same convention `aiError` already follows.
- **`ChatThread.tsx`** — a small caption ("Answered using your org's
  live task/goal data") under an AI reply the *current tab* just
  received `crossReferenced: true` for. Tracked in local component
  state (a `Set` of message ids), not derived from the message itself —
  a reload or another tab's SSE-delivered copy has no way to know and
  doesn't need to, per the flag's own non-persisted design above.

### Tests
- `permissions.test.ts`: `ai_cross_reference`+`read` grants successfully
  through the generic `POST /permissions` route (no special-cased
  endpoint needed); `ai_cross_reference`+`create` 400s (only `read` is a
  defined action for this resource).
- `chat.test.ts`: new `CROSS_REF` caller (chat.create + tasks.read +
  ai_cross_reference.read). Three cases — a caller holding the grant gets
  `crossReferenced: true` and the route is confirmed to pass
  `crossReferenceEnabled=true` into `sendChatMessage`; a caller with
  `chat.create` but no `ai_cross_reference` grant gets `crossReferenced`
  undefined and `false` passed through; a task-scoped send from a caller
  who *does* hold the grant still passes `false` — the route never even
  asks for a task thread.
- `aiService.test.ts`: `chatReply` without `crossReferenceContext` is
  confirmed to still send the original "no live access" system prompt
  with no `ORG SNAPSHOT` block; with it, confirmed to switch to the new
  system prompt, fold the snapshot into the user prompt as JSON, and
  still resolve provider target `'chat'` / log feature `'chat'`.

### Not built (explicitly out of scope for this pass)
- **Group-level cross-referencing** — see the grant-level decision above;
  no group rollup exists to cross-reference against yet regardless
  (Session 8's own Company docs/archive and any future group-wide
  reporting are the more likely place a real ask for this would surface
  first).
- **Persisting `crossReferenced` on the message row / a schema
  migration** — deliberately kept as a response-only, non-persisted
  flag (see `SendChatMessageResult`'s own doc comment); revisit only if
  a real need to show this after a reload shows up.
- Task-thread cross-referencing — task threads have no AI reply at all
  (Session 35's own decision, unrevisited here); `ai_cross_reference`
  is meaningless there and the route/service both make that explicit
  rather than silently no-op.
- `chat.test.ts` SSE timeout — still open, still untouched, tenth
  session in a row flagged and unchanged (out of scope by design:
  predates and is unrelated to every diff in this session).
- Browser click-through against a live session (a real `ai_cross_reference`
  grant, sending a message, confirming the snapshot-grounded reply and
  the new caption render) — not run this session, same standing gap
  class as prior sessions' own admin-UI entries.

### Verification
- No `node_modules` in this sandbox (network egress disabled — same
  constraint every prior session in this log has flagged), so `tsc -p`/
  `vite build`/the real test runner could not be executed here.
- As a substitute sanity check: every new/modified `.ts`/`.tsx` file was
  run through a standalone `tsc --noEmit` pass (no project references,
  `skipLibCheck`) and diffed against the same check run on an untouched,
  pre-existing file (`analyticsService.ts`) to confirm the only errors
  are the expected missing-module/missing-`@types` artifacts of an
  offline sandbox with no installed dependencies (`TS2307`, `TS7006`,
  `TS2347`, `TS2591`, JSX-namespace errors) — not errors introduced by
  this session's edits. No genuine syntax or type errors found.
- Real `tsc -p`/`vitest run` against `packages/shared`, `apps/api`,
  `apps/web` is still owed, same standing gap as every "no `node_modules`"
  caveat elsewhere in this log — flagged here, not assumed away.

### Next steps
Run the real build/typecheck/test suite once `node_modules` is available
(`npm install` at the repo root, then `npm run typecheck && npm run
test`) — the one thing this session could not verify directly. Browser
click-through of a granted `ai_cross_reference` user's chat experience
against a live session. Guide's Session 8 (Company docs/archive) is next
in the guide's own sequencing. `chat.test.ts` SSE timeout, tenth session
running.

## Session 45 — 2026-08-30 — Company docs/archive (ADMIN_BUILD_GUIDE.md "Session 8", 0023)

Session 44's own "Next steps" named this next: Company docs/archive
(guide's own Session 8). Per-record file trust already had a registered
`company_archive` authorizer sitting unused in `fileResourceAuth.ts`
since Session 31 — this session wires the feature that actually exercises
it: an org-wide document archive, flat list, leader-only upload, any-member
read, riding the existing polymorphic `/files` endpoints rather than a new
CRUD surface.

### Added
- **`packages/shared/src/index.ts`**: `COMPANY_ARCHIVE_RESOURCE_TYPE`
  constant, `category` field on `FileRecord`/`RequestFileUploadInput`,
  `storageUsedBytes`/`storageQuotaBytes` on `CompanyAnalyticsSummary`.
- **`apps/api/src/services/fileService.ts`**: org-wide storage quota
  enforcement (`getOrgStorageQuota`, `getOrgStorageUsage`,
  `StorageQuotaExceededError`) on top of the existing per-file
  `MAX_UPLOAD_BYTES` cap — both share the `||`-not-`??` blank-env-var
  safety reasoning. `category` threaded through `requestFileUpload`'s
  insert.
- **`apps/api/src/routes/files.ts`**: `POST /` now maps
  `StorageQuotaExceededError` to a distinct 413 (`storage_quota_exceeded`)
  alongside the existing `file_too_large` 413, so the client can tell
  "pick a smaller file" apart from "ask an admin to raise the quota."
- **`apps/api/src/routes/admin/companyAdmin.ts`**: `GET /overview` now
  folds `storageUsedBytes`/`storageQuotaBytes` into the same aggregate
  Promise.all pass as the existing people/task/goal/knowledge counts.
- **`apps/web/src/services/companyArchiveService.ts`** (new) — thin
  wrapper over the existing web-side `fileService.ts` two-phase upload
  flow, scoped to `resourceType='company_archive'`, `resourceId=orgId`.
  Also owns the mime-type-family icon lookup and the
  previewable-inline-vs-open-elsewhere decision.
- **`apps/web/src/modules/knowledge/CompanyDocs.tsx`** (new) — flat list
  UI: category filter chips, leader-only upload, inline preview modal for
  image/PDF/plain-text, presigned-URL-in-new-tab for everything else.
- **`apps/web/src/app/ia.ts`** / **`App.tsx`**: `company-docs` subsection
  registered under Knowledge (not a new top-level IA number — see
  `CompanyDocs.tsx`'s own header on why Knowledge is the closest existing
  access-shape match), routed to the new component.
- **`apps/api/.env.example`**: `STORAGE_DEFAULT_ORG_QUOTA_BYTES=`
  documented next to `STORAGE_MAX_UPLOAD_BYTES` (this was originally
  logged as its own tiny session before the rest of this feature's files
  were provided — folded in here since it's the same feature).
- Tests: `apps/api/src/services/fileService.test.ts` (new) — quota
  allow/reject, per-org override precedence over the env default,
  per-file cap still checked first, `category` persisted. Extended
  `companyAdmin.test.ts` for the two new overview fields.

### Added (continuation — `companyArchiveCache.ts` written)
**`apps/web/src/services/companyArchiveCache.ts`** (new) — the module
`CompanyDocs.tsx` imports and that was missing from the initial drop
above. IndexedDB-backed, two stores:
- `metadata` — `getCachedArchiveMetadata()` / `replaceCachedArchiveMetadata(files)`,
  full-replace-not-merge (the caller always has the authoritative current
  list), sorted newest-first on read.
- `blobs` — `getCachedBlob(fileId)` / `cacheBlob(fileId, blob, mimeType)`,
  capped at 25 entries (`MAX_CACHED_BLOBS`, a "deliberately simple v1
  default" same posture as `fileService.ts`'s own upload/quota
  constants), oldest-`cachedAt`-first eviction once the cap is exceeded.

No existing IndexedDB precedent elsewhere in `apps/web/src/services` to
mirror (confirmed by search before writing this), so it's a small
purpose-built wrapper rather than a shared "offlineStore" abstraction —
per PRD §6.2's "abstract repeated things, not hypothetical future
things," extract a shared cache module once a second caller needs one,
not before. Every exported function degrades to a no-op/empty return
(never throws, never rejects) when IndexedDB is unavailable or a write
fails — this cache is never the source of truth, only a paint-speed and
instant-reopen optimization, so a cache failure must never surface as an
error to `CompanyDocs.tsx`.

### Not built
- Cron-job-level cleanup of abandoned (never-confirmed) upload rows —
  same standing "flagged, not built" item `fileService.ts`'s own header
  has carried since Session 31.
- Real Postgres verification of the quota query — same standing
  no-`node_modules`/no-live-DB constraint as every session below.

### Verification
- Diffed the full tree against the Session 44 zip to confirm the exact
  file set this session touches (listed above, nothing else moved).
- Standalone `tsc --noEmit` pass (no project references, `skipLibCheck`)
  on every new/modified file, diffed against the same sandbox-only-error
  baseline prior sessions established (`TS2307`/`TS2591`/`TS2875`
  missing-module/missing-`@types`/JSX-runtime noise). Re-ran the same
  check on `CompanyDocs.tsx` after adding `companyArchiveCache.ts`: the
  only remaining `companyArchiveCache`-related output is the same
  `@nexus/shared`-package sandbox noise every other file in this repo
  produces (no `node_modules`), not a missing-file error — the real gap
  is closed.
- No test coverage added for `companyArchiveCache.ts` itself this
  session — flagged below, not skipped silently.
- Real `tsc -p`/`vitest run` against the full workspace still owed, same
  standing gap as every prior session in this log.

### Next steps
1. **Unit tests for `companyArchiveCache.ts`** — none exist yet. Needs a
   fake-indexedDB setup (e.g. `fake-indexeddb`, not currently a
   dependency) to test without a real browser: metadata replace-not-merge
   behavior, blob cache eviction once `MAX_CACHED_BLOBS` is exceeded, and
   the unavailable-IndexedDB degrade-to-empty/no-op path.
2. Real `tsc`/`vitest` run once `node_modules` is available (still every
   prior session's own standing gap).
3. Browser click-through of Company Docs end-to-end (upload → list →
   preview → cached re-open → archive) and of the `ai_cross_reference`
   chat experience from Session 44 — neither has been run against a live
   session yet.
4. `chat.test.ts` SSE timeout — still open, unrelated to this session's
   diff, same standing item flagged for many sessions running.
5. Abandoned-upload cleanup job for `fileService.ts` — still flagged,
   not built, same as every session since 31.

## Session 46 — 2026-08-30 — Phase H: the missing automation trigger route

`automationJobs.ts` (7 of 9 §12 job bodies), migration
`0024_automation_scheduling.sql` (`automation_run_log`,
`list_orgs_with_automation_enabled`), and the shared `AutomationRunLogEntry`
type all already existed in the tree and all referenced
`routes/automationMaintenance.ts` by name — but that file was never
created. Same "referenced but missing" shape as `companyArchiveCache.ts`
in Session 45; this session closes the same kind of gap for Phase H.

### Added
- **`apps/api/src/routes/automationMaintenance.ts`** (new) — the
  scheduler-facing `POST /run/:jobKey` trigger. Shared-secret gated
  (fails closed — 503 if unset, matching `calendarMaintenance.ts`'s own
  pattern exactly), 400 for an unknown key, 501 (not 400/404) for a
  known-but-unimplemented key so an external scheduler's alerting can
  tell "you configured a typo" apart from "this job isn't built yet."
  Runs the job, then writes one `automation_run_log` row per org via the
  new `recordAutomationRun`.
- **`apps/api/src/services/automationService.ts`**: `recordAutomationRun`
  (single-org insert) and `getAutomationHealth` (one entry per §12 job,
  closed set, `implemented` flag from `automationJobs.ts`'s own
  `UNIMPLEMENTED_JOBS`, `lastRun` left `undefined` — not fabricated —
  when a job hasn't actually run yet).
- **`apps/api/src/routes/automation.ts`**: `GET /health`, same
  `automation.read` gate as the existing list/log endpoints. Header
  comment updated — it previously described the health half as
  deliberately unbuilt.
- **`packages/shared/src/index.ts`**: `AutomationHealthEntry` type;
  updated the `AUTOMATION_CONTROL_KEYS` block comment (previously said
  "no job is actually wired... yet," no longer true for 7 of 9).
- **`apps/api/src/server.ts`**: registered the new route at
  `/api/v1/automation/maintenance`, same encapsulation as the calendar
  maintenance route immediately above it (no session/RBAC leakage
  between the two — Fastify plugin registration is per-call, confirmed
  against the existing calendar precedent rather than assumed).
- **`apps/api/.env.example`**: `AUTOMATION_MAINTENANCE_SECRET=`, same
  shape and same "one secret can serve both maintenance routes, or two
  separate ones — either works" note as the calendar var beside it.
- **Web**: `automationService.ts` (web) gained `fetchAutomationHealth`.
  `AutomationToggles.tsx`: new `HealthBadge` component rendering the
  four real states (not implemented / not yet run / ran successfully /
  failed) per row, health fetched independently of the controls
  load/error state so a health-fetch failure never blocks the toggle
  panel itself. The old "Schedule status coming in Phase H" placeholder
  notice is replaced with an accurate one naming the two still-unbuilt
  jobs and why (schema gap, not wiring gap).

### Not built (unchanged from what `automationJobs.ts` already flagged)
- `daily_recurring_tasks` / `hourly_follow_up` — no recurrence-template
  or `Follow_Up_Hours`-equivalent column exists anywhere in this schema;
  building either would mean inventing schema, not porting it.
- Email delivery for any of the 7 real jobs — `EmailService` (PRD
  §10.3) doesn't exist yet in this codebase; every job here notifies via
  `notifyInApp` only, exactly as `automationJobs.ts`'s own header
  already documented before this session touched it.

### Verification
- Not yet run this session — deliberately deferred. See "Next steps."

### Next steps
1. Tests for `automationMaintenance.ts` (secret gating, unknown-key 400,
   unimplemented-key 501, successful-run → correct `recordAutomationRun`
   calls) and for `automation.ts`'s new `GET /health`, following
   `automation.test.ts`'s existing mocking conventions — not yet written.
2. Standalone `tsc` sanity pass on every file touched this session (same
   check Sessions 44–45 ran) — not yet run.
3. Real `tsc -p`/`vitest run` against the full workspace — same standing
   gap as every session in this log.
4. Configure a real external scheduler (n8n Cloud workflows, one per job
   at its own §12 time, or nine `cron-job.org` entries) against
   `POST /automation/maintenance/run/:jobKey` — nothing calls this route
   automatically yet; it exists but nothing is scheduled to hit it.
5. `companyArchiveCache.ts` test coverage — still open from Session 45.
6. `chat.test.ts` SSE timeout — still open, many sessions running.

---

## Session 47 — Billing & plan enforcement (Paystack)

Scope: `SESSION_47_SCOPE_BILLING.md`'s §1 locked decisions (hybrid
tier+seat+usage pricing, Paystack only, grace period then mandatory
manual Super Admin review on payment failure) and §3 open questions
(guest-invite gate absorbed this session; every `org_memberships` role
counts as a seat; a Group or Company can each hold its own billing row,
with cascade resolved at read time; enforcement covers seat/AI-usage/
storage caps plus a general feature-flag mechanism).

This session picked up mid-stream from a prior context-limited session
that had already delivered the schema (`0025_billing.sql`), shared
types (`BILLING_TIERS`/`BillingSummary`/etc.), `billingService.ts`, and
gates wired into `invites.ts`, `auth.ts`, `calendar.ts`, `automation.ts`,
`goals.ts`, `aiService.ts` — but had stopped mid-edit on the
`ai_reports`/`agent_handoff` gates, with several items (webhook,
provider, org-facing routes, Super Admin review queue, job wiring)
still unbuilt.

### Fork reconciliation (important — read before touching automation.ts
### or shared/index.ts again)
The uploaded continuation files (`index__8_.ts`, `automation.ts`) had
branched from a point *before* Session 46's automation-health work
(`GET /automation/health`, `AutomationHealthEntry`, `getAutomationHealth`)
landed. Applied as-is, they would have silently reverted that work —
same class of problem as the Network backend fork noted in earlier
sessions. Resolved by diffing every uploaded file against the Session 46
zip before applying anything (per this codebase's own "verify a zip is
a genuine superset, diff explicitly" discipline) and hand-merging:
`shared/index.ts` and `automation.ts` kept their Session 46 automation-
health content intact; only the genuine Session 47 billing additions
were layered on top. `invites.ts`, `auth.ts`, `calendar.ts`, `goals.ts`,
`aiService.ts`, `billingService.ts` had clean, non-conflicting diffs and
were taken as-is.

### Built this session
- **`apps/api/src/routes/aiReports.ts`** / **`agentHandoffs.ts`**: the
  two gates left mid-edit — `requireFeature(orgId, 'ai_reports')` on
  `POST /generate` (after body validation, before the AI provider call)
  and `requireFeature(orgId, 'agent_handoff')` on `POST /` (create only —
  listing past handoffs isn't new usage, same "only the action that
  creates new usage needs the check" posture `automation.ts`'s
  enable-only gate already established).
- **`apps/api/src/routes/guests.ts`**: found genuinely unwired —
  guest-credential creation had neither the `guest_invites` feature gate
  nor `checkSeatLimit`, despite 0025's own header explicitly saying this
  gate was "absorbed here (routes/guests.ts wired this session, not
  deferred)." Added both, plus a best-effort `recomputeSeatCount` call
  after creation (org_memberships genuinely grows here — same
  authoritative-refresh-point posture `auth.ts`'s own call after invite
  acceptance already uses).
- **`apps/api/src/integrations/paystackProvider.ts`** (new):
  `initializeTransaction` (checkout, `metadata.orgId` round-tripped for
  webhook org resolution), `verifyTransaction` (server-side confirmation,
  never trust the client redirect), `verifyWebhookSignature`
  (HMAC-SHA512 over the raw body, timing-safe compare). One provider,
  no vendor-abstraction interface — §1 names Paystack specifically, not
  "a payment provider," so this is the template if a second is ever
  needed, not a premature interface today.
- **`apps/api/src/services/billingWebhookService.ts`** (new):
  `processWebhookEvent` — always records via `record_billing_event`
  first (org-less rows kept for manual reconciliation, same posture
  `audit_log`'s own nullable-`org_id` carve-out uses), two-path org
  resolution (checkout metadata, then customer/subscription code lookup
  for later events), handles `charge.success` / `invoice.payment_failed`
  (→ `past_due` + 7-day grace window, access unchanged per §1) /
  `subscription.disable` / `subscription.not_renew` (→ immediate `free`,
  no grace period — nothing pending to retry on a cancellation).
- **`apps/api/src/routes/billingWebhook.ts`** (new): public, no session.
  Scopes a raw-string content-type parser to this plugin only (Fastify
  encapsulation) so signature verification checks the exact bytes
  Paystack sent, without touching how any other route parses JSON.
  Always acks 200 regardless of verification/processing outcome, same
  "don't leak verification outcome via status code, don't make the
  sender retry into the same failure" posture `calendarWebhook.ts`
  already established.
- **`apps/api/src/routes/billing.ts`** (new): leader-gated (direct
  `role === 'leader'` check, same as `guests.ts` — no `billing`
  permission resource exists by design). `GET /` (summary), `GET /raw`
  (the bare `org_billing` row, for "does this org have a paid row at
  all" — distinct from the always-at-least-free-defaults summary),
  `GET /invoices`, `POST /checkout`, `GET /checkout/callback`
  (server-verified UI feedback only — the webhook remains the actual
  source of truth, applied asynchronously and independently).
- **`apps/api/src/services/automationJobs.ts`**: added
  `runBillingGraceCheck`, deliberately **not** added to `IMPLEMENTED_JOBS`
  — it has no `AUTOMATION_CONTROL_KEYS` toggle and is never org-optional,
  unlike the nine §12 jobs that dictionary drives. Own tiny dispatch loop
  against `list_billing_past_due_for_grace_check()` instead of
  `listEnabledOrgIds`. Transitions an expired-grace `past_due` row to
  `pending_review` (§1's decision: grace period, THEN mandatory manual
  review — never an automatic suspend); `grace_period_ends_at` is left
  in place, not cleared, so the review queue can show how overdue it is.
- **`apps/api/src/routes/billingMaintenance.ts`** (new): `POST /run`,
  same shared-secret shape as `automationMaintenance.ts`/
  `calendarMaintenance.ts`, but its **own** secret
  (`BILLING_MAINTENANCE_SECRET`) rather than reusing
  `AUTOMATION_MAINTENANCE_SECRET` — billing enforcement and the §12 job
  panel are different trust boundaries operationally.
- **`database/migrations/0025_billing.sql`**: extended with two more
  `nexus_bootstrap` functions for the Super Admin review queue —
  `list_billing_pending_review()` (joins `organizations` for `org_name`,
  same shape as the grace-check listing function beside it) and
  `resolve_billing_review(...)` (Super Admin's one write to close out a
  `pending_review` row — comp back to the existing tier, manual
  downgrade to free, or manual suspend; always clears
  `grace_period_ends_at` on resolution regardless of which way it goes).
- **`apps/api/src/routes/admin/superAdmin.ts`**: `GET
  /billing/review-queue` and `POST /billing/review-queue/:orgId/resolve`,
  same `requirePlatformAdmin` gate and `logPlatformActionSafely` audit
  posture as every other route in this file.
- **`apps/api/src/server.ts`**: registered `registerBillingRoutes`
  (`/api/v1/billing`), `registerBillingWebhookRoutes`
  (`/api/v1/billing/webhook`, public), `registerBillingMaintenanceRoutes`
  (`/api/v1/billing/maintenance`, public/shared-secret) — same
  "webhook and maintenance sibling routes, different trust levels, all
  registered together" block shape `calendar.ts`'s own three routes use.
- **`apps/api/.env.example`**: `PAYSTACK_SECRET_KEY`,
  `PAYSTACK_PLAN_CODE_STARTER`, `PAYSTACK_PLAN_CODE_PRO`,
  `BILLING_MAINTENANCE_SECRET` — each with the same "what calls this,
  what happens if it's unset" comment style as the vars around it.
- **`apps/api/src/services/aiService.test.ts`**: added a
  `checkAiUsageLimit` mock (Session 47's own `completeAndRecord` change
  calls it before `resolveProviderForOrg`) — without this, 9 tests in
  this file failed on `ECONNREFUSED 127.0.0.1:5432` (the unmocked real
  call tried to hit a database that doesn't exist in the test
  environment). Caught by actually running `vitest run`, not by
  inspection.

### Verification
- `npm run typecheck` clean on both `apps/api` and `apps/web` against
  the full merged tree (not just the files touched this session — the
  fork-reconciliation risk above made a full-tree check worth the extra
  minute).
- `npm run test -w apps/api`: 177/178 passing after the
  `aiService.test.ts` mock fix above. The one remaining failure
  (`chat.test.ts`'s SSE stream test, 5s timeout) is the same
  long-standing flake Session 46's own "Next steps" already listed as
  open — confirmed unrelated to this session's changes, not a new
  regression.
- Not run: an actual round-trip against a real Postgres instance (no
  `DATABASE_URL` available in this session's environment) — the
  `0025_billing.sql` additions (`list_billing_pending_review`,
  `resolve_billing_review`) are unverified against real Postgres, same
  outstanding gap as the rest of this migration per the prior session's
  own notes. A live Paystack sandbox round-trip (checkout → webhook →
  `org_billing` state change) is also unverified — no Paystack test
  keys available here.

### Not built / explicitly deferred
- Real NGN pricing — `BILLING_TIERS` still ships placeholder kobo
  amounts, flagged as such in `packages/shared/src/index.ts`'s own
  header comment (unchanged from the prior session).
- Usage-based overage billing / proration — out of scope per
  `0025_billing.sql`'s own header, unchanged.
- Frontend: no Billing page UI, no Super Admin review-queue screen. This
  session is backend-only (routes + services + migration additions);
  `SuperOrganizations.tsx` and a new Settings > Billing screen are the
  natural next UI pass, same "backend routes land before the screen
  that calls them" ordering `invites.ts`'s own header describes for its
  own history.
- `org_memberships` revoke has no code path anywhere in this codebase
  yet (checked — grepped for it), so `recomputeSeatCount`'s third
  intended trigger point (membership revoke, alongside invite-accept and
  guest-create) has nothing to wire against yet. Not a gap introduced
  this session — there is no revoke feature to hook into.

### Next steps
1. Real Postgres round-trip for the full `0025_billing.sql` file
   (original schema + this session's two new review-queue functions) —
   still never verified against a live database, same standing gap this
   entry inherited.
2. Paystack sandbox round-trip: `/checkout` → complete a test payment →
   confirm the webhook fires, signature verifies, `org_billing` updates,
   `billing_invoices` gets a row.
3. Settings > Billing UI (leader-facing) and a Super Admin review-queue
   screen (`SuperOrganizations.tsx` or a new sibling) — no frontend work
   done this session.
4. Tests for `billingWebhookService.ts`, `paystackProvider.ts` (signature
   verification especially), `routes/billing.ts`, and the new
   `superAdmin.ts` review-queue routes — none written yet, following
   this codebase's existing per-service `.test.ts` convention.
5. Configure a real external scheduler hit against
   `POST /billing/maintenance/run` (same standing gap
   `automationMaintenance.ts`'s own jobs have per Session 46's notes —
   nothing calls any of these maintenance routes automatically yet).
6. `companyArchiveCache.ts` test coverage — still open, several sessions
   running.
7. `chat.test.ts` SSE timeout — still open, several sessions running,
   reconfirmed unrelated to billing this session.

---

## Session 48 — Phase H (PRD §17.1) closed out: the actual scheduler

Session 46 built the seven job bodies and the shared-secret trigger
route; Session 47 added an eighth trigger (billing grace check) the
same way. Both sessions' own "Next steps" ended on the same open item:
"configure a real external scheduler ... nothing calls this route
automatically yet." That's the one thing this session does — no job
logic, no route changes, nothing in `apps/api` touched at all.

### Added
- **`apps/scheduler`** (new workspace app) — a small standalone
  long-running Node process that IS the external scheduler
  `automationMaintenance.ts`, `calendarMaintenance.ts`, and
  `billingMaintenance.ts` were all written to expect, per their own
  header comments ("an external scheduler is the caller, not something
  running inside the API process itself"). Built with `node-cron`
  rather than n8n Cloud or `cron-job.org` for the same ₦0-budget
  reasoning (PRD §18) the rest of this repo already follows — both of
  those remain valid drop-in alternatives later; this doesn't change
  either maintenance route, it's just one more thing that can call
  them.
  - `src/jobs.ts`: the schedule as plain data — nine §12 job times
    (08:00/08:05/09:00/16:00/18:00/18:05/23:00, from
    `AUTOMATION_CONTROL_KEYS`'s own comment), the calendar
    reconciliation sweep (every 30 min, this app's own default — PRD
    §10.5 names no cadence), and the billing grace check (07:00 daily,
    ahead of the other daily jobs, chosen because the grace window
    itself is 7-day/day-granularity per `billingWebhookService.ts`).
    `daily_recurring_tasks` and `hourly_follow_up` are listed with
    `implemented: false` and are NOT scheduled — same schema-gap
    reasoning `automationJobs.ts`'s own `UNIMPLEMENTED_JOBS` already
    established, not a new decision.
  - `src/index.ts`: registers one `node-cron` task per implemented job,
    each firing a single `POST` with `X-Nexus-Maintenance-Secret` at the
    matching route. `noOverlap: true` on every task (a slow calendar
    sweep must never stack a second one on top of itself). Per-job cron
    override via env (`CRON_DAILY_OVERDUE_CHECK` etc.) without a code
    change. `RUN_ON_START` for a one-time smoke test right after deploy
    or a secret rotation. Holds no database credentials — only
    `API_BASE_URL` and the three existing maintenance secrets
    (`AUTOMATION_MAINTENANCE_SECRET`, `CALENDAR_MAINTENANCE_SECRET`,
    `BILLING_MAINTENANCE_SECRET` — read from its own `.env`, must match
    `apps/api`'s values, not new secrets).
  - `Dockerfile`, `.env.example`, `README.md` — deploy as a systemd
    unit, its own Docker container, or any other single-long-running-
    process mechanism; explicitly documented as needing exactly one
    running instance (two would double-fire every job — the maintenance
    routes are not safe against a genuine concurrent double-call).
- **Root `package.json`**: `dev:scheduler` script; `build`/`typecheck`
  now include `apps/scheduler` (not added to `lint`/`test` — no ESLint
  config or test files exist for this app yet, unlike `apps/api`/`apps/web`).

### Not built / explicitly deferred
- No retry/backoff on a failed run — the next scheduled slot is the
  retry, given every job body underneath is already per-org
  fault-isolated (`dispatchToEnabledOrgs`) and the calendar sweep /
  billing grace check are themselves idempotent re-checks.
- No alerting integration (PagerDuty/Slack/etc.) — `pino` logs only,
  meant to feed whatever log-based alerting this deployment already has
  rather than a bespoke second path.
- No multi-instance coordination/locking — one instance only, by design
  (see README.md's own note on why two would double-fire jobs).
- `docker-compose.yml` at the repo root was deliberately left untouched
  — it's Postgres-only by design (DEPLOYMENT.md), and neither `apps/api`
  nor `apps/web` has a Dockerfile of their own either; adding a
  scheduler-only compose service would have been inconsistent with how
  every other process in this repo is actually run. `apps/scheduler`'s
  own `Dockerfile` is there for whoever containerizes this later.

### Verification
- `npm view node-cron` confirmed the v4 API shape (`schedule`,
  `validate`, `ScheduledTask.stop()`, `TaskOptions.timezone`/`noOverlap`)
  against its actual shipped `.d.ts` before writing `index.ts` against
  it, not from memory.
- Not run: `npm run typecheck -w apps/scheduler` / a live run against a
  real `apps/api` instance — no running API instance or installed
  `node_modules` for this new workspace in this session's environment.
  Both are a plain `npm install && npm run typecheck -w apps/scheduler`
  away; nothing else in the repo was touched, so this doesn't carry the
  same "full-tree" risk Session 47's own verification note flagged for
  itself.

### Next steps
1. `npm install` at the repo root (pulls in `apps/scheduler`'s new
   `node-cron`/`pino`/`tsx` deps) then `npm run typecheck -w
   apps/scheduler` — not yet run in this session's environment.
2. Deploy one instance somewhere that can reach `apps/api`, point
   `.env` at the same three secrets, confirm via `GET
   /api/v1/automation/health` that `lastRun` starts populating for the
   seven implemented §12 jobs (real end-to-end confirmation, not just
   this process's own logs).
3. ESLint config + tests for `apps/scheduler`, following the
   per-package convention `apps/api`/`apps/web` already use, if this
   app grows beyond its current single-file runner.
4. `companyArchiveCache.ts` test coverage — still open, several
   sessions running, unrelated to this session.
5. `chat.test.ts` SSE timeout — still open, several sessions running,
   unrelated to this session.

---

## Session 49 — Phase J (PRD §15) started: offline write queue, form drafts

Session 48 closed out Phase H. This session starts Phase J (Offline /
PWA) — specifically the two pieces PRD §15 names that had no code
anywhere in this repo yet: the offline write queue and IndexedDB-backed
per-form draft persistence. The service worker and its stale-while-
revalidate GET caching (also §15) already existed before this session —
`public/sw.js` and `utils/registerServiceWorker.ts` were untouched here.

### Added
- **`apps/web/src/services/offlineQueue.ts`** — generic IndexedDB-backed
  offline write queue. Same house style as `companyArchiveCache.ts`
  (Session 8): module-memoized `indexedDB.open` connection, promisified
  requests, degrades to inert (not silently — see below) if IndexedDB is
  unavailable. Unlike that cache, this queue's writes are load-bearing,
  so failures aren't swallowed the way a cache-miss is.
  - `enqueueWrite` / `listQueuedWrites` — CRUD on the `writes` object
    store, keyPath `id` (`crypto.randomUUID()`, matching
    `fileService.ts`/`calendarSyncService.ts`'s existing convention).
  - `drainQueue(send)` — replays queued writes oldest-first via a
    caller-supplied `send` function. A write that succeeds is removed
    and emits a `synced` event. A write that fails with a real
    `ApiError` (validation failure, stale reference, permission change
    since queuing) is *also* removed but emits `rejected` — retrying a
    definitively-rejected write forever would just fail identically
    every time, and silently dropping it without telling anyone would
    hide a lost edit. Anything else (still offline, a transient network
    error) stops the drain for that pass, leaving that write and every
    write after it queued — replaying out of order risks applying a
    later edit before an earlier one it may depend on.
  - `subscribeToQueueEvents` — a minimal pub/sub so `App.tsx` can turn
    drain results into toasts without this module needing to know React
    exists, mirroring the "small purpose-built wrapper, not a framework"
    posture `companyArchiveCache.ts`'s own header comment argues for.
  - Registers its own `window.addEventListener('online', ...)` to
    trigger a drain — the whole sync trigger for v1. No Background Sync
    API registration: patchy browser support, and it needs its own
    service-worker message plumbing to hand the queue over, which is a
    bigger lift than a `node-cron`-sized codebase phase deserves right
    now. A drain is also attempted once from `App.tsx` on authenticated
    mount, to catch writes queued in a previous tab session where
    connectivity was already back by the time this tab loaded.
  - Statically imports `replayQueuedWrite` from `apiClient.ts`, which in
    turn statically imports `enqueueWrite` from here — a genuine
    circular ES module import, confirmed safe (both sides only touch the
    other's export from inside a function body, never at module-
    evaluation time) via `npm run build -w apps/web`. A dynamic
    `import()` was tried first specifically to dodge the cycle; Vite's
    own build output pointed out it bought nothing (`apiClient.ts` is
    already pulled into the same chunk by every other static importer
    in this app), so it was simplified back to a plain import.
- **`apps/web/src/services/formDraftStore.ts`** — generic
  `saveDraft(formId, values)` / `restoreDraftIfAny(formId)` /
  `clearDraft(formId)`, IndexedDB, one row per `formId`. Named to match
  PRD §4's own `saveDraft`/`restoreDraftIfAny` vocabulary for the MVP's
  pattern — there's nothing to literally port from that old `code.gs`/
  `index.html` app into this repo, so this is a fresh implementation of
  the same *contract*, not a migration of existing local code. Debounce
  timing is a caller concern, not this store's — `EodReport.tsx` below
  debounces its own `saveDraft` calls at 500ms, a v1 default with no PRD
  number behind it.
- **`apiClient.ts`**: `postQueueable<T>(path, body, kind)` — like
  `apiClient.post`, but if the browser is offline or the POST fails at
  the network level (not a real server response), the write is queued
  via `offlineQueue.enqueueWrite` and this throws `QueuedOfflineError`
  instead of resolving. A real `ApiError` (validation, 403, etc.) is
  rethrown unchanged — only a genuine connectivity problem ever results
  in a queued write. `QueuedOfflineError` carries the queue id and a
  ready-to-show message. Also added `replayQueuedWrite`, the raw
  re-send `drainQueue` calls — deliberately not routed back through
  `postQueueable`, so a still-offline replay attempt fails straight back
  to `drainQueue` instead of re-queueing a write that's already queued.
- **Wired the two call sites confirmed clean before touching anything**
  (grepped for every caller of `createTask` and `submitEodLog` first —
  each has exactly one):
  - `taskService.ts`'s `createTask` → `postQueueable('/tasks', ...)`.
    `updateTask`/`archiveTask` are untouched — still fail outright
    offline, a deliberate scope cut, not an oversight.
  - `eodService.ts`'s `submitEodLog` → `postQueueable('/eod', ...)`.
  - `TaskSection.tsx`'s `handleCreate` — catches `QueuedOfflineError`
    specifically: closes the modal, shows the message as a neutral
    (`'default'`) toast rather than `'danger'`, and deliberately does
    *not* call `load()` — the queued task doesn't exist server-side yet,
    so a reload would just show the list unchanged rather than reflect
    what the user believes just happened.
  - `EodReport.tsx`'s `handleSubmit` — same `QueuedOfflineError` catch.
    Since there's no real `EodLog.id` yet, a queued submission can't be
    prepended to `logs` or used as a proof-file `resourceId`. If a proof
    file was attached, it's explicitly dropped (the queue stores
    JSON-serializable write bodies, not a second multipart upload
    alongside them) and the toast says so — "please re-attach it once
    you're back online" — rather than silently losing it. The EOD text
    itself is still safely queued regardless.
- **`EodReport.tsx` draft auto-save** — closes this file's own
  previously-standing comment ("no per-form draft persistence layer yet
  in this codebase, so it's session-only here"). `summary` + `filingFor`
  are saved (debounced 500ms) as the user types and restored on mount,
  keyed `eod-report:${todayIso()}` so a draft never bleeds across days.
  Cleared on successful submit and on a queued-offline submit (the
  queued write itself is now the durable copy). The proof-file
  attachment is deliberately *not* part of the draft — a `File` handle
  doesn't survive a real close/reload via IndexedDB structured-clone in
  any way this codebase already has a pattern for, and re-attaching
  after an accidental reload is judged an acceptable v1 gap the text
  recovery doesn't have.
- **`App.tsx`**: `useOfflineQueueToasts()` — subscribes to
  `offlineQueue.subscribeToQueueEvents` inside `AuthenticatedApp` (inside
  `ToastProvider`, only mounted once logged in) and calls `drainQueue`
  once on mount. `synced` → success toast per write; `rejected` → danger
  toast with the server's own rejection message, surfaced separately
  from whatever neutral "saved offline" toast already came and went at
  queue time.

### Not built / explicitly deferred
- `sw.js` / `registerServiceWorker.ts` untouched — PRD §15's stale-
  while-revalidate + offline-read-cache requirement was already covered
  by the existing service worker (ported from the MVP, per its own
  header comment), so nothing here needed changing.
- No Background Sync API — see `offlineQueue.ts`'s own reasoning above;
  the `online` event plus an on-mount drain is the whole v1 sync
  trigger, foreground-tab only.
- Every mutation besides `createTask` and `submitEodLog` is still
  unqueued (`updateTask`, `archiveTask`, and every other service's
  post/patch calls) — PRD §15 describes the capability, not "every write
  everywhere" as a day-one requirement, and each caller wired into the
  queue needs its own "it didn't happen yet" UI handling, not just a
  find-and-replace on `apiClient.post`.
- No "pending sync" UI anywhere (a badge/list of currently-queued
  writes) — `QueuedWrite.kind` is stored for exactly this future use but
  nothing reads it yet.
- Proof-file attachments are out of scope for both the draft store and
  the offline queue — see `EodReport.tsx`'s own reasoning above in both
  cases.
- No tests for `offlineQueue.ts` or `formDraftStore.ts` — this codebase
  has no IndexedDB testing precedent yet (`companyArchiveCache.ts` test
  coverage has been an open item for several sessions per this log's own
  running list below), so a `fake-indexeddb`-based test setup wasn't
  invented unilaterally for this session.

### Verification
- `npm run typecheck` (full tree: web, api, scheduler) — clean.
- `npm run build -w packages/shared` then `-w apps/web` — clean; initial
  build surfaced a Vite warning about the `apiClient.ts` ↔
  `offlineQueue.ts` circular import via a dynamic `import()`, which led
  to simplifying it to a plain static import (see `offlineQueue.ts`'s
  own note) — the warning is gone on rebuild.
- `npm run test -w apps/web` — 1 file, 3 tests, all passing (unchanged
  from before this session; no new tests added, see above).
- `npm run lint -w apps/web` — 0 errors, 4 warnings, all four pre-
  existing and in files/lines this session didn't touch
  (`Toast.tsx`, `CrudSection.tsx`, and two in `TaskSection.tsx` unrelated
  to the `handleCreate` edit made here).
- Not run: a real browser round-trip (devtools offline toggle → create a
  task → toast → reconnect → drain → synced toast; same for an EOD
  submission with and without a proof file). Typecheck/build/lint/test
  all pass, but none of them actually exercises IndexedDB or the
  `online`/`offline` browser events — this is the same class of gap
  Session 24's own notes flagged for Postgres ("verify against a real
  instance, not just TypeScript checks catches"), just for the browser
  side this time.

### Next steps
1. Manual browser smoke test: devtools "Offline" throttling, create a
   task, confirm the neutral toast and the queued row in
   `nexus-offline-queue`'s IndexedDB store (devtools → Application →
   IndexedDB), go back online, confirm the `synced` toast and that the
   task now appears via a real reload. Same for `EodReport.tsx`, with
   and without a proof file attached.
2. `fake-indexeddb`-based unit tests for `offlineQueue.ts` (queue/drain/
   reject-vs-retry branching) and `formDraftStore.ts` — new territory
   for this codebase's test suite, not just filling in an existing
   pattern.
3. Decide whether `updateTask`/`archiveTask` (and other single-call-site
   writes elsewhere) get wired into the same queue, or whether Phase J
   stays scoped to create/submit-style writes only — a real product
   decision, not just an engineering follow-up.
4. A "pending sync" indicator somewhere in the UI (`QueuedWrite.kind` +
   `listQueuedWrites()` are already there to support it) — nothing
   currently tells a user their queue isn't empty except the toasts at
   queue-time and drain-time.
5. `companyArchiveCache.ts` test coverage — still open, several sessions
   running, unrelated to this session.
6. `chat.test.ts` SSE timeout — still open, several sessions running,
   unrelated to this session.

## Session 9 (ADMIN_BUILD_GUIDE.md's own deferred session) — testing, hardening, final report

`ADMIN_BUILD_GUIDE.md` §3 names a "Session 9 — Testing, hardening, final
report" as the sign-off gate before any Phase 2 work (billing,
impersonation, advanced analytics) touches the org/admin/guest/project
foundation. It was never run — Sessions 46-49 (billing, scheduler,
offline queue) all shipped without it. This session runs it, against
what's actually achievable in this environment (no live Postgres, no
browser — see "Not run" below for exactly where that leaves real gaps).

### Regression pass
- `npm run typecheck` (web, api, scheduler) — **found one real bug**:
  `userPreferencesService.ts`'s `setThemePreference` indexed
  `rows[0].theme_preference` on an `update ... returning` with no
  null-row handling, unlike its own `getThemePreference` a few lines up.
  A write matching zero rows (stale/invalid session userId under RLS)
  would have thrown an unchecked-index TS error at build time — fixed by
  throwing explicitly instead of indexing blind, consistent with this
  codebase's own "write paths throw, read paths degrade" split
  (`authService.ts`'s 401-vs-throw posture, cited in its own comment).
  Clean after the fix.
- `npm run lint` (web, api) — 0 errors, 8 warnings, all pre-existing and
  already on this log's running list (`ThemeContext.tsx`, `Toast.tsx`,
  `CrudSection.tsx`, `TaskSection.tsx` ×2, `network.ts` ×2,
  `calendarTokenService.ts`).
- `npm run test -w apps/web` — 3 tests, unchanged, all passing.
- `npm run test -w apps/api` — **found and fixed the `chat.test.ts` SSE
  timeout** that's been on this log's open-items list for ten-plus
  sessions. Root cause: the one happy-path test for `GET /stream`
  (`'lets the task assignee open the stream...'`) used `app.inject()`
  against a route that calls `reply.hijack()` and holds the connection
  open indefinitely (heartbeats, no `res.end()`) — `inject()`'s promise
  never resolves against a hijacked response that never closes, so the
  test just ran out its 5000ms timeout every single run. This
  contradicted the file's own header comment, which already documented
  that a hijacked stream can't be asserted through `inject()`. Fixed by
  binding a real ephemeral listener (`app.listen({ port: 0 })`) and
  using `fetch` + `AbortController` to read the status/headers the
  instant they arrive, then walking away — the only way to observe a
  hijacked response's happy path without waiting on a connection
  designed to never close on its own. All 22 cases in the file now pass
  in ~2.7s (previously timed out at 5s on this one case alone). Full
  suite: 20 files, 239 tests, all passing.

### Coverage gap found and closed: `organizationService.ts` had no test file
Every other authorization surface in this codebase has direct test
coverage (`authorizationService.test.ts`, the three `admin/*.test.ts`
route files, `projects.test.ts`'s guest-scoping cases) — but
`organizationService.ts`, the service that owns group/company CRUD, the
Super Admin plan-change authority (guide §1), and — specifically — the
`listCompaniesInGroup` query every group-scoped read in this repo
ultimately trusts, had never been tested directly. This is exactly the
guide's own Session 9 checklist item "analytics attribution tests (null
group for independent companies, correct company/group tagging)" —
nothing pinned that query's behavior down until now.

Added `organizationService.test.ts` (22 tests, same mocked-db.js
posture as `authorizationService.test.ts`): platform-admin gating on
create/update-plan/deactivate/assign-to-group; the group-vs-company
`parentOrgId` validation branches on create and assign; the
plan/active-vs-name authority split in `updateOrganization` (a same-org
leader can rename, but not touch plan/active; `group_read` scope cannot
rename a child company — read-only per `canReadOrg`'s own contract);
`assignCompanyToGroup(..., null)` making a company independent again
without ever issuing a destination-group validity query; and, the
specific case this pass exists to close,
`listCompaniesInGroup` scoping its query to `parent_org_id = $1` under
the target group's own `withOrgContext` — pinning down that an
independent company's null `parent_org_id` structurally cannot satisfy
that clause, so it can never be attributed to a group's aggregate no
matter what RLS or the caller's authorization allows through.

### What Session 9's checklist otherwise already had covered (verified, not (re)built this session)
- **Full isolation suite (org axis)** — `authorizationService.test.ts`
  already covers group-vs-group, group-vs-independent-company,
  cross-group-sibling, and company-admin-cross-company, all as direct
  unit tests on `canReadOrg`/`hasPermission`/`withAuthorizedOrgContext`.
- **Guest axis** — `authorizationService.test.ts`'s "no default grant"
  cases plus `projects.test.ts`'s three guest-specific cases
  ("falls back to their own project(s) via membership", "reaches it via
  the membership fallback", "sees only their project(s) — a different id
  404s, not 403") already exercise the fifth scenario the guide's
  Session 1 entry flagged as untestable at the time (project_memberships
  didn't exist yet).
- **Route-level 403 gating** — `superAdmin.test.ts`,
  `groupAdmin.test.ts`, `companyAdmin.test.ts` each already run every
  route in their file against a non-admin session via `it.each`, per
  each file's own "no silent pass-through" framing.
- **Audit log** — `auditLogService.test.ts` covers both the write path
  and the "never throws even when the underlying write fails" guarantee
  (`logOrgActionSafely`/`logPlatformActionSafely`).
- **AI usage** — `aiService.test.ts` covers the provider-interface
  change from Session 39; `aiUsageService.ts` itself still has no
  dedicated test file (same gap class as `organizationService.ts` was
  before this session — not closed here, see "Not built" below).

### Not built / explicitly deferred (this session's own scope cut)
- `aiUsageService.ts` test coverage — same shape of gap
  `organizationService.ts` had; not closed this session, flagged instead
  of silently left off this list.
- `companyArchiveCache.ts` test coverage — still open, unchanged from
  prior sessions' notes (still no `fake-indexeddb` precedent in this
  codebase).
- `offlineQueue.ts`/`formDraftStore.ts` test coverage (Session 49's own
  next-step #2) — same reason, not this session's scope.
- Impersonation (guide's own Session 11) — deliberately not started.
  Session 9 is the gate Phase 2 is supposed to clear *before*
  impersonation (among other things) gets built on top of an unverified
  permission model; starting it in the same pass as the hardening gate
  itself would defeat the point.

### Verification
- `npm run typecheck` (web, api, scheduler) — clean, after the
  `userPreferencesService.ts` fix above.
- `npm run lint` (web, api) — 0 errors, 8 pre-existing warnings.
- `npm run test -w apps/web` — 3 tests, passing.
- `npm run test -w apps/api` — 20 files, 239 tests, passing (217 prior +
  22 new in `organizationService.test.ts`).
- **Not run: real Postgres.** No `docker`/database available in this
  environment — every isolation/attribution claim above is verified at
  the mocked-query-logic level (which query runs, with which params,
  gated by which check), the same limitation
  `authorizationService.test.ts`'s own header comment already flags for
  itself. RLS enforcement itself (0016's widened `organizations` policy,
  0020's write-path functions) was last confirmed live against a real
  instance in Session 27/40 — not re-verified here.
- **Not run: a real browser round-trip.** Same standing gap Session 49
  flagged for the offline queue; unrelated to this session's scope but
  still open.

### Sign-off status
Regression-clean (typecheck/lint/full test suite), two real bugs found
and fixed (one latent type-safety gap, one ten-plus-session-old broken
test), one real coverage gap closed (`organizationService.ts`). Given
the "not run" items above — no live-Postgres isolation pass, no browser
round-trip — this is a genuine hardening pass, not the guide's full
"sign-off before anything past this is touched" bar in the strictest
sense. Phase 2 work already shipped (billing in Session 47) before this
pass ever ran, so this closes the gate late rather than on time; treat
the live-Postgres isolation pass as the one item that would need to run
against a real environment before impersonation (guide's Session 11)
specifically, given that's the highest-blast-radius item still on the
Phase 2 list.

### Next steps
1. Live-Postgres isolation pass — the one gap this session's sandbox
   genuinely could not close. Run this repo's own isolation-relevant
   test files against a real instance the way Session 27 did for
   migrations/RLS, before impersonation (guide Session 11) starts.
2. `aiUsageService.ts` test coverage — flagged above, not closed this
   session.
3. `companyArchiveCache.ts` / `offlineQueue.ts` / `formDraftStore.ts`
   test coverage — still open, unchanged.
4. Apple Developer account enrollment — still unresolved as of the last
   log entry that mentioned it (Session 27); no update since.

## Session 9 (cont'd) — test coverage + live-Postgres isolation pass
Closes out next-steps #1–#3 from the entry above. Not run in this same
sandbox — carried in from prior work on this codebase and merged here;
recorded now since neither closure had made it into this log yet.

- `aiUsageService.ts`, `companyArchiveCache.ts`/`offlineQueue.ts`/
  `formDraftStore.ts` test coverage closed (next-steps #2/#3). Real bug
  found and fixed along the way: `companyArchiveCache.ts`'s
  `replaceCachedArchiveMetadata` awaited a promise keyed to
  `tx.onsuccess`/`tx.onerror` — `IDBTransaction` never fires `'success'`,
  so that await never settled and the function hung on every real call.
  Fixed by relying solely on `tx.oncomplete`, matching `cacheBlob`'s
  already-correct pattern in the same file. `fake-indexeddb` added as a
  first-time devDependency for this.
- Live-Postgres isolation pass closed (next-step #1) against real
  Postgres 16. Root-caused a two-layer RLS bug on `users`: the
  `tenant_isolation` policy had no explicit command, so Postgres reused
  its membership-`EXISTS` `USING` clause as `WITH CHECK` for INSERT too
  — impossible to satisfy for a brand-new user with no
  `org_memberships` row yet. Fixing INSERT alone wasn't sufficient:
  every real insert path uses `... returning id`, which Postgres also
  checks against the SELECT policy — same gap one layer down. Fixed in
  `0027_fix_users_insert_rls.sql` (split policy, `home_org_id`-based
  `WITH CHECK`, `home_org_id` branch added to SELECT). Two more real
  bugs found in the same pass: `guestService.ts` was inserting into a
  `users.org_id` column 0006 had already dropped; `seedClickthrough.ts`
  called `createSession` on the raw pool from inside a still-open
  `withOrgContext` transaction, causing an FK violation (new user row
  not yet visible cross-connection pre-commit) — fixed by moving session
  creation to after the transaction commits.
- **Not independently re-verified in this pass** — this entry documents
  work done in a different environment with real Postgres access; the
  migration and code changes were confirmed by static review here
  (read-through of `0027`'s logic, diff-verified against the actual
  repo state) but not re-run against a live instance from this sandbox.

## Session 11 — Impersonation (ADMIN_BUILD_GUIDE.md §5)
Unblocked by the live-Postgres isolation pass above, per the guide's own
gating criterion.

### What shipped
- `0028_impersonation.sql` — two new tables. `impersonation_grants`
  (own permission gate, deliberately separate from `platform_admins`
  and the group-leader rule — the guide is explicit that impersonation
  must never be a side effect of holding either). `impersonation_sessions`
  (actor, target user + org, required `reason`, `mode`
  `read_only`/`write`, linked to a real `sessions` row via `session_id`
  rather than adding columns to `sessions` itself, which stays minimal
  on purpose per its own RLS-bootstrapping role). `actor_name` is
  denormalized onto the row on purpose — see the migration's own
  comment on why a join back to `users` from `verifySession`'s
  pre-org-context position would hit the exact RLS chicken-and-egg trap
  this session's own prerequisite pass just fixed once already.
- `authorizationService.isImpersonationGranted()` — its own raw-pool
  check, same exemption class as `isPlatformAdmin()`.
- `sessionService.ts` — `SessionUser` gains an optional
  `impersonatedBy` (actor identity + mode), populated by `verifySession`
  via a second indexed lookup. `userId`/`orgId`/`role` continue to
  reflect the *target* — that's the point of impersonation, seeing
  exactly what they see — `impersonatedBy` is the separate trail.
  `createSession` now also returns the new row's `id` (backward
  compatible — existing callers destructure only the fields they use).
  New `revokeSessionById`.
- `impersonationService.ts` — `startImpersonation` / `endImpersonation`
  / `setImpersonationMode`, each its own `logPlatformActionSafely` entry
  (`impersonation.start` / `.end` / `.mode_change`). One active
  impersonation per actor at a time, enforced at start. `endImpersonation`
  and `setImpersonationMode` are scoped to the *current session's own*
  `impersonatedBy` context, not an id from the request body — the caller
  is, by construction, authenticated as the target, so there is exactly
  one impersonation it is ever valid for that request to act on.
- `plugins/impersonationGuard.ts` — global hook, registered right after
  `authPlugin`: blocks any non-GET/HEAD request while
  `impersonatedBy.mode === 'read_only'`, except the impersonation
  routes themselves (needed to end or elevate out of read-only at all).
  "Read-only by default" enforced once, centrally — no per-route opt-out.
- `auditLogService.ts` — `AuditLogInput` gains an optional
  `impersonatedBy` that gets folded into `metadata` at the one point
  both `logOrgAction` and `logPlatformAction` insert. `user_id` on the
  row is deliberately left as whatever the caller already passes (the
  target, during impersonation) — an org's own activity log should show
  the target's name, not leak that staff were behind the wheel; the
  actor's identity is the separate, additive field.
- `routes/admin/impersonation.ts` — `POST /start` (gated on
  `isImpersonationGranted`, not `isPlatformAdmin`), `POST /end`,
  `POST /mode`. Registered at `/api/v1/admin/impersonation`, its own
  prefix, not nested under `/admin/super`.
- `@nexus/shared` — `ImpersonationMode`, `ImpersonationContext`,
  `StartImpersonationInput`/`Response` wire types.

### Known follow-ups, not done this session
- No forced revocation of the target's own live sessions when
  impersonation starts. Two valid sessions per `user_id` is already a
  supported shape in this schema (no uniqueness constraint), reused
  rather than solved for — flagged as an open question, not a bug.
- No frontend banner/exit UI yet — `SessionUser.impersonatedBy` is the
  single signal a banner would key off of; not built this session.
- No new automated tests for `impersonationService.ts`, the new route,
  or the guard plugin — the existing 252-test suite is unchanged and
  green, but this session's own new code has zero coverage of its own
  yet. Same shape of gap this log has flagged for other services before
  landing tests a session later.

### Verification
- `npm run typecheck -w apps/api` — clean.
- `npm run lint -w apps/api` — 0 errors, 3 pre-existing warnings in
  unrelated files, unchanged.
- `npm run test -w apps/api` — 21 files, 252 tests, all passing
  (unchanged from before this session — no new tests added, see above).
- **Not run: real Postgres.** `0028_impersonation.sql` has not been
  applied against a live instance — no Postgres available in this
  sandbox. Everything above is a static read-through plus a clean
  mocked-suite/typecheck/lint pass, not a live confirmation that the
  migration applies cleanly or that `impersonation_sessions`' unique
  partial index and foreign keys behave as intended under real RLS.

### Next steps
1. Run `0028_impersonation.sql` against a real Postgres instance
   (docker compose, migrate, exercise start/end/mode-change end to end)
   before this ships — same bar the users-RLS fix was held to.
2. ~~Wire `impersonatedBy` into the existing audit call sites (see "Known
   follow-ups" above).~~ Done — see "Session 11 (cont'd) — audit-sweep
   + frontend banner/exit UI" below.
3. ~~Frontend impersonation banner + exit control.~~ Done — see the same
   entry below.
4. `aiUsageService.ts`/`companyArchiveCache.ts` etc. test coverage was
   already closed (see the entry above) — remaining open items from the
   original list: Apple Developer account enrollment (still
   unresolved), and now also test coverage for this session's own new
   files (`impersonationService.ts`, `routes/admin/impersonation.ts`,
   `plugins/impersonationGuard.ts`).

## Session 11 (cont'd) — audit-sweep + frontend banner/exit UI

### Audit call-site sweep
Grep-verified scope was narrower than the original "~15 files" estimate:
only `routes/admin/superAdmin.ts` has write-side audit calls
(`groupAdmin.ts`/`companyAdmin.ts` only call the read side,
`searchAuditLog`). All 5 `logPlatformActionSafely(...)` call sites in
that file now pass `impersonatedBy: user.impersonatedBy` alongside
`userId: user.userId`, so a write made during an impersonation is
attributed to the real actor in the audit trail, not just the target.
Added a header comment on the file establishing this as the convention
any future route file with write-side audit calls should follow.

### Frontend banner + exit control
`SessionUser.impersonatedBy` existed on the backend since the original
Session 11 but was never put on the wire — `GET /auth/session` had no
field for it, so the frontend had no signal to key a banner off of at
all, and zero impersonation-related code existed anywhere under
`apps/web`.
- `routes/auth.ts` — `/session` now includes a client-safe
  `impersonatedBy` (`impersonationId`, `actorName`, `mode`,
  `startedAt`) whenever the session is an active impersonation.
  Deliberately a narrower shape than the backend's own
  `ImpersonationContext` — no `actorUserId`, no target/session
  internals, only what a banner needs to render.
- `services/authService.ts` — matching `ImpersonationInfo` type,
  `CurrentUser.impersonatedBy?`.
- New `services/impersonationService.ts` (web) — `endImpersonation()`
  / `setImpersonationMode()`, thin wrappers over
  `POST /admin/impersonation/end` and `/mode`. No `startImpersonation()`
  wrapper — nothing in the frontend triggers a start yet; see "Not
  built" below.
- New `components/navigation/ImpersonationBanner.tsx` — sticky,
  warning-toned banner: actor name, a read-only/write mode badge, a
  mode toggle, and an "Exit impersonation" button. Exit calls `/end`
  then re-runs the app's existing `loadSession` (the same path a real
  logout already uses) — ending an impersonation clears the cookie the
  same way, so the next `GET /session` comes back anonymous and the
  actor lands on `LoginPage` to sign back in for real, matching
  `impersonationService.ts`'s own doc comment that the actor's original
  session is never force-revoked, just no longer active in this
  browser.
- `app/App.tsx` — banner rendered as a sibling above `.nx-app-shell`,
  not inside `.nx-app-main`, so `position: sticky` pins it to the real
  viewport top regardless of route/scroll state underneath.

### Not built / explicitly deferred (this pass's own scope cut)
- No "Start impersonation" trigger added anywhere (e.g.
  `SuperUsers.tsx`). That screen is explicitly documented, in its own
  header comment, as a deliberately read-only investigation surface —
  adding a target picker, reason capture, and mode choice there is a
  separate, larger piece of UI than closing the banner/exit gap, not a
  natural extension of it.
- No forced sign-out/redirect *during* an active impersonation if the
  grant is revoked mid-session — out of scope for this pass, unrelated
  to the banner itself.
- Still no automated tests for `impersonationService.ts` (either side),
  the impersonation routes, the guard plugin, or the new banner
  component — flagged in the original Session 11 entry, still open.

### Verification
- `npm run typecheck -w apps/api` — clean.
- `npm run typecheck -w apps/web` — clean.
- `npm run lint -w apps/api` — 0 errors, 3 pre-existing warnings in
  unrelated files, unchanged.
- `npm run lint -w apps/web` — 0 errors, 6 warnings, all pre-existing
  (`react-refresh/only-export-components` on files that export a small
  helper alongside a component — same shape `Toast.tsx` already had —
  plus two pre-existing `exhaustive-deps`/unused-var warnings unrelated
  to this change).
- `npm run test -w apps/api` — 21 files, 252 tests, all passing.
- `npm run test -w apps/web` — 4 files, 31 tests, all passing (no new
  test files this pass — see above).
- **Not run: real Postgres**, same caveat as the original Session 11
  entry — this sandbox has no live instance to exercise start → sweep →
  banner → exit end to end against.

### Next steps
1. Live-Postgres pass for the whole impersonation feature end to end
   (still open from the original Session 11 entry).
2. Decide where/how a "Start impersonation" flow belongs in the UI
   (`SuperUsers.tsx` drill-down, a separate admin action, etc.) before
   building it — deliberately not guessed at in this pass.
3. Test coverage for `impersonationService.ts` (both the API service
   and its new web-side wrapper), the impersonation routes, the guard
   plugin, and `ImpersonationBanner.tsx`.

---

## Session — Merge: Calendar Channel Renewal + Meetings UI

Two sessions branched from the entry immediately above without either
logging its own work — this entry covers both branches' content and
the merge itself, reconstructed from a file-level diff since there was
no session log to merge against.

### Branch A — Calendar push-notification channel renewal (backend)
- New `database/migrations/0036_calendar_channel_uniqueness.sql` —
  adds `list_expiring_channel_subscriptions()` and a partial unique
  index backing it.
- `calendarSyncService.ts` — new `renewExpiringChannels()`: clears a
  subscription's stale `channel_id`/`resource_id`/`channel_expires_at`
  then re-registers via the existing `maybeRegisterChannel`, for any
  Google push channel within 48h of its ~30-day expiry.
  `stopSubscriptionChannel` deliberately not called for renewal — that
  path is for deliberate teardown only, per its own comment.
- `routes/calendarMaintenance.ts` — new `POST /renew-channels`
  endpoint, same shared-secret auth pattern as the existing `/sweep`
  (duplicated rather than extracted — file is intentionally
  self-contained per its own comment).
- `apps/scheduler` — new `CALENDAR_CHANNEL_RENEWAL_JOB`, 02:00 daily,
  same `CALENDAR_MAINTENANCE_SECRET` as the sweep job, separate cron
  override env var (`CRON_CALENDAR_CHANNEL_RENEWAL`).
- Minor cleanup riding along: `meetingService.ts` and
  `packages/shared`'s `Meeting` type both tightened
  `inviteeUserIds` from optional to required `string[]`, matching the
  column's real not-null/`'{}'`-default constraint — removes a
  defensive `?? []` that was dead code.

### Branch B — Meetings module (frontend, PRD §8.2)
- New `apps/web/src/modules/comms-ops/Meetings.tsx` + new
  `apps/web/src/services/meetingService.ts` (web) — CRUD + list view
  for the `meetings` table, using the `agenda`/`inviteeUserIds`/
  `externalEmails` columns `0034_abion_demo_seed_gaps.sql` landed
  earlier. Deliberately its own IA subsection
  (`comms-ops/meetings`), not folded into the existing `calendar`
  subsection — that one is Work's Google Calendar event sync, a
  different resource with a different backend; same "closest existing
  section by shape, not a new numbered slot" call this repo already
  makes elsewhere for Knowledge > Company Docs.
- `RelationshipTable.tsx` gained an optional `rowClassName` prop
  (used by `Meetings.tsx`'s list view) — additive, every other caller
  unaffected.
- `apps/web/package.json` — added `lucide-react` for this module's
  icons.

### The merge
Both branches touched only disjoint files except three: `App.tsx`,
`ia.ts` (both additive-only hunks on Branch A's base — new
import/route/nav-entry, nothing removed) and
`packages/shared/src/index.ts` (real disagreement, see below).

**`inviteeUserIds` optionality — resolved in favor of Branch A's
stricter, required `string[]`.** Branch B's `Meetings.tsx` was written
defensively against the optional version (`m.inviteeUserIds ?? []`,
`m.inviteeUserIds?.length`) but neither expression is a type error
against a required array — the `??`/`?.` become redundant-but-valid,
not broken. Branch A's version is the more accurate one (it matches
the column's actual DB constraint, per its own comment) and keeping
the stricter type doesn't cost Branch B anything, so it wins without
needing to touch `Meetings.tsx`.

`package-lock.json` — took Branch B's version. Both branches'
`package.json` files were already identical (`lucide-react` present in
both), but Branch A's `package-lock.json` was missing the
corresponding `lucide-react` entry — i.e. out of sync with its own
`package.json`, not a real second source of truth. Branch B's lockfile
is the one that's actually consistent with what `package.json`
declares.

### Verification
- **Not run in this environment** — the uploaded archives were
  source-only (no `node_modules`), and this sandbox has no network
  access to the private package registry this monorepo would install
  against. The type-compatibility call above (`inviteeUserIds`) was
  checked by hand, not by running `tsc`.
- First real step after merging: `npm install && npm run typecheck
  --workspaces && npm run test --workspaces` end to end, since neither
  branch's own changes were verified against each other before now —
  only against their own individual base.

### Next steps
1. Run the full install/typecheck/lint/test pass above — nothing in
   this merge has been machine-verified yet.
2. No test coverage for `renewExpiringChannels()` / `POST
   /renew-channels`, or for `Meetings.tsx` / the web `meetingService.ts`
   — both landed without tests in their source sessions.
3. Both source sessions failed to log themselves in `SESSION_LOG.md`
   before being handed off — worth a standing reminder that "output
   the zip" doesn't skip that step.

---

## Session — Scheduler provisioning (n8n + cron-job.org) + Backups section recovered

- Found `DEPLOYMENT.md`'s Backups section (written two sessions ago)
  was missing from this branch, even though `.github/workflows/backup.yml`
  itself was present and byte-identical to the original — the workflow
  file carried through a prior merge/handoff but its write-up didn't.
  Re-added it verbatim rather than re-deriving it, plus a new
  Scheduler section alongside it.
- New `n8n/nexus-maintenance-schedule.json` — importable n8n workflow,
  Schedule Trigger + HTTP Request node pairs for the 7 implemented §12
  automation jobs, the calendar sweep, the calendar channel renewal
  (from the earlier merge), and the billing grace check. Secrets/API
  base URL referenced via n8n Variables (`$vars.*`), not `$env`, since
  n8n Cloud restricts raw env access by default. **Not verified against
  a live n8n import** — no instance available in this environment.
- New `scripts/setup-cron-job-org.mjs` — idempotent provisioning script
  against cron-job.org's REST API for the same job set, as the
  no-self-hosting alternative the guide also allows. Schema pulled from
  `docs.cron-job.org/rest-api.html` directly (fetched during this
  session, not recalled from memory) — job creation rate limits (1
  req/sec, 5/min) respected via a sleep between creates. **Not run
  against the real cron-job.org API** — no API key available here to
  exercise it end to end; ships with a `--dry-run` mode for that reason.
- Both options deliberately exclude `daily_recurring_tasks` and
  `hourly_follow_up` — real §12 keys, no implementation behind either
  yet (`UNIMPLEMENTED_JOBS`), so scheduling them now would only ever
  produce 501s.

### Next steps
1. Actually run one of the two options against a real deployment and
   confirm the first scheduled execution of each job succeeds — neither
   was exercised against live infrastructure in this session.
2. Re-derive or restore `SESSION_SCOPE_UI_REHAUL.md`/`SESSION_SCOPE_BRANDING.md`
   state the same way this entry had to recover the Backups section —
   worth a one-time audit that nothing else quietly dropped out across
   the recent branch handoffs.


