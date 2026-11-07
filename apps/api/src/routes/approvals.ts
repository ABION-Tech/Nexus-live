// PRD §6.4.1 approvals/ domain routes — the Review Queue. Gated on
// `goals` permission (not a separate `approvals` resource): a Review
// Queue item only exists in service of a goal's decomposition, and PRD
// §13.3's example grants already define `approve` as a `goals.*` action
// (`Leader → goals.* → read, create, approve, archive`) — there's no
// second resource name to invent here.
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import { ApprovalError, approvePendingTask, listPendingApprovals, rejectPendingTask } from '../services/approvalService.js';

const APPROVAL_ERROR_STATUS: Record<ApprovalError['code'], number> = {
  not_found: 404,
  already_decided: 409,
  dependency_not_approved: 409,
  dependency_rejected: 409,
};

export async function registerApprovalRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'goals', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'goals'." });
      return;
    }
    const q = req.query as { goalId?: string };
    const items = await listPendingApprovals(user.orgId, q.goalId);
    reply.send({ items });
  });

  app.post('/:id/approve', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'goals', 'approve'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'approve' permission on 'goals'." });
      return;
    }
    const { id } = req.params as { id: string };
    try {
      const task = await approvePendingTask(user.orgId, id, user.userId);
      reply.status(201).send(task);
    } catch (err) {
      if (err instanceof ApprovalError) {
        reply.status(APPROVAL_ERROR_STATUS[err.code]).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  app.post('/:id/reject', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'goals', 'approve'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'approve' permission on 'goals'." });
      return;
    }
    const { id } = req.params as { id: string };
    const body = req.body as { reason?: string } | undefined;
    try {
      const rejected = await rejectPendingTask(user.orgId, id, user.userId, body?.reason);
      reply.send(rejected);
    } catch (err) {
      if (err instanceof ApprovalError) {
        reply.status(APPROVAL_ERROR_STATUS[err.code]).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });
}
