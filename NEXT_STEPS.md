# NEXT STEPS — regenerated from `SESSION_LOG.md` + direct repo verification

Previous version of this file was stale enough to steer a decision
wrong (it said "no billing frontend built at all" while
`Billing.tsx`/`SuperBilling.tsx` both exist, 520 lines combined) — this
version is checked against actual files in the repo, not just log
entries, since the log itself has at least one documented gap (work
done outside the logging sandbox and merged without its own entry —
see the billing-UI note below).

---

## A. This session's own work — needs a live check before it's "done"

### A0. Logout bug — hardened, not confirmed fixed
Static audit found no bug in cookie attributes, the revocation query,
or client-side sequencing — all internally consistent. Shipped two
defense-in-depth fixes that match the reported symptom (flash → still
logged in) regardless of exact cause:
- `routes/auth.ts` — `Cache-Control: no-store` on every `/auth/*`
  response (`onSend` hook).
- `public/sw.js` — fetch handler now explicitly excludes `/api/` and
  `/auth/` paths (previously relied on the origin check accidentally
  excluding them); `CACHE` bumped `v1` → `v2` so the byte change
  actually reaches browsers.

**Needs:** live check per the original devtools plan — Network tab on
the `GET /auth/session` right after logout (real transfer vs. "from
disk cache"/"from ServiceWorker"), Application → Cookies (more than one
`nexus_session` entry would point at a leftover-cookie cause these
fixes don't address), Application → Service Workers (confirm v2 is
actually controlling the page).

### A1. `task_assignees` (0032) — ✅ verified live (Session 51)
Migration applied on a fresh Postgres 16; the API was run against it as
the RLS-restricted `nexus_app` role. GET/POST/DELETE
`/tasks/:id/assignees` all behave as designed: 201 add, 409 duplicate,
204 remove, 401 no session, 403 for a team member not on the task
(read and write), 404 for a user from another org (RLS hides the task).
The `TaskDrawer.tsx` panel itself still needs a browser click-through.

### A2. UI rehaul — scoped only, build deliberately deferred
See `SESSION_SCOPE_UI_REHAUL.md`. Direction locked (full redesign,
demo/sellable-product framing, brand-accent/status-color token
separation resolved). Still open: identity concept (§2.2), dark/light
parity (§2.3), component API stability (§2.4), rollout shape (§2.6),
motion (§2.7). Not a build item until those get a real pass.

---

## B. Standing gaps — verified against the repo, not just log claims

### Actually closed since the last version of this file (log said open, repo says done)
- **`companyArchiveCache.ts` test coverage** — closed (`Session 9
  (cont'd)`). File exists, `fake-indexeddb` is a real devDependency. A
  real bug was caught along the way: `replaceCachedArchiveMetadata`
  awaited a promise keyed to `tx.onsuccess`, which `IDBTransaction`
  never fires — fixed to use `tx.oncomplete`.
- **`offlineQueue.ts` / `formDraftStore.ts` test coverage** — closed,
  same pass. Test files confirmed present.
- **`aiUsageService.ts` test coverage** — closed, same pass. Test file
  confirmed present.
- **`organizationService.ts` test coverage** — closed (`Session 9`,
  22 tests). Confirmed present.
- **`chat.test.ts` SSE timeout** — fixed (`Session 9`). Root cause was
  asserting a hijacked `reply.hijack()` stream through `app.inject()`,
  which never resolves against a connection that never closes. Fixed
  with a real ephemeral listener + `fetch`/`AbortController`. Confirmed
  present in the test file.
- **Users-table RLS bug** — found and fixed live against real
  Postgres 16 (`0027_fix_users_insert_rls.sql`, confirmed present):
  `tenant_isolation`'s missing explicit command meant the SELECT
  policy's `EXISTS` clause got reused as `WITH CHECK` for INSERT,
  unsatisfiable for a brand-new user. Two more real bugs caught in the
  same pass, both confirmed fixed in the current code:
  `guestService.ts` inserting into a `users.org_id` column
  `0006_org_hierarchy_memberships.sql` had already dropped (now uses
  `home_org_id` correctly), and `seedClickthrough.ts` calling
  `createSession` on the raw pool from inside a still-open
  `withOrgContext` transaction (moved to after commit).
- **Settings > Billing UI + Super Admin billing review queue** — both
  built (`Billing.tsx`, 331 lines; `SuperBilling.tsx`, 189 lines;
  `superAdmin.ts`'s `/billing/review-queue` GET + resolve routes all
  confirmed present). **Not documented anywhere in `SESSION_LOG.md`** —
  this is the specific gap that made the prior version of this file
  wrong. Worth a log entry next time anyone touches billing, so this
  doesn't happen again.

### Genuinely still open (verified absent, not just log-claimed)
**Testing:**
- No test files exist for `billingWebhookService.ts`,
  `paystackProvider.ts` (signature verification especially),
  `routes/billing.ts`, `impersonationService.ts` (either side),
  `routes/admin/impersonation.ts`, `impersonationGuard.ts`, or
  `ImpersonationBanner.tsx` — confirmed by direct search, none present.
- `automationMaintenance.ts` test coverage, `automation.ts`'s
  `GET /health` test coverage — not written (Session 46's own next
  step, no evidence since of it closing).
- ~~Standalone `tsc`/`vitest run` against the full workspace~~ —
  ✅ closed in Session 51: `npm ci`, `typecheck`, `lint` (0 errors),
  `test` (324 passing) and `build` all run clean on this tree.

**Live-Postgres / live-browser verification:**
- `0028_impersonation.sql` and `0025_billing.sql` — Session 51: both
  **apply cleanly** on fresh Postgres 16 (as do all 36 migrations, in
  order), but their RLS/function *behaviour* still hasn't been exercised
  live — that needs the impersonation and billing route tests listed
  under Testing above, run against a real instance.
- Offline write queue — no real browser round-trip yet (devtools
  Offline throttling → queue → reconnect → sync), same for
  `EodReport.tsx`'s file-attached case.
- Impersonation end-to-end (start → banner → mode toggle → exit) — no
  live-browser click-through yet.
- Paystack sandbox round-trip (`/checkout` → real test payment →
  webhook → signature verify → `org_billing`/`billing_invoices`
  update) — never done.
- ~~`task_assignees` (0032)~~ — ✅ verified live, see A1 above.

**Infrastructure not wired up:**
- No real external scheduler (n8n Cloud / cron-job.org) hits
  `POST /automation/maintenance/run/:jobKey` or
  `POST /billing/maintenance/run` — both routes exist, confirmed
  present, nothing calls them automatically.
- `apps/scheduler` has `node-cron`/`pino`/`tsx` as intended deps but has
  never been deployed anywhere that can reach `apps/api` — confirmed:
  no deployment config (`vercel.json`/`render.yaml`/etc.) exists
  anywhere in the repo for either app.

**Real product decisions still deferred:**
- "Start impersonation" UI trigger — confirmed absent from
  `SuperUsers.tsx` (that screen is documented, in its own header
  comment, as deliberately read-only). No target picker/reason-capture/
  mode-choice UI exists anywhere.
- No forced sign-out if an impersonation grant is revoked mid-session —
  confirmed absent from `impersonationGuard.ts`.
- Whether `updateTask`/`archiveTask` (and now `addTaskAssignee`/
  `removeTaskAssignee`, A1 above) join the offline write queue, or
  Phase J stays create/submit-only — undecided.
- A "pending sync" UI indicator for the offline queue — the underlying
  data (`QueuedWrite.kind`, `listQueuedWrites()`) exists; nothing
  surfaces it beyond toasts at queue/drain time.
- Abandoned-upload cleanup job for `fileService.ts` — confirmed still
  absent (comment in the file documents the gap, no job exists).

**Company-level branding (A1 in the old numbering, "org_branding")** —
scope locked (`SESSION_SCOPE_BRANDING.md`), confirmed **not built**: no
migration, no `brandingService.ts`, no routes anywhere in the repo.
Ready to build — nothing blocking it.

**Legacy demo-sheet → Postgres seed** — still blocked on the same
data-mapping decisions as before (no `tasks.priority` column, status/
onboarding/partnership value translation maps, per-person RBAC role
assignment), **and now also blocked on a missing input file**:
`ABION_NEXUS_Demo_Sheet.xlsx` isn't in this environment, so `gen_seed.py`
can't run regardless of the mapping decisions. `gen_seed.py`'s hardcoded
output path (`/home/claude/nexus/nexus29-final/...`) also doesn't match
this repo's actual root and needs fixing whenever this is picked back
up.

**Long-standing, unrelated to any recent session:**
- Apple Developer account enrollment — unresolved since Session 27,
  no update since (this is a manual, non-code action item).

---

*Regenerate this again once several of today's open items close, rather
than hand-editing piecemeal — that's exactly how the last version went
stale enough to be wrong about what existed.*
