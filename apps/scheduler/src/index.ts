// The external scheduler itself — closes Session 46's "Next steps #4"
// and Session 47's "Next steps #5": routes/automationMaintenance.ts,
// routes/calendarMaintenance.ts, and routes/billingMaintenance.ts were
// all built for "an external scheduler (n8n Cloud, or cron-job.org)" to
// call, per their own header comments, but nothing was ever configured
// to actually call them. This is that caller.
//
// Deliberately its own process, not folded into apps/api — the
// maintenance routes' own comments already established "an external
// scheduler is the caller, not something running inside the API
// process itself" as the shape; a self-hosted node-cron process here is
// the ₦0-budget-constraint (PRD §18) equivalent of an n8n Cloud account
// or a cron-job.org account, not a departure from that decision. Swap
// this whole app out for either of those later without touching
// apps/api at all — it's a plain HTTP caller against routes that were
// already designed to not care who's calling them, as long as the
// shared secret matches.
//
// Deploy this as a small long-running process (systemd unit, Docker
// container — see the Dockerfile beside this file — or a second
// docker-compose service) anywhere that can reach API_BASE_URL. It does
// not need to run on the same host as apps/api, and it holds no
// database credentials at all — only the three maintenance secrets and
// a URL, same trust boundary the routes themselves already enforce.
import 'dotenv/config';
import cron from 'node-cron';
import pino from 'pino';
import { ALL_JOBS, type ScheduledJob } from './jobs.js';

const logger = pino({ name: 'nexus-scheduler', level: process.env.LOG_LEVEL || 'info' });

const API_BASE_URL = process.env.API_BASE_URL;
const TZ = process.env.SCHEDULER_TZ || 'Africa/Lagos'; // NEXUS's own operating timezone; override if ever wrong
const REQUEST_TIMEOUT_MS = Number(process.env.SCHEDULER_REQUEST_TIMEOUT_MS) || 30_000; // fan-out across every enabled org can be slow; longer than agentHandoffService.ts's 15s single-call N8N_TIMEOUT_MS on purpose
const RUN_ON_START = process.env.RUN_ON_START === 'true'; // smoke-test every implemented job once at boot, off by default

if (!API_BASE_URL) {
  logger.error('API_BASE_URL is not set — refusing to start. See .env.example.');
  process.exit(1);
}

const SECRET_ENV_VAR: Record<ScheduledJob['kind'], string> = {
  automation: 'AUTOMATION_MAINTENANCE_SECRET',
  calendar: 'CALENDAR_MAINTENANCE_SECRET',
  'calendar-renew': 'CALENDAR_MAINTENANCE_SECRET', // same secret, different endpoint
  billing: 'BILLING_MAINTENANCE_SECRET',
};

function urlFor(job: ScheduledJob): string {
  switch (job.kind) {
    case 'automation':
      return `${API_BASE_URL}/api/v1/automation/maintenance/run/${job.name}`;
    case 'calendar':
      return `${API_BASE_URL}/api/v1/calendar/maintenance/sweep`;
    case 'calendar-renew':
      return `${API_BASE_URL}/api/v1/calendar/maintenance/renew-channels`;
    case 'billing':
      return `${API_BASE_URL}/api/v1/billing/maintenance/run`;
  }
}

/** One HTTP call. Never throws past the caller — a bad org, a down API,
 * or a timeout must never crash the whole scheduler process, same
 * "one failure doesn't abort the sweep" reasoning
 * dispatchToEnabledOrgs (apps/api) already applies one layer down. */
async function runJob(job: ScheduledJob): Promise<void> {
  const secret = process.env[SECRET_ENV_VAR[job.kind]];
  if (!secret) {
    // The route itself fails closed (503) on a missing secret too — this
    // check just avoids firing a request that's guaranteed to fail and
    // logs the actual misconfiguration instead of a generic 503.
    logger.warn({ job: job.name }, `${SECRET_ENV_VAR[job.kind]} is not set — skipping this run.`);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const res = await fetch(urlFor(job), {
      method: 'POST',
      headers: { 'x-nexus-maintenance-secret': secret },
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;
    const body = await res.json().catch(() => undefined);

    if (res.ok) {
      logger.info({ job: job.name, status: res.status, durationMs, body }, 'maintenance run succeeded');
    } else {
      // 501 (unimplemented key) and 503 (secret not configured on the
      // API side) are expected-shape failures, not crashes — logged as
      // warnings, not errors, so alerting can tell "API rejected this
      // call for a known reason" apart from a genuine outage.
      const level = res.status === 501 || res.status === 503 ? 'warn' : 'error';
      logger[level]({ job: job.name, status: res.status, durationMs, body }, 'maintenance run returned a non-OK status');
    }
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logger.error({ job: job.name, durationMs, err: err instanceof Error ? err.message : String(err) }, 'maintenance run failed (network/timeout)');
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleJob(job: ScheduledJob): void {
  if (!job.implemented) {
    logger.info({ job: job.name }, `not scheduled — ${job.humanSchedule}`);
    return;
  }

  const expression = process.env[job.cronOverrideEnvVar] || job.cron;
  if (!cron.validate(expression)) {
    logger.error({ job: job.name, expression }, 'invalid cron expression — not scheduled. Check the override env var if one is set.');
    return;
  }

  cron.schedule(expression, () => void runJob(job), {
    timezone: TZ,
    name: job.name,
    // A slow run (e.g. calendar sweep taking longer than its own 30-min
    // interval under real load) must never stack a second overlapping
    // call on top of the first — same reasoning fileService.ts's
    // upload-abandonment cleanup and every §12 job's own per-org error
    // isolation already apply, just at the schedule level instead.
    noOverlap: true,
  });

  logger.info({ job: job.name, expression, tz: TZ }, `scheduled — ${job.humanSchedule}`);
}

async function main() {
  logger.info({ apiBaseUrl: API_BASE_URL, tz: TZ }, 'nexus-scheduler starting');

  for (const job of ALL_JOBS) {
    scheduleJob(job);
  }

  if (RUN_ON_START) {
    logger.info('RUN_ON_START=true — running every implemented job once now, then continuing on schedule');
    for (const job of ALL_JOBS.filter((j) => j.implemented)) {
      await runJob(job);
    }
  }

  logger.info('nexus-scheduler running — all schedules registered, waiting.');
}

async function shutdown(signal: string) {
  logger.info({ signal }, 'nexus-scheduler shutting down');
  await cron.shutdown();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'nexus-scheduler failed to start');
  process.exit(1);
});
