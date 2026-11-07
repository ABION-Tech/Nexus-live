# Deployment — Database

NEXUS talks to Postgres directly (`apps/api/src/db.ts`, plain `pg`, no
Supabase SDK, no ORM). That's deliberate: whoever hosts the Postgres
instance is a `DATABASE_URL` decision, not a code dependency. Auth is
also self-contained (PRD §10.1 — Google OAuth + NEXUS's own sessions
table), so there's no Supabase Auth/Storage/Realtime coupling to unwind
later either. This doc is the two supported paths and how to move
between them.

## Path A — Supabase Cloud (recommended to start)

Zero infrastructure to run yourself. Free tier is enough to launch on —
500MB database is a lot of headroom for structured relational data at
70 users, and there's no idle-pause risk once the app is in constant use.

1. Create a project at supabase.com (free tier, no card required).
2. Settings → Database → Connection string → copy the `URI` form.
3. Set that as `DATABASE_URL` in `apps/api/.env`.
4. `npm run migrate -w apps/api`.

Upgrade to Pro ($25/mo) only when you actually approach the 500MB/50k
MAU ceiling, not preemptively — see SESSION_LOG for the reasoning.

## Path B — Self-hosted Postgres (no vendor, own the box)

Same `DATABASE_URL` shape, pointed at Postgres you run yourself. Two
sub-options:

**B1 — this repo's `docker-compose.yml` on any VPS** (Hetzner, Oracle
Cloud Always Free tier, Railway, a spare machine). Plain Postgres only —
no GoTrue/PostgREST/Realtime containers, since NEXUS doesn't use them.

```
docker compose up -d
# MIGRATION_DATABASE_URL=postgresql://nexus:<password-you-set>@<host>:5432/nexus
npm run migrate -w apps/api
# nexus_app now exists (created by 0001_init.sql) — point the app's own
# DATABASE_URL at it, never at the `nexus` role above:
# DATABASE_URL=postgresql://nexus_app:<password-from-0001_init.sql-or-your-own-ALTER-ROLE>@<host>:5432/nexus
```

`nexus` (the container's `POSTGRES_USER`) is a Postgres superuser by
construction — fine for running migrations, but RLS has no effect on a
superuser connection at all (DECISIONS.md §3). Pointing the *app's*
`DATABASE_URL` at `nexus` instead of `nexus_app` doesn't error or warn
anywhere — every tenant-isolation guarantee in this schema just silently
stops applying. Verified empirically during the Session 9 hardening
pass: identical query, `nexus` returns every org in the table with no
`app.current_org_id` set at all; `nexus_app` returns zero, as designed.
Change `POSTGRES_PASSWORD` in `docker-compose.yml`, and change
`nexus_app`'s password (`ALTER ROLE nexus_app WITH PASSWORD '...'`, then
update `DATABASE_URL` to match) before running this anywhere but a
laptop — `0001_init.sql`'s `change_me_in_env` default is exactly what it
says it is.

**B2 — full self-hosted Supabase stack**, if you specifically want
Supabase's Studio dashboard or plan to adopt Supabase Auth/Storage later.
Follow Supabase's own self-hosting docs (Docker Compose, ~10 containers).
Point `DATABASE_URL` at the Postgres container it stands up; everything
else in this repo is unaffected either way.

Either self-hosted option makes you responsible for backups, patching,
and uptime — budget real time for that, not just the server bill (PRD
§13.12 requires verified daily backups regardless of hosting choice).

## Moving between A and B later

Change `DATABASE_URL`, run `npm run migrate -w apps/api` against the new
target, move data over with `pg_dump` / `pg_restore` (or Supabase's own
export tool if migrating off Supabase Cloud). No application code changes
either direction — that portability is the point of not depending on a
Supabase-specific SDK in the first place.

## Backups (PRD §13.12)

`.github/workflows/backup.yml` runs a nightly `pg_dump` (custom format,
restorable with `pg_restore`) against `MIGRATION_DATABASE_URL` and
uploads it to a dedicated Cloudflare R2 bucket. Deliberately **not** the
app's own `STORAGE_*` bucket/creds — PRD §13.12 requires backup access
isolated from production application credentials, so a compromised app
credential can't also delete the backups.

**Note on Path A (Supabase Cloud) free tier:** Supabase's own automated
backups are a Pro-tier ($25/mo) feature — the free tier has none by
default. This workflow is what provides backups at all on the free
tier, not a supplement to something Supabase already does for you.
Confirm which situation you're actually in before assuming coverage.

**One-time setup:**

1. Create a Cloudflare R2 bucket for backups only (not the app's file
   storage bucket) and an R2 API token scoped to just that bucket.
2. In the bucket's settings, add a **lifecycle rule**: expire objects
   older than 30 days. This is the PRD §13.12 minimum-30-day retention
   requirement, enforced by R2 itself rather than script logic.
3. In the GitHub repo → Settings → Secrets and variables → Actions, add:
   - `MIGRATION_DATABASE_URL` — the same superuser-level connection
     string used for migrations (Path A or B above), **not** the app's
     runtime `DATABASE_URL`.
   - `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY` — the
     backup-only R2 token from step 1.
   - `BACKUP_R2_ENDPOINT` — your R2 account's S3-compatible endpoint URL.
   - `BACKUP_BUCKET` — the backup bucket name.
4. Trigger the workflow manually once (Actions tab → Nightly Postgres
   Backup → Run workflow) to confirm it succeeds before trusting the
   01:30 UTC schedule.

**Restore-test runbook (do this monthly — PRD §13.12 explicitly
distinguishes "backup exists" from "verified restorable"):**

1. Run the workflow manually so you're testing today's dump, not a
   30-day-old one.
2. Download the latest `.dump` object from the R2 bucket.
3. Spin up a scratch Postgres — either `docker compose up -d` from this
   repo against a throwaway `POSTGRES_DB` name, or a disposable Supabase
   project. Not the real production database.
4. `pg_restore --clean --if-exists -d <scratch-db-url> nexus_backup_<date>.dump`
5. Sanity-check row counts against production for a couple of
   high-traffic tables (`select count(*) from tasks`, `from users`) —
   they should match what production had at backup time.
6. Tear down the scratch instance.
7. Log the date, result, and how long the restore took in
   `SESSION_LOG.md`. The restore time you measure here is your real
   RTO — PRD §13.12 requires this be defined before cutover, and a
   number you've actually measured is worth more than an estimate.

## Scheduler (PRD §12 / §10.6)

`apps/scheduler` (in-process `node-cron`, its own `Dockerfile`) is one
option but isn't deployed by default. Two external alternatives exist
instead — pick one, don't run more than one against the same secrets
or the same job fires twice:

**Option 1 — n8n (PRD §5's named scheduler).** Import
`n8n/nexus-maintenance-schedule.json` into n8n Cloud (or a self-hosted
instance): Workflows → Import from File. Before activating it, set
these under n8n's **Variables** (Cloud: Settings → Variables — not
plain env vars, which n8n Cloud restricts `$env` access to by default):
`NEXUS_API_BASE_URL`, `AUTOMATION_MAINTENANCE_SECRET`,
`CALENDAR_MAINTENANCE_SECRET`, `BILLING_MAINTENANCE_SECRET`. Toggle the
workflow active once the variables are set. This file was generated
against n8n's documented node schema (Schedule Trigger + HTTP Request)
but has **not been round-tripped through an actual n8n import** in
this environment — no live instance was available to verify it opens
clean. Check the first scheduled run's execution log after import
before trusting the schedule unattended.

**Option 2 — cron-job.org (no self-hosting, simplest for a handful of
jobs).** Run `scripts/setup-cron-job-org.mjs` once:
```bash
CRON_JOB_ORG_API_KEY=<from console.cron-job.org Settings> \
API_BASE_URL=https://api.yourdomain.com \
AUTOMATION_MAINTENANCE_SECRET=... \
CALENDAR_MAINTENANCE_SECRET=... \
BILLING_MAINTENANCE_SECRET=... \
node scripts/setup-cron-job-org.mjs --dry-run   # then re-run without --dry-run
```
It's idempotent (checks existing job titles before creating) and
respects cron-job.org's own rate limits. Its request/response contract
was pulled directly from cron-job.org's published REST API docs at
build time, not from memory — still worth confirming the first job's
execution history in the console after the real run, same as Option 1.

**Both options deliberately schedule only the 7 real §12 jobs plus the
calendar sweep, calendar channel renewal, and billing grace check —**
`daily_recurring_tasks` and `hourly_follow_up` are left unscheduled.
Both are real PRD §12 keys but have no implementation behind them yet
(`services/automationJobs.ts`'s `UNIMPLEMENTED_JOBS`) — the endpoint
returns 501 for either, so scheduling them now would just be a cron
job that fires forever and never does anything. Add them to whichever
option you're using once they're actually built.
