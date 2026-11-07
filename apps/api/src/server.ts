// NEXUS API — entry point.
// Security defaults are wired here from day one per PRD §13 ("security is
// not a phase"). Every new route inherits: CORS allowlist, rate limiting,
// cookie-based sessions (never URL tokens — PRD §13.2), and an error
// handler that never leaks stack traces / internals (PRD §13.4).

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import authPlugin from './plugins/auth.js';
import impersonationGuardPlugin from './plugins/impersonationGuard.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDevAuthRoutes, isDevLoginEnabled } from './routes/devAuth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerGoalRoutes } from './routes/goals.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerEodRoutes } from './routes/eod.js';
import { registerNetworkRoutes } from './routes/network.js';
import { registerPeopleRoutes } from './routes/people.js';
import { registerLeaveRoutes } from './routes/leave.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerKnowledgeRoutes } from './routes/knowledge.js';
import { registerFileRoutes } from './routes/files.js';
import { registerMarketingRoutes } from './routes/marketing.js';
import { registerMeetingRoutes } from './routes/meetings.js';
import { registerMeetingIngestWebhookRoutes } from './routes/meetingIngestWebhook.js';
import { registerAiSettingsRoutes } from './routes/aiSettings.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerAiReportRoutes } from './routes/aiReports.js';
import { registerAgentHandoffRoutes } from './routes/agentHandoffs.js';
import { registerCalendarRoutes } from './routes/calendar.js';
import { registerCalendarWebhookRoutes } from './routes/calendarWebhook.js';
import { registerCalendarMaintenanceRoutes } from './routes/calendarMaintenance.js';
import { registerAutomationRoutes } from './routes/automation.js';
import { registerAutomationMaintenanceRoutes } from './routes/automationMaintenance.js';
import { registerPermissionRoutes } from './routes/permissions.js';
import { registerUserPreferencesRoutes } from './routes/userPreferences.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerGuestRoutes } from './routes/guests.js';
import { registerSuperAdminRoutes } from './routes/admin/superAdmin.js';
import { registerImpersonationRoutes } from './routes/admin/impersonation.js';
import { registerGroupAdminRoutes } from './routes/admin/groupAdmin.js';
import { registerCompanyAdminRoutes } from './routes/admin/companyAdmin.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerBillingWebhookRoutes } from './routes/billingWebhook.js';
import { registerBillingMaintenanceRoutes } from './routes/billingMaintenance.js';

const PORT = Number(process.env.PORT ?? 3001);

// WEB_ORIGIN stays single-purpose: it's also the literal OAuth redirect
// target in routes/auth.ts, so it can't become a list without breaking
// that redirect.
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173';

// PRD §16 (Capacitor) — the Android app (and future iOS) is served from
// the synthetic `https://localhost` origin via capacitor.config.ts's
// `androidScheme: 'https'`, which is a distinct origin from the browser
// web app. CORS_EXTRA_ORIGINS adds it (and any future native origins)
// alongside WEB_ORIGIN without disturbing the OAuth redirect target above.
const EXTRA_ORIGINS = (process.env.CORS_EXTRA_ORIGINS ?? 'https://localhost')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const ORIGIN = [WEB_ORIGIN, ...EXTRA_ORIGINS];

export function buildServer(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: true,
  });

  app.register(cors, {
    origin: ORIGIN,
    credentials: true, // required for httpOnly session cookies (PRD §13.2)
  });

  // PRD §13 — security headers wired in from day one, not a pre-launch
  // checklist item. `crossOriginResourcePolicy` is overridden from
  // helmet's 'same-origin' default because the API and web app are on
  // different origins (localhost:5173 vs :3001, and their prod
  // equivalents) — 'same-origin' would have the browser silently drop
  // every cross-origin fetch response regardless of the CORS headers
  // above, since CORP is enforced independently of CORS. `contentSecurityPolicy`
  // is left at helmet's default even though this is a JSON-only API (no
  // HTML ever served): it's inert for JSON responses today and becomes a
  // real safety net for free if an HTML-serving route (e.g. an OAuth
  // callback page) is ever added.
  app.register(helmet, {
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  app.register(cookie, {
    secret: process.env.COOKIE_SECRET, // required in prod; set via env, never committed
  });

  // Decorates req.sessionUser + req.requireAuth for every route below.
  // PRD §13.2/§13.3 — auth state is established once, centrally.
  app.register(authPlugin);
  // Session 11 (ADMIN_BUILD_GUIDE.md §5) — global "impersonation is
  // read-only by default" enforcement. Registered immediately after
  // authPlugin so req.sessionUser.impersonatedBy is already resolved by
  // the time this hook runs; before rate-limit/every route below so no
  // route can accidentally bypass it by omission.
  app.register(impersonationGuardPlugin);

  // Global baseline; tighter per-endpoint limits (auth, AI, export) are
  // applied at the route level per PRD §13.4.
  app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // PRD §13.4 — strict error handling: typed error code + user-facing
  // message only. No stack traces, no SQL text, no internal paths.
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    app.log.error(err);
    const status = err.statusCode ?? 500;
    reply.status(status).send({
      error: status === 500 ? 'internal_error' : (err.code ?? 'error'),
      message: status === 500 ? 'Something went wrong.' : err.message,
    });
  });

  app.register(registerHealthRoutes, { prefix: '/api/v1/system' });
  app.register(registerAuthRoutes, { prefix: '/api/v1/auth' });
  // Dev-only roster login (see routes/devAuth.ts) — only ever mounted
  // outside production and behind an explicit opt-in env var; the file
  // itself also refuses every request if that's somehow not the case.
  if (isDevLoginEnabled()) {
    app.log.warn('DEV_LOGIN=true — /api/v1/auth/dev-login is mounted (roster login, no password). Never set this in production.');
    app.register(registerDevAuthRoutes, { prefix: '/api/v1/auth/dev-login' });
  }
  app.register(registerTaskRoutes, { prefix: '/api/v1/tasks' });
  app.register(registerGoalRoutes, { prefix: '/api/v1/goals' });
  // Session 38 — ADMIN_BUILD_GUIDE.md §2.
  app.register(registerProjectRoutes, { prefix: '/api/v1/projects' });
  app.register(registerApprovalRoutes, { prefix: '/api/v1/approvals' });
  app.register(registerInviteRoutes, { prefix: '/api/v1/invites' });
  app.register(registerAnalyticsRoutes, { prefix: '/api/v1/analytics' });
  app.register(registerEodRoutes, { prefix: '/api/v1/eod' });
  app.register(registerNetworkRoutes, { prefix: '/api/v1/network' });
  app.register(registerPeopleRoutes, { prefix: '/api/v1/people' });
  app.register(registerLeaveRoutes, { prefix: '/api/v1/leave' });
  app.register(registerOnboardingRoutes, { prefix: '/api/v1/onboarding' });
  app.register(registerKnowledgeRoutes, { prefix: '/api/v1/knowledge' });
  // PRD §10.7 FileService / §13.1 S5 — scoped object storage attachments.
  app.register(registerFileRoutes, { prefix: '/api/v1/files' });
  app.register(registerMarketingRoutes, { prefix: '/api/v1/marketing' });
  app.register(registerMeetingRoutes, { prefix: '/api/v1/meetings' });
  // No requireAuth hook here, same as registerCalendarWebhookRoutes just
  // above — Fastify plugin encapsulation keeps this from ever inheriting
  // one accidentally, and it's a separate file/prefix so that's obvious
  // on inspection too.
  app.register(registerMeetingIngestWebhookRoutes, { prefix: '/api/v1/meetings/ingest' });
  app.register(registerAiSettingsRoutes, { prefix: '/api/v1/settings/ai' });
  app.register(registerChatRoutes, { prefix: '/api/v1/chat' });
  app.register(registerAiReportRoutes, { prefix: '/api/v1/ai/reports' });
  app.register(registerAgentHandoffRoutes, { prefix: '/api/v1/agent-handoffs' });
  // Session-authed: connect/manage calendars, read/write events (PRD §10.5).
  app.register(registerCalendarRoutes, { prefix: '/api/v1/calendar' });
  // Public — no session, verified via Google's own signed channel token
  // (see routes/calendarWebhook.ts for why this is deliberately outside
  // registerCalendarRoutes's requireAuth hook).
  app.register(registerCalendarWebhookRoutes, { prefix: '/api/v1/calendar/webhook' });
  // Public path, shared-secret authenticated — cross-org reconciliation
  // sweep, triggered by an external scheduler (n8n/cron), same shape as
  // the other automation jobs in PRD §12.
  app.register(registerCalendarMaintenanceRoutes, { prefix: '/api/v1/calendar/maintenance' });

  app.register(registerAutomationRoutes, { prefix: '/api/v1/automation' });
  // Public path, shared-secret authenticated — the actual §12 job
  // trigger endpoints, same shape as calendar's own maintenance route
  // just above. One external scheduler entry per job's own time of day,
  // not one sweep.
  app.register(registerAutomationMaintenanceRoutes, { prefix: '/api/v1/automation/maintenance' });
  app.register(registerPermissionRoutes, { prefix: '/api/v1/permissions' });
  // Session 50 — self-service, not RBAC-gated (see routes/userPreferences.ts's
  // own header note); own prefix rather than nested under /auth since
  // this is user settings, not session/identity.
  app.register(registerUserPreferencesRoutes, { prefix: '/api/v1/preferences' });
  app.register(registerNotificationRoutes, { prefix: '/api/v1/notifications' });
  // ADMIN_BUILD_GUIDE.md §1 (Session 37) — guest credential provisioning.
  app.register(registerGuestRoutes, { prefix: '/api/v1/guests' });
  // ADMIN_BUILD_GUIDE.md §3 "Session 4" (repo Session 40) — Super Admin
  // backend. Every route inside gates on isPlatformAdmin() itself
  // (see superAdmin.ts's own requirePlatformAdmin helper) rather than a
  // preHandler here, so a 403 response carries the same
  // { error, message } shape every other permission check in this
  // codebase already returns.
  app.register(registerSuperAdminRoutes, { prefix: '/api/v1/admin/super' });
  // ADMIN_BUILD_GUIDE.md §5 (Session 11) — impersonation. Own prefix,
  // own gate (isImpersonationGranted, not isPlatformAdmin — see
  // impersonation.ts's own header for why). Registered after
  // superAdmin.ts as the next admin capability in the guide's own
  // session order.
  app.register(registerImpersonationRoutes, { prefix: '/api/v1/admin/impersonation' });
  // ADMIN_BUILD_GUIDE.md §3 "Session 6" (repo Session 41) — Group Admin
  // backend half. Gates on isGroupAdmin() itself (see groupAdmin.ts's
  // own requireGroupAdmin helper), same posture as superAdmin.ts above.
  app.register(registerGroupAdminRoutes, { prefix: '/api/v1/admin/group' });
  // ADMIN_BUILD_GUIDE.md §3 "Session 6" (repo Session 41) — Company Admin
  // backend half. Gates on isCompanyAdmin() (leader of a company-type org).
  // Thin read-aggregation shell wrapping existing People/Work/Goals/
  // Knowledge/Automation services — no new write surface or auth primitive.
  app.register(registerCompanyAdminRoutes, { prefix: '/api/v1/admin/company' });
  // Session 47 — org-facing Billing page (summary/invoices/checkout),
  // leader-gated (see billing.ts's own header for why not a permissions
  // grant).
  app.register(registerBillingRoutes, { prefix: '/api/v1/billing' });
  // Public — no session, verified via Paystack's own HMAC signature
  // header (see billingWebhook.ts for why this is deliberately outside
  // registerBillingRoutes's requireAuth hook, same shape as
  // calendarWebhook.ts).
  app.register(registerBillingWebhookRoutes, { prefix: '/api/v1/billing/webhook' });
  // Public path, shared-secret authenticated — the grace-period sweep
  // trigger (automationJobs.ts's runBillingGraceCheck), same shape as
  // calendar's and automation's own maintenance routes just above, but
  // its own secret (see billingMaintenance.ts's own comment on why).
  app.register(registerBillingMaintenanceRoutes, { prefix: '/api/v1/billing/maintenance' });

  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const app = buildServer();
  // HOST=:: on Railway: its private network (scheduler -> api) can be
  // IPv6-only, and '::' binds both IPv6 and IPv4 on Linux. Local dev and
  // docker-compose keep the IPv4 default.
  app.listen({ port: PORT, host: process.env.HOST || '0.0.0.0' }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
