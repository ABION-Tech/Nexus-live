#!/usr/bin/env node
// One-time (idempotent) provisioning script for cron-job.org, as the
// external-cron alternative to deploying apps/scheduler — see
// DEPLOYMENT.md's "Scheduler" section for why this exists as a second
// option alongside n8n/nexus-maintenance-schedule.json.
//
// Skips the two PRD §12 keys with no implementation yet
// (daily_recurring_tasks, hourly_follow_up — see
// services/automationJobs.ts's UNIMPLEMENTED_JOBS) so cron-job.org
// never fires a job that can only ever 501.
//
// Schema verified directly against https://docs.cron-job.org/rest-api.html
// (fetched at build time, not reproduced from memory) — PUT /jobs takes
// a DetailedJob, schedule.hours/minutes/mdays/months/wdays each default
// to "every" via [-1], requestMethod 1 = POST, extendedData.headers
// carries the maintenance-secret header. NOT run against the real
// cron-job.org API in this environment — no API key was available here
// to exercise it end to end. Run with --dry-run first.
//
// Usage:
//   CRON_JOB_ORG_API_KEY=... API_BASE_URL=https://api.yourdomain.com \
//   AUTOMATION_MAINTENANCE_SECRET=... CALENDAR_MAINTENANCE_SECRET=... \
//   BILLING_MAINTENANCE_SECRET=... \
//   node scripts/setup-cron-job-org.mjs [--dry-run]
//
// Idempotent: checks existing job titles before creating, so re-running
// after a partial failure (e.g. hit the daily 100-request free-tier cap
// mid-run) only creates what's still missing.

const DRY_RUN = process.argv.includes('--dry-run');
const TIMEZONE = process.env.CRON_TIMEZONE || 'Africa/Lagos'; // WAT — matches PRD §12's stated times

const required = ['CRON_JOB_ORG_API_KEY', 'API_BASE_URL', 'AUTOMATION_MAINTENANCE_SECRET', 'CALENDAR_MAINTENANCE_SECRET', 'BILLING_MAINTENANCE_SECRET'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const API_KEY = process.env.CRON_JOB_ORG_API_KEY;
const API_BASE_URL = process.env.API_BASE_URL.replace(/\/$/, '');
const ENDPOINT = 'https://api.cron-job.org';
const SECRET_HEADER = 'X-Nexus-Maintenance-Secret';

// [-1] = "every" for that field, per JobSchedule's own default semantics.
const EVERY = [-1];

function daily(hour, minute = 0) {
  return { timezone: TIMEZONE, expiresAt: 0, hours: [hour], minutes: [minute], mdays: EVERY, months: EVERY, wdays: EVERY };
}
function everyNMinutes(n) {
  const minutes = [];
  for (let m = 0; m < 60; m += n) minutes.push(m);
  return { timezone: TIMEZONE, expiresAt: 0, hours: EVERY, minutes, mdays: EVERY, months: EVERY, wdays: EVERY };
}

// PRD §12's 7 implemented jobs + the two calendar maintenance endpoints
// + billing's grace check. daily_recurring_tasks / hourly_follow_up are
// deliberately absent — see this file's header comment.
const JOBS = [
  { title: 'NEXUS — daily_overdue_check', path: '/api/v1/automation/maintenance/run/daily_overdue_check', secretEnv: 'AUTOMATION_MAINTENANCE_SECRET', schedule: daily(8, 0) },
  { title: 'NEXUS — daily_morning_digest', path: '/api/v1/automation/maintenance/run/daily_morning_digest', secretEnv: 'AUTOMATION_MAINTENANCE_SECRET', schedule: daily(8, 0) },
  { title: 'NEXUS — daily_dependency_sweep', path: '/api/v1/automation/maintenance/run/daily_dependency_sweep', secretEnv: 'AUTOMATION_MAINTENANCE_SECRET', schedule: daily(9, 0) },
  { title: 'NEXUS — daily_cob_reminders', path: '/api/v1/automation/maintenance/run/daily_cob_reminders', secretEnv: 'AUTOMATION_MAINTENANCE_SECRET', schedule: daily(16, 0) },
  { title: 'NEXUS — daily_follow_up_escalation', path: '/api/v1/automation/maintenance/run/daily_follow_up_escalation', secretEnv: 'AUTOMATION_MAINTENANCE_SECRET', schedule: daily(18, 0) },
  { title: 'NEXUS — daily_eod_nudge', path: '/api/v1/automation/maintenance/run/daily_eod_nudge', secretEnv: 'AUTOMATION_MAINTENANCE_SECRET', schedule: daily(18, 0) },
  { title: 'NEXUS — daily_task_snapshot', path: '/api/v1/automation/maintenance/run/daily_task_snapshot', secretEnv: 'AUTOMATION_MAINTENANCE_SECRET', schedule: daily(23, 0) },
  { title: 'NEXUS — calendar sweep', path: '/api/v1/calendar/maintenance/sweep', secretEnv: 'CALENDAR_MAINTENANCE_SECRET', schedule: everyNMinutes(30) },
  { title: 'NEXUS — calendar channel renewal', path: '/api/v1/calendar/maintenance/renew-channels', secretEnv: 'CALENDAR_MAINTENANCE_SECRET', schedule: daily(2, 0) },
  { title: 'NEXUS — billing grace check', path: '/api/v1/billing/maintenance/run', secretEnv: 'BILLING_MAINTENANCE_SECRET', schedule: daily(7, 0) },
];

async function cronJobOrgFetch(method, path, body) {
  const res = await fetch(ENDPOINT + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return res.status === 204 ? {} : res.json();
}

// Job creation is rate-limited to 1 req/sec + 5/min (docs.cron-job.org)
// — sleep between creates rather than trying to burst all 10.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`Target API: ${API_BASE_URL}  Timezone: ${TIMEZONE}  ${DRY_RUN ? '(dry run)' : ''}`);

  const { jobs: existing } = await cronJobOrgFetch('GET', '/jobs');
  const existingTitles = new Set(existing.map((j) => j.title));

  for (const job of JOBS) {
    if (existingTitles.has(job.title)) {
      console.log(`skip (already exists): ${job.title}`);
      continue;
    }

    const payload = {
      job: {
        title: job.title,
        url: API_BASE_URL + job.path,
        enabled: true,
        saveResponses: true,
        requestMethod: 1, // POST — see RequestMethod table in docs.cron-job.org
        requestTimeout: 60,
        schedule: job.schedule,
        extendedData: {
          headers: { [SECRET_HEADER]: process.env[job.secretEnv] },
          body: '',
        },
      },
    };

    if (DRY_RUN) {
      console.log(`[dry-run] would create: ${job.title} -> ${payload.job.url}`);
      continue;
    }

    const { jobId } = await cronJobOrgFetch('PUT', '/jobs', payload);
    console.log(`created: ${job.title} (jobId ${jobId})`);
    await sleep(1200); // stay under 1 req/sec and 5 req/min
  }

  console.log(DRY_RUN ? 'Dry run complete — nothing was created.' : 'Done. Verify job status at https://console.cron-job.org.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
