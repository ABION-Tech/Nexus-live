// Session 47 — the scheduler-facing trigger for
// automationJobs.ts's runBillingGraceCheck. Same shared-secret,
// no-NEXUS-session shape as calendarMaintenance.ts's /sweep and
// automationMaintenance.ts's /run/:jobKey — an external scheduler
// (n8n/cron) is the caller, not a logged-in user. Its own file/prefix
// rather than a case inside automationMaintenance.ts's :jobKey dispatch
// because this job isn't one of the nine AUTOMATION_CONTROL_KEYS (see
// automationJobs.ts's own header on why) — folding it into that route
// would mean either widening isKnownAutomationKey to accept a job with
// no toggle, or special-casing it there, both worse than one small
// dedicated route.
//
// Uses its own env var (BILLING_MAINTENANCE_SECRET), not
// AUTOMATION_MAINTENANCE_SECRET — billing enforcement and the §12 job
// panel are different trust boundaries operationally (a leaked
// automation-sweep secret shouldn't also let someone force every
// past-due org into review, or vice versa), even though the code shape
// is identical.
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { runBillingGraceCheck } from '../services/automationJobs.js';

function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export async function registerBillingMaintenanceRoutes(app: FastifyInstance) {
  app.post('/run', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const secret = process.env.BILLING_MAINTENANCE_SECRET;
    if (!secret) {
      // Fails closed, same reasoning calendarMaintenance.ts and
      // automationMaintenance.ts already establish: an unconfigured
      // secret must mean "this endpoint is off," never "anyone can
      // trigger it."
      reply.status(503).send({ error: 'not_configured', message: 'BILLING_MAINTENANCE_SECRET is not set.' });
      return;
    }

    const provided = req.headers['x-nexus-maintenance-secret'];
    if (typeof provided !== 'string' || !timingSafeEqualStrings(provided, secret)) {
      reply.status(401).send({ error: 'unauthorized', message: 'Invalid or missing maintenance secret.' });
      return;
    }

    const results = await runBillingGraceCheck();
    const failed = results.filter((r) => r.status === 'error');
    reply.send({
      orgsChecked: results.length,
      transitioned: results.length - failed.length,
      failed: failed.length,
      failures: failed,
    });
  });
}
