// The reconciliation-sweep trigger — same "internal automation calls a
// shared-secret endpoint, not a NEXUS session" shape as PRD §10.6's n8n
// scheduled workflows for the 9 cron jobs (§12), applied here because
// this sweep is cross-org (it has to be — a missed webhook could belong
// to any org) and therefore can't run inside a single request's
// withOrgContext the way a normal authenticated route does.
//
// Not registered under calendar.ts's requireAuth plugin for the same
// reason as calendarWebhook.ts: there is no NEXUS session to require: an
// external scheduler (n8n, or a plain cron hitting this with curl) is
// the caller, authenticated by a shared secret instead.
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { reconcileAllSubscriptions, renewExpiringChannels } from '../services/calendarSyncService.js';

function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export async function registerCalendarMaintenanceRoutes(app: FastifyInstance) {
  app.post('/sweep', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
    const secret = process.env.CALENDAR_MAINTENANCE_SECRET;
    if (!secret) {
      // Fails closed: an unconfigured secret must never mean "anyone can
      // trigger this," it must mean "this endpoint is off."
      reply.status(503).send({ error: 'not_configured', message: 'CALENDAR_MAINTENANCE_SECRET is not set.' });
      return;
    }

    const provided = req.headers['x-nexus-maintenance-secret'];
    if (typeof provided !== 'string' || !timingSafeEqualStrings(provided, secret)) {
      reply.status(401).send({ error: 'unauthorized', message: 'Invalid or missing maintenance secret.' });
      return;
    }

    const results = await reconcileAllSubscriptions();
    const failed = results.filter((r) => !r.ok);
    reply.send({
      swept: results.length,
      succeeded: results.length - failed.length,
      failed: failed.length,
      failures: failed,
    });
  });

  // Shared-secret auth is duplicated rather than extracted into a helper
  // because calendarMaintenance.ts is intentionally self-contained —
  // it has no requireAuth plugin and shouldn't grow a shared-module
  // dependency purely to DRY two identical guards. If a third endpoint
  // ever lands here, extract then.
  app.post('/renew-channels', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
    const secret = process.env.CALENDAR_MAINTENANCE_SECRET;
    if (!secret) {
      reply.status(503).send({ error: 'not_configured', message: 'CALENDAR_MAINTENANCE_SECRET is not set.' });
      return;
    }

    const provided = req.headers['x-nexus-maintenance-secret'];
    if (typeof provided !== 'string' || !timingSafeEqualStrings(provided, secret)) {
      reply.status(401).send({ error: 'unauthorized', message: 'Invalid or missing maintenance secret.' });
      return;
    }

    const results = await renewExpiringChannels();
    const failed = results.filter((r) => !r.ok);
    reply.send({
      renewed: results.length,
      succeeded: results.length - failed.length,
      failed: failed.length,
      failures: failed,
    });
  });
}
