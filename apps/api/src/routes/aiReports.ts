// AI Analyst > Reports (PRD §8.8). Same permission-gated, no-own-record
// shape as routes/chat.ts — resource 'ai_reports', gated at the leader
// role level (AI Analyst is `permissionGated` in ia.ts).
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import { generateAiReport } from '../services/aiReportService.js';
import { requireFeature, BillingLimitError } from '../services/billingService.js';
import type { AiReportMode } from '@nexus/shared';

const VALID_MODES: AiReportMode[] = ['attention', 'predictions', 'custom'];

function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export async function registerAiReportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.post('/generate', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'ai_reports', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'ai_reports'." });
      return;
    }
    const body = req.body as { mode?: string; from?: string; to?: string };
    if (!body?.mode || !VALID_MODES.includes(body.mode as AiReportMode)) {
      reply.status(400).send({ error: 'invalid_mode', message: `mode must be one of: ${VALID_MODES.join(', ')}.` });
      return;
    }
    for (const field of ['from', 'to'] as const) {
      if (body[field] && !isValidIsoDate(body[field]!)) {
        reply.status(400).send({ error: 'invalid_date', message: `${field} must be an ISO date (YYYY-MM-DD).` });
        return;
      }
    }
    // Session 47: pro-only feature. Checked after body validation (a
    // malformed request should 400 regardless of plan) but before any
    // AI provider call — a capped-out-of-the-feature org shouldn't pay
    // provider latency for a report it was never entitled to generate.
    try {
      await requireFeature(user.orgId, 'ai_reports');
    } catch (err) {
      if (err instanceof BillingLimitError) {
        reply.status(err.statusCode).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
    const result = await generateAiReport(user.orgId, {
      mode: body.mode as AiReportMode,
      from: body.from,
      to: body.to,
    }, user.userId);
    reply.send(result);
  });
}
