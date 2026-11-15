# NEXUS — Integrations and external API

_Updated Session 60 (15 November 2026). An inventory of what exists in the
code today, not a roadmap. The previous version (Session 50) predated
password sign-in, email, the scheduler service and personal keys._

## Summary

NEXUS is mainly a web app (`apps/web` + `apps/api`) that reaches outward
to a fixed set of services on each company's behalf. It has **one
external API**: personal keys (Session 56), which let a person's own
other apps — today, Synergia — read their tasks across every company they
belong to, and optionally add tasks to those companies. There is still no
company-wide partner API and no customer webhook subscriptions.

Outbound integrations follow PRD §6's layering: **UI → Service →
Provider → External API**. Only `apps/api/src/integrations/` may call a
third party.

---

## Personal API (Synergia and your other apps)

Base URL: `https://app.nexusabion.com/api/v1`

### Keys

| | |
|---|---|
| **Create** | Settings → Account → Personal keys. Shown **once**, in full. Tick "Can also add tasks to my companies" to allow importing. |
| **Format** | `nxk_` + 43 characters. Send as `Authorization: Bearer nxk_…`. |
| **Stored as** | A SHA-256 hash and a 12-character prefix. The key itself is never stored. |
| **Scopes** | `tasks:read` (always) · `tasks:import` (only if ticked when created). |
| **Limit** | 10 active keys per person; 10 creations per 10 minutes. |
| **Revoke** | Settings → Account → Revoke. It stops working on the next request. |
| **Who it acts as** | The person who created it, and only them. It sees only their own work, and can only add tasks to companies they belong to. |
| **What it can't do** | Reach any other part of the API, create or revoke keys (those need a signed-in browser session), or be used while viewing as someone else. |

### `GET /integrations/my-tasks`

Your tasks — ones you own, support or supervise — in every company you
belong to. Scope `tasks:read`. 60 requests a minute.

| Query | Meaning |
|---|---|
| `includeDone=true` | Include finished tasks (default: open only). |

```json
{
  "organization": { "id": "…", "name": "ABION Industries" },
  "companies": [{ "id": "…", "name": "ABION Industries" }, { "id": "…", "name": "RescueTap" }],
  "fetchedAt": "2026-11-15T11:30:02.000Z",
  "tasks": [{
    "id": "…", "title": "…", "description": null,
    "status": "not_started | in_progress | blocked | done",
    "priority": "urgent | high | medium | low",
    "role": "owner | support | supervisor",
    "startDate": null, "deadline": "2026-11-20T16:00:00.000Z",
    "department": null, "business": "ABION Entertainment (TEA)",
    "updatedAt": "…", "organization": { "id": "…", "name": "RescueTap" },
    "url": "https://app.nexusabion.com/work/my-tasks"
  }]
}
```

`organization` at the top is the company the key was created in (kept for
older readers); each task's own `organization` is where it lives.

### `POST /integrations/tasks/import`

Adds tasks to **one** of your companies, assigned to you. Scope
`tasks:import`. 30 requests a minute, 1 to 200 tasks each, 2 MB body.

```json
{
  "company": "RescueTap",
  "tasks": [{
    "externalRef": "synergia:4b1e…",
    "title": "Finalise the NSSRCC pilot deck",
    "notes": "Optional, up to 8,000 characters",
    "status": "not_started | in_progress | blocked | done",
    "priority": "urgent | high | medium | low",
    "startDate": "2026-11-15",
    "deadline": "2026-11-20",
    "business": "Optional sub-company label",
    "department": "Optional",
    "ref": "T-0031",
    "assignToMe": true,
    "checklist": [{ "text": "Draft", "done": true }, { "text": "Review" }]
  }]
}
```

- `company` is matched by name, ignoring case, among the companies you
  belong to.
- `externalRef` (required, up to 200 characters) is your own stable id for
  the task. **Send the same one every time:** that's what makes re-running
  an import safe.
- A bare-date `deadline` means 17:00 Abuja time that day.
- `assignToMe: false` leaves the task unassigned. Up to 50 checklist items.

Response, one result per task, in the order sent:

```json
{ "company": { "orgId": "…", "name": "RescueTap" },
  "results": [{ "externalRef": "synergia:4b1e…", "id": "…", "outcome": "created" }] }
```

| `outcome` | Meaning |
|---|---|
| `created` | New task. |
| `existing` | This `externalRef` was imported before; nothing changed. |
| `matched_title` | A task with the same title already exists in that company. It was linked to your ref, not duplicated, and nothing else on it changed. |

### Errors (both endpoints)

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_body` | Not `{ company, tasks }`, or 0 or more than 200 tasks. |
| 400 | `invalid` | A task has no `externalRef` or no `title`. Nothing in that batch was saved. |
| 401 | `invalid_key` | Missing, unknown or revoked key. |
| 403 | `forbidden` | The key lacks the scope this endpoint needs. |
| 403 | `not_member` | You don't belong to a company with that name. |
| 429 | — | Rate limit. Wait a minute. |

### Logging

Every import is written to the server log (key id, person, company,
counts), and to that company's **audit log** as `tasks.import`, with the
key id, the number sent and the outcome counts. A failed import into a
company you belong to is logged there as an error. Each use of a key
updates its "last used" time, shown in Settings → Account.

### Synergia

Synergia (a separate product) uses both endpoints:

- **`nexus`** (Supabase edge function, every 15 minutes) reads
  `my-tasks?includeDone=true` and keeps a copy of each NEXUS task in your
  Synergia task list. It only updates a field when NEXUS's value changed,
  so your Synergia edits aren't overwritten.
- **`nexus-push`** (run on demand) sends Synergia work tasks to the
  matching NEXUS company with `externalRef = synergia:<record id>`, then
  links each Synergia record to its NEXUS copy, so the 15-minute sync
  updates it rather than adding a second one.

Ownership: NEXUS owns the company copy (other people may see and work on
it there). Synergia owns your personal planning (Plan my day, personal
tasks, which never leave Synergia).

---

## Other ways in

| Provision | Where | Notes |
|---|---|---|
| **Google sign-in** | `routes/auth.ts` `/google/*` | httpOnly Secure session cookie, never a token in browser storage. |
| **Password sign-in** | `routes/auth.ts` `/password/login`, `/password/request`, `/password/set` | Set or reset a password by emailed link. |
| **Mobile sign-in** | `routes/auth.ts` `/mobile/exchange` | The Android app exchanges a one-time code from the Google flow for a session. |
| **Guest login** | `routes/auth.ts` `/guest-login` | Email and password, `guest` role only. |
| **Dev-login roster** | `routes/devAuth.ts` | Only when `DEV_LOGIN=true` **and** `NODE_ENV` isn't `production`. Verified unreachable in production (404). |
| **Paystack webhook** | `routes/billingWebhook.ts` | HMAC-SHA512 signature check with `PAYSTACK_SECRET_KEY`. Each event is claimed once (0045): a retry of an applied event changes nothing. |
| **Google Calendar push** | `routes/calendarWebhook.ts` | Needs `CALENDAR_WEBHOOK_BASE_URL`, a public HTTPS origin. |
| **Meeting ingest** | `routes/meetingIngestWebhook.ts` | Per-company secret (`X-Meeting-Ingest-Secret`). |
| **Scheduler → maintenance endpoints** | `routes/automationMaintenance.ts`, `calendarMaintenance.ts`, `billingMaintenance.ts` | Called by NEXUS's own scheduler service (`apps/scheduler`) on its timetable, with a shared secret in `X-Nexus-Maintenance-Secret`. Each 503s if its secret is unset. Every automation dispatch is recorded (0044); a failure emails super admins, at most once a day per job. |

## What NEXUS talks to

| Service | Purpose | Where | Configured by |
|---|---|---|---|
| **Resend** | Email: invites, password links, digests, reminders, failure alerts | `integrations/emailProvider.ts` | `RESEND_API_KEY`, `EMAIL_FROM`. Unset → a stub that only logs. |
| **AI provider** | AI Analyst, goal breakdown, reports | `integrations/aiProvider.ts` | Per company, in Settings → Integrations. Any OpenAI-compatible endpoint. Unset → a placeholder provider. |
| **Google Calendar** | Two-way calendar sync | `services/calendarSyncService.ts` | `GOOGLE_CALENDAR_OAUTH_REDIRECT_URI`, `CALENDAR_WEBHOOK_TOKEN_SECRET` |
| **Paystack** | Checkout and subscriptions | `integrations/paystackProvider.ts` | `PAYSTACK_SECRET_KEY`, `PAYSTACK_PLAN_CODE_STARTER`, `PAYSTACK_PLAN_CODE_PRO`. **Not set in production yet.** |
| **Object storage** | File uploads | `integrations/objectStorageProvider.ts` | `STORAGE_*` (S3-compatible: R2, S3, Supabase) |
| **Web Push** | Browser notifications | `integrations/webPushProvider.ts` | `VAPID_*` |
| **n8n** | Agent hand-off trigger | `services/agentHandoffService.ts` | `N8N_AGENT_WEBHOOK_URL` |
| **Postgres** | Everything | `src/db.ts` | `DATABASE_URL` (the app's RLS-bound role), `MIGRATION_DATABASE_URL` (migrations only) |

## What doesn't exist

- **No company-wide partner API.** Personal keys act as one person only.
- **No outbound webhooks for customers** ("tell this URL when X happens").
- **No Zapier/Make-style connector and no SSO** beyond Google sign-in.

New integrations of that kind are new-initiative work: scope and approve
before building.
