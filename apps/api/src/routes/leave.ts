// PRD §7.2 04 PEOPLE → Leave routes. Permission shape mirrors eod.ts +
// approvals.ts, combined:
//  - POST / (request leave): always allowed for yourself. Filing on
//    someone else's behalf requires a flat `leave.create` grant, same
//    branch shape as eod.ts's "who am I filing for" case.
//  - GET / (list): general `leave.read` grant sees everyone's requests;
//    without it, forced to the caller's own — same fallback as
//    tasks.ts/eod.ts's list routes (check 4's own-record pattern).
//  - POST /:id/approve, /:id/reject: flat `leave.approve` grant — a
//    leave decision isn't a "your own record" action the way viewing
//    your own request is, so this is approvals.ts's flat-check style,
//    not tasks.ts's row-branching one.
//  - DELETE /:id (cancel): the requester's own still-pending request, OR
//    a `leave.delete` grant — the one place this file does need the
//    row-branch pattern, since "cancel my own request" has no sensible
//    flat permission (everyone can always cancel their own).
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import {
  LeaveError,
  cancelLeaveRequest,
  createLeaveRequest,
  decideLeaveRequest,
  getLeaveRequestById,
  isOwnLeaveRequest,
  listLeaveRequests,
  type CreateLeaveInput,
} from '../services/leaveService.js';
import type { LeaveListQuery, LeaveStatus } from '@nexus/shared';

const VALID_STATUSES: LeaveStatus[] = ['pending', 'approved', 'rejected'];

const LEAVE_ERROR_STATUS: Record<LeaveError['code'], number> = {
  not_found: 404,
  already_decided: 409,
  invalid_range: 400,
};

function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export async function registerLeaveRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (req, reply) => {
    const user = req.sessionUser!;
    const q = req.query as { userId?: string; status?: string };

    if (q.status && !VALID_STATUSES.includes(q.status as LeaveStatus)) {
      reply.status(400).send({ error: 'invalid_status', message: `status must be one of ${VALID_STATUSES.join(', ')}` });
      return;
    }

    const query: LeaveListQuery = { status: q.status as LeaveStatus | undefined, userId: q.userId };

    const canReadAll = await hasPermission(user, 'leave', 'read');
    if (!canReadAll) {
      if (query.userId && query.userId !== user.userId) {
        reply.status(403).send({ error: 'forbidden', message: 'Can only list your own leave requests.' });
        return;
      }
      query.userId = user.userId;
    }

    const requests = await listLeaveRequests(user.orgId, query);
    reply.send({ requests });
  });

  app.post('/', async (req, reply) => {
    const user = req.sessionUser!;
    const body = req.body as Partial<CreateLeaveInput>;

    if (!body?.startDate || !isValidIsoDate(body.startDate)) {
      reply.status(400).send({ error: 'invalid_body', message: 'startDate (ISO date) is required.' });
      return;
    }
    if (!body?.endDate || !isValidIsoDate(body.endDate)) {
      reply.status(400).send({ error: 'invalid_body', message: 'endDate (ISO date) is required.' });
      return;
    }

    const targetUserId = body.userId ?? user.userId;
    if (targetUserId !== user.userId) {
      const granted = await hasPermission(user, 'leave', 'create');
      if (!granted) {
        reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'leave' to file for another user." });
        return;
      }
    }

    try {
      const request = await createLeaveRequest(user.orgId, {
        userId: targetUserId,
        startDate: body.startDate,
        endDate: body.endDate,
        reason: body.reason,
      });
      reply.status(201).send(request);
    } catch (err) {
      if (err instanceof LeaveError) {
        reply.status(LEAVE_ERROR_STATUS[err.code]).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  app.post('/:id/approve', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'leave', 'approve'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'approve' permission on 'leave'." });
      return;
    }
    const { id } = req.params as { id: string };
    const body = req.body as { note?: string } | undefined;
    try {
      const decided = await decideLeaveRequest(user.orgId, id, 'approved', user.userId, body?.note);
      reply.send(decided);
    } catch (err) {
      if (err instanceof LeaveError) {
        reply.status(LEAVE_ERROR_STATUS[err.code]).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  app.post('/:id/reject', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'leave', 'approve'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'approve' permission on 'leave'." });
      return;
    }
    const { id } = req.params as { id: string };
    const body = req.body as { note?: string } | undefined;
    try {
      const decided = await decideLeaveRequest(user.orgId, id, 'rejected', user.userId, body?.note);
      reply.send(decided);
    } catch (err) {
      if (err instanceof LeaveError) {
        reply.status(LEAVE_ERROR_STATUS[err.code]).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  app.delete('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };

    const existing = await getLeaveRequestById(user.orgId, id);
    if (!existing) {
      reply.status(404).send({ error: 'not_found', message: 'Leave request not found.' });
      return;
    }

    const granted = (await hasPermission(user, 'leave', 'delete')) || isOwnLeaveRequest(existing, user.userId);
    if (!granted) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'delete' permission on 'leave'." });
      return;
    }

    try {
      const cancelled = await cancelLeaveRequest(user.orgId, id);
      reply.send(cancelled);
    } catch (err) {
      if (err instanceof LeaveError) {
        reply.status(LEAVE_ERROR_STATUS[err.code]).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });
}
