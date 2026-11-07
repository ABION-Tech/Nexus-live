# @nexus/scheduler

The external scheduler that `routes/automationMaintenance.ts`,
`routes/calendarMaintenance.ts`, and `routes/billingMaintenance.ts`
were all designed for — per their own header comments — but that never
existed until now. Sessions 46 and 47 both shipped the job bodies and
the shared-secret trigger endpoints and both listed "configure a real
external scheduler" as an open next step; this app is that step closed.

## What it does

A small long-running Node process. On startup it registers one
`node-cron` schedule per job (see `src/jobs.ts` for the full list and
the exact times, sourced from `AUTOMATION_CONTROL_KEYS`'s own comment
in `packages/shared/src/index.ts`), and at each job's own time it makes
one `POST` request to the matching maintenance route on `apps/api`,
with the right shared secret in the `X-Nexus-Maintenance-Secret`
header. That's the whole job — it holds no database credentials, no
business logic, and no state of its own; every actual job body still
lives in `apps/api/src/services/automationJobs.ts` exactly as before.

Nine §12 jobs, one calendar reconciliation sweep, one billing
grace-period check — twelve schedules total, two of the nine §12 jobs
intentionally left unscheduled (`daily_recurring_tasks`,
`hourly_follow_up`) because they still have no implementation behind
them on the API side (a schema gap, not a wiring gap — see
`automationJobs.ts`'s own comment).

## Why a separate process, not inside `apps/api`

The maintenance routes' own comments were explicit: "an external
scheduler is the caller, not something running inside the API process
itself" — the same reasoning that gave the routes a shared-secret
instead of a session in the first place. This app is that external
caller, just self-hosted instead of a paid SaaS one, in keeping with
the ₦0-budget constraint PRD §18 sets for the rest of this project. An
n8n Cloud account (one workflow per job) or nine `cron-job.org` entries
both still work as drop-in alternatives — this app doesn't change the
routes at all, it's just one more thing that can call them.

## Running it

Needs nothing but network access to `apps/api` and the three secrets.

```bash
cp .env.example .env   # fill in API_BASE_URL + the three secrets
npm run dev -w apps/scheduler     # local dev, tsx watch
# or, in production:
npm run build -w apps/scheduler
npm run start -w apps/scheduler
```

Deploy it as a systemd unit, a second `docker-compose` service (see the
`Dockerfile` beside this file and the commented-out service block in
the repo root's `docker-compose.yml`), or any other "keep this process
alive" mechanism — it doesn't need to run on the same host as
`apps/api`, only be able to reach `API_BASE_URL` over HTTPS.

## Verifying it's actually working

- Each run logs a line (`maintenance run succeeded` / `... failed`) via
  `pino` — point stdout at whatever log aggregation this deployment
  already uses.
- `GET /api/v1/automation/health` (Session 46) shows `lastRun` per §12
  job once this process has fired at least once — that endpoint is the
  real end-to-end confirmation, not just this process's own logs.
- Set `RUN_ON_START=true` temporarily after first deploying this
  process (or after rotating a secret) to fire every implemented job
  once immediately, instead of waiting for the next scheduled time —
  turn it back off afterward (see `.env.example`'s own warning about
  leaving it on).

## Not done here

- No retry/backoff on a failed run — the next scheduled run (next day,
  or next 30 minutes for the calendar sweep) is the retry. Given how
  cheap and idempotent every job body already is (`dispatchToEnabledOrgs`
  isolates per-org failures; the calendar sweep and billing grace check
  are themselves idempotent re-checks), an extra retry layer here would
  be complexity without a clear win — revisit if a job ever needs
  same-run retry semantics.
- No alerting integration (PagerDuty, Slack, etc.) on a failed run —
  logs only. Wire this app's `pino` output into whatever this
  deployment's log-based alerting already is, rather than building a
  bespoke second alerting path here.
- No distributed-lock / multi-instance coordination — this process is
  meant to run as exactly one instance. Running two instances would
  double-fire every job (the maintenance routes themselves are not
  idempotent-safe against a genuine concurrent double-call in every
  case — e.g. two overlapping automation runs would each write their
  own `automation_run_log` rows for the same window).
