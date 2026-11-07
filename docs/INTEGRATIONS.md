# NEXUS — Integration & External API Provisions

_As of Session 50. This is an inventory of what actually exists in the
codebase today, not a roadmap — see "Not built" at the end for what's
scaffolded but unwired, and what doesn't exist at all._

## Summary

NEXUS is **not** currently a platform with a public/partner API. It's an
internal operations app (`apps/web` + `apps/api`) that reaches **outward**
to a fixed set of external services on the organization's behalf. Nothing
in this repo issues API keys to external callers, and there's no
general-purpose webhook-subscription system for customers to hook their
own tools into NEXUS events.

All outbound integrations follow the same layering (PRD §6): **UI →
Service → Provider → External API**. The `Provider` layer
(`apps/api/src/integrations/`) is the only place a raw external SDK or
`fetch` call to a third party is allowed to live — services never call
out directly. This is also what makes most of these vendor-swappable via
env vars alone, no code change.

---

## Inbound: how people and systems reach NEXUS

| Provision | Direction | Where | Notes |
|---|---|---|---|
| **Google OAuth (login)** | Inbound | `routes/auth.ts` | The only production login path (PRD §10.1). Full browser-redirect flow, not a token/fetch exchange. httpOnly Secure session cookie, never a JWT or localStorage token. |
| **Guest login** | Inbound | `routes/auth.ts` `/guest-login` | The one deliberate exception to "OAuth only" — email+password, scoped to the `guest` role only (Session 37). |
| **Dev-login roster** | Inbound | `routes/devAuth.ts` | Only mounted when `DEV_LOGIN=true` **and** `NODE_ENV !== 'production'`. Not a password system — pick a name from a pre-seeded roster. Refused outright otherwise. |
| **Google Calendar push notifications** | Inbound (webhook) | `routes/calendarWebhook.ts` | Google calls back here when a subscribed calendar changes. Requires `CALENDAR_WEBHOOK_BASE_URL` to be a publicly reachable HTTPS origin — skipped entirely in local dev. |
| **Paystack webhook** | Inbound (webhook) | `routes/billingWebhook.ts` | HMAC-signature-verified using `PAYSTACK_SECRET_KEY`. Confirms subscription/payment state changes. |
| **External scheduler → maintenance endpoints** | Inbound | `routes/calendarMaintenance.ts`, `routes/automationMaintenance.ts`, `routes/billingMaintenance.ts` | NEXUS runs **no cron of its own**. An external scheduler (n8n Cloud, `cron-job.org`, plain server cron) hits these on a timer, authenticated via a shared secret in the `X-Nexus-Maintenance-Secret` header. Each endpoint 503s if its secret env var is unset. |
| **Meeting ingest webhook** | Inbound (webhook) | `routes/meetingIngestWebhook.ts` | Per-org shared-secret auth (`X-Meeting-Ingest-Secret` header, configured under Settings → Integrations, `ai_settings.meeting_ingest_secret`). This is the endpoint the "Meeting Ingest Secret — n8n's Fireflies → NEXUS webhook" field was built for. n8n normalizes whichever of Fireflies/Zoom/Google Meet it's watching into one payload shape before posting here — this endpoint does no per-vendor parsing of its own. Matches the payload to a `meetings` row by exact source ID first, falling back to same-organizer/overlapping-time matching (`services/meetingRecordingService.ts`); never auto-resolves a genuinely ambiguous match (e.g. two overlapping meetings for one organizer) — those sit in a manual review queue (`GET /api/v1/meetings/recordings/unmatched`) instead. |

## Outbound: what NEXUS talks to

| Service | Purpose | Provider file | Configured via | Vendor-swappable? |
|---|---|---|---|---|
| **Google Calendar** | Two-way calendar sync | `services/calendarSyncService.ts` + OAuth service | `GOOGLE_CALENDAR_OAUTH_REDIRECT_URI`, `CALENDAR_WEBHOOK_TOKEN_SECRET` | No — Google-specific |
| **AI provider (chat/reports)** | AI Analyst, goal decomposition, report generation | `integrations/aiProvider.ts` | **Per-org**, configured in-app under Settings → Integrations (not an env var) — base URL, API key, chat/report model | **Yes, by design.** Any OpenAI-compatible endpoint works: NVIDIA NIM, a self-hosted model, or any other vendor exposing that API shape. No org config → falls back to a free zero-config stub provider. |
| **n8n** | Agent-handoff triggers; also doubles as the external scheduler for the maintenance endpoints above | `services/agentHandoffService.ts` | `N8N_AGENT_WEBHOOK_URL` | One webhook URL; swapping automation platforms is a URL change |
| **Object storage** | File uploads (EOD proof files, etc.) | `integrations/objectStorageProvider.ts` | `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | **Yes.** S3-compatible: Cloudflare R2, AWS S3, or Supabase Storage's S3 endpoint, unchanged code either way. Presigned two-phase upload flow (request URL → browser PUT → confirm). |
| **Web Push** | Browser push notifications | `integrations/webPushProvider.ts` | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Standard Web Push/VAPID — not vendor-specific |
| **Paystack** | Billing checkout + subscription state | `integrations/paystackProvider.ts` | `PAYSTACK_SECRET_KEY`, `PAYSTACK_PLAN_CODE_STARTER`, `PAYSTACK_PLAN_CODE_PRO` | No — Paystack-specific |
| **Database** | Everything | `src/db.ts` | `DATABASE_URL` | **Yes.** Plain Postgres via `pg`, no ORM, no Supabase SDK. Supabase Cloud, self-hosted Postgres, or any other Postgres host — a connection-string change only. |

## Scaffolded but not yet wired

- **Email (Resend)** — `RESEND_API_KEY` exists as an env var in
  `.env.example`, but as of this session nothing in `apps/api/src`
  actually references it. No email-sending code path exists yet.

## What doesn't exist

- **No public/partner API.** `apps/api` is cookie-session-authenticated
  for `apps/web` alone. There's no API-key issuance, no OAuth-provider
  role (NEXUS as the identity provider for someone else's app), and no
  developer-facing documentation for external callers.
- **No outbound webhook subscriptions for customers.** Nothing lets an
  org register "notify this URL when X happens in NEXUS" — the only
  outbound webhook-shaped call is the one-way `N8N_AGENT_WEBHOOK_URL`
  trigger.
- **No generic connector platform** (Zapier/Make-style) and no
  SSO/SAML beyond the single Google OAuth client used for login.

---

_If a new integration is needed — a public API, an outbound webhook
system for customers, a different AI vendor already wired in, SSO for
another identity provider — that's new-initiative territory: scope and
approve before implementation, same as `FUTURE_SCOPE_ADMIN_ANALYTICS.md`._
