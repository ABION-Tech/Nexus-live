// PRD §8.10 Automation, §10 (production section list #10). Flat
// `automation` resource grant — a toggle panel controlling org-wide
// scheduled jobs has no meaningful "own record" case the way eod.ts or
// files.ts do, same reasoning eod.ts's own header gives for its
// `analytics.read`-only aggregate endpoints having no `.own` branch.
//
// Toggle-panel + cron-job-health halves of §8.10 both live here now —
// see automationService.ts's header for the health half's own history
// (deferred until Phase H, now built: GET /health below, backed by
// routes/automationMaintenance.ts's real automation_run_log rows).
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import {
  getAutomationHealth,
  listAutomationControls,
  listAutomationLog,
  setAutomationControl,
  UnknownAutomationKeyError,
} from '../services/automationService.js';
import { requireFeature, BillingLimitError } from '../services/billingService.js';

export async function registerAutomationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'automation', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'automation'." });
      return;
    }
    const controls = await listAutomationControls(user.orgId);
    reply.send({ controls });
  });

  app.patch('/:key', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'automation', 'update'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'automation'." });
      return;
    }
    const { key } = req.params as { key: string };
    const body = req.body as { enabled?: unknown };
    if (typeof body?.enabled !== 'boolean') {
      reply.status(400).send({ error: 'invalid_body', message: 'enabled must be a boolean.' });
      return;
    }
    try {
      // Session 47: only the *enabling* direction is gated — turning a
      // job off never needs a feature check, same "downgrades never
      // need permission" posture as everything else in this codebase.
      // pro-only: automation runs org-wide scheduled jobs regardless of
      // which individual leader flips the toggle, which is a materially
      // bigger platform cost than a single feature click, unlike
      // guest_invites/calendar_sync.
      if (body.enabled) {
        await requireFeature(user.orgId, 'automation');
      }
      const control = await setAutomationControl(user.orgId, key, body.enabled, user.userId);
      if (!control) {
        reply.status(404).send({ error: 'not_found', message: `No automation control found for '${key}'.` });
        return;
      }
      reply.send(control);
    } catch (err) {
      if (err instanceof BillingLimitError) {
        reply.status(err.statusCode).send({ error: err.code, message: err.message });
        return;
      }
      if (err instanceof UnknownAutomationKeyError) {
        reply.status(400).send({ error: 'unknown_key', message: err.message });
        return;
      }
      throw err;
    }
  });

  // Audit trail for toggle changes (PRD §9.1 automation_log / §13.10).
  // Same `automation.read` gate as the list above — seeing the history
  // of a panel you can already see the current state of isn't a
  // separate capability.
  app.get('/log', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'automation', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'automation'." });
      return;
    }
    const q = req.query as { limit?: string };
    const limit = q.limit ? Number(q.limit) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      reply.status(400).send({ error: 'invalid_query', message: 'limit must be a positive number.' });
      return;
    }
    const entries = await listAutomationLog(user.orgId, limit);
    reply.send({ entries });
  });

  // Cron job health (Phase H, the other half of §8.10) — now backed by
  // real automation_run_log rows via routes/automationMaintenance.ts.
  // Same `automation.read` gate as the list/log endpoints above: seeing
  // whether the jobs you can already see the toggles for actually ran
  // isn't a separate capability.
  app.get('/health', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'automation', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'automation'." });
      return;
    }
    const runs = await getAutomationHealth(user.orgId);
    reply.send({ runs });
  });
}
