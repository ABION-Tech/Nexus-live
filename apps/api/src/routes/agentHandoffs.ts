// Agent Handoff (PRD §8.8 / §10.6). resource 'agent_handoffs', same
// permission-gated, flat-role shape as routes/chat.ts and
// routes/aiReports.ts (AI Analyst has no 'own record' concept here — a
// handoff a team member started is still an org-wide execution, same as
// the underlying table has no per-user scoping column beyond
// requested_by_user_id, which is provenance, not access control).
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import { createAgentHandoff, listAgentHandoffs } from '../services/agentHandoffService.js';
import { requireFeature, BillingLimitError } from '../services/billingService.js';

export async function registerAgentHandoffRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'agent_handoffs', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'agent_handoffs'." });
      return;
    }
    const handoffs = await listAgentHandoffs(user.orgId);
    reply.send({ handoffs });
  });

  app.post('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'agent_handoffs', 'create'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'agent_handoffs'." });
      return;
    }
    const body = req.body as { taskId?: string; instructions?: string };
    if (!body?.instructions || !body.instructions.trim()) {
      reply.status(400).send({ error: 'invalid_body', message: 'instructions is required.' });
      return;
    }
    // Session 47: pro-only, gated on create only — same "only the action
    // that creates new usage needs the check" posture as automation.ts's
    // enable-only gate and aiReports.ts's generate-only gate. Listing
    // past handoffs a now-downgraded org already created isn't itself a
    // new use of the feature.
    try {
      await requireFeature(user.orgId, 'agent_handoff');
    } catch (err) {
      if (err instanceof BillingLimitError) {
        reply.status(err.statusCode).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
    const handoff = await createAgentHandoff(user.orgId, user.userId, {
      taskId: body.taskId || undefined,
      instructions: body.instructions.trim(),
    });
    reply.status(201).send(handoff);
  });
}
