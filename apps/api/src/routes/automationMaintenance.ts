// Phase H (PRD §17.1 / §12) trigger endpoint — the scheduler-facing half
// of automation_run_log / IMPLEMENTED_JOBS (automationJobs.ts) that was
// referenced by name in the migration, automationJobs.ts's own header,
// and the shared AutomationRunLogEntry type since they were written, but
// never actually created until now.
//
// Same shared-secret, no-NEXUS-session shape as calendarMaintenance.ts's
// own /sweep: an external scheduler (n8n Cloud's own per-workflow
// schedule, or a plain cron-job.org hit) is the caller, not a logged-in
// user, so there's no session to require. Different from calendar's
// single /sweep endpoint, though: PRD §12 gives the nine jobs nine
// different times of day (08:00, 09:00, ..., hourly), so this is
// job-scoped (:jobKey) rather than one sweep — nine separately scheduled
// external triggers hitting nine different URLs, each firing at its own
// job's own time, not one endpoint doing everything on every call.
//
// Logging: this route, not automationJobs.ts's own dispatchToEnabledOrgs,
// writes automation_run_log — per 0024_automation_scheduling.sql's own
// comment on why. Each IMPLEMENTED_JOBS entry already fans out across
// every org with that job enabled and returns one JobRunResult per org
// (automationJobs.ts's dispatchToEnabledOrgs); this route takes that
// result set and calls recordAutomationRun once per org afterward,
// timestamped to the whole invocation — a single startedAt/finishedAt
// covering every org in this run, not per-org sub-timing. That's precise
// enough for what the health view actually needs ("did daily_cob_reminders
// run today and did it succeed for this org"), without instrumenting
// fine-grained timing inside every one of the seven job bodies
// individually.
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { IMPLEMENTED_JOBS, UNIMPLEMENTED_JOBS } from '../services/automationJobs.js';
import { isKnownAutomationKey, recordAutomationRun } from '../services/automationService.js';

function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export async function registerAutomationMaintenanceRoutes(app: FastifyInstance) {
  app.post('/run/:jobKey', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const secret = process.env.AUTOMATION_MAINTENANCE_SECRET;
    if (!secret) {
      // Fails closed: an unconfigured secret must never mean "anyone can
      // trigger this," it must mean "this endpoint is off" — same
      // reasoning calendarMaintenance.ts's /sweep already established.
      reply.status(503).send({ error: 'not_configured', message: 'AUTOMATION_MAINTENANCE_SECRET is not set.' });
      return;
    }

    const provided = req.headers['x-nexus-maintenance-secret'];
    if (typeof provided !== 'string' || !timingSafeEqualStrings(provided, secret)) {
      reply.status(401).send({ error: 'unauthorized', message: 'Invalid or missing maintenance secret.' });
      return;
    }

    const { jobKey } = req.params as { jobKey: string };

    if (!isKnownAutomationKey(jobKey)) {
      reply.status(400).send({
        error: 'unknown_key',
        message: `'${jobKey}' is not one of the known automation jobs (PRD §12).`,
      });
      return;
    }

    if (UNIMPLEMENTED_JOBS.has(jobKey)) {
      // Distinct from 400/404 — the key is real (it's one of the nine
      // §12 jobs and has a toggle in the panel), it just has nothing to
      // run yet. A 501 lets an external scheduler's own alerting tell
      // "you configured a job that doesn't exist" apart from "this job
      // exists but isn't built" — the caller shouldn't retry either way,
      // but the second case is a known, named gap, not a typo.
      reply.status(501).send({
        error: 'not_implemented',
        message: `'${jobKey}' has no implementation yet — see automationJobs.ts's own header for why.`,
      });
      return;
    }

    const runFn = IMPLEMENTED_JOBS[jobKey];
    if (!runFn) {
      // Shouldn't happen — isKnownAutomationKey + not-in-UNIMPLEMENTED_JOBS
      // should always mean IMPLEMENTED_JOBS has an entry — but fail loudly
      // rather than silently 200ing zero effect if the two lists in
      // automationJobs.ts ever drift out of sync with each other.
      reply.status(500).send({
        error: 'internal_error',
        message: `'${jobKey}' is neither implemented nor marked unimplemented — automationJobs.ts's lists have drifted.`,
      });
      return;
    }

    const startedAt = new Date();
    const results = await runFn();
    const finishedAt = new Date();

    for (const result of results) {
      await recordAutomationRun({
        orgId: result.orgId,
        jobKey,
        startedAt,
        finishedAt,
        status: result.status,
        detail: result.detail,
        error: result.error,
      });
    }

    const failed = results.filter((r) => r.status === 'error');
    reply.send({
      jobKey,
      orgsRun: results.length,
      succeeded: results.length - failed.length,
      failed: failed.length,
      failures: failed,
    });
  });
}
