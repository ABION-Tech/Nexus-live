# NEXUS release checklist and rollback

_Session 60 (register C-19). One page to follow for every production
release. Backups and the monthly restore test: `DEPLOYMENT.md` → Backups._

## Where things run

| Piece | Host | How it deploys |
|---|---|---|
| Web app (`apps/web`) | Vercel, project `nexus-live` | Automatically on every push to `main` |
| API (`apps/api`) | Railway service `api` | **Not reliably on push.** Deploy by reconnecting the source (Railway → api → Settings → Source, or the `connect-service-source` call) |
| Scheduler (`apps/scheduler`) | Railway service `scheduler` | Same as the API; redeploy when `apps/scheduler` changes |
| Database | Railway Postgres | Migrations run in the API's pre-deploy step |
| `seed-once` | Railway | **Never redeploy.** One-off bootstrap |

The API's pre-deploy step, in order: `migrate`, `ensureStorageCors`,
`ensurePlatformAdmins`, `ensurePersonalKeys`, `ensureEncryptedSecrets`. A
failure in any of them stops the deploy, and the previous version keeps
serving.

## Before you push

1. `npm run typecheck`, `npm run lint` (0 errors), `npm test`, `npm run build`.
2. A new migration:
   - **Adds, never breaks.** New columns are nullable or have a default. No dropping or renaming a column the running code still reads; do that in a later release.
   - Re-runnable (`if not exists` where it matters). CI checks a second `migrate` applies nothing.
   - A new `SECURITY DEFINER` function gets the grants it needs; CI's database job checks this.
3. New environment variables are set in Railway **before** the deploy that needs them.

## Release

1. Push to `main`. Wait for **CI** to go green on GitHub: both the checks and database jobs.
2. The web app deploys itself (Vercel). **If the release needs API changes, deploy the API straight away.** The web app is live first and briefly ahead of the API.
3. Deploy the API (and the scheduler if it changed).
4. Watch the API deploy log: `Applying 00xx_….sql` for each new migration, then each `ensure…` line, then the health check passing.

## Check it worked (5 minutes)

- `GET https://app.nexusabion.com/api/v1/system/health` → 200.
- Sign in; open Master Tasks, a task's drawer, and the dashboard.
- Super Admin → **Scheduled jobs**: nothing newly failing.
- API logs: no new `error` lines since the deploy.
- If the release touched Synergia: Synergia's NEXUS status line updated at the next quarter-hour, with "0 changed" unless something changed.

## Roll back

| What broke | Do this |
|---|---|
| The web app | Vercel → `nexus-live` → Deployments → the previous good one → **Promote to Production**. Takes seconds. |
| The API (code) | Railway → `api` → Deployments → the previous good one → **Redeploy**. Pre-deploy runs again; migrations already applied are skipped. |
| A migration | Migrations aren't undone automatically. Because they only add (above), the previous API version still works on the newer schema, so roll back the code first. Then fix forward with a new migration. |
| Data damaged | Stop writes (Railway → `api` → scale to 0 or remove the domain), then restore from the latest backup into a scratch database. Copy back only what was damaged; restore the whole database only as a last resort. Runbook: `DEPLOYMENT.md` → Backups. **This needs backups to exist (register C-02).** |
| The scheduler | Redeploy its previous good deployment. Missed daily runs aren't replayed; the next scheduled run carries on. |

## Variables that must exist in production (API)

`DATABASE_URL`, `MIGRATION_DATABASE_URL`, `NEXUS_APP_DB_PASSWORD`,
`COOKIE_SECRET`, `WEB_ORIGIN`, `CORS_EXTRA_ORIGINS`, `GOOGLE_OAUTH_*`,
`RESEND_API_KEY`, `EMAIL_FROM`, `STORAGE_*`, `VAPID_*`,
`AUTOMATION_MAINTENANCE_SECRET`, `CALENDAR_MAINTENANCE_SECRET`,
`BILLING_MAINTENANCE_SECRET`, `SECRET_ENCRYPTION_KEY`,
`PLATFORM_ADMIN_EMAILS`.

**Never change `SECRET_ENCRYPTION_KEY` without re-encrypting first:** the
saved AI provider keys can't be read without it.

**Not set yet (launch blockers):** `PAYSTACK_SECRET_KEY`,
`PAYSTACK_PLAN_CODE_STARTER`, `PAYSTACK_PLAN_CODE_PRO`.

## Before 15 January

- [ ] Backups running nightly, and one restore tested (C-02)
- [ ] Paystack: full lifecycle in test mode, then live keys (C-05)
- [ ] Sign-up model decided and built (C-06); terms and privacy pages (C-07)
- [ ] Public Postgres proxy removed
- [ ] Each pilot company's AI provider set and tested (C-10)
- [ ] This checklist followed once end to end on a real release, with a practised rollback
