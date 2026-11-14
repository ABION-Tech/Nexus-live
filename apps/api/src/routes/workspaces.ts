// Session 57 — one person, many companies. All routes are about the
// signed-in person themselves (session cookie only):
//
//   GET    /api/v1/me/workspaces              my companies + open invitations
//   POST   /api/v1/me/workspaces/switch       { orgId } → move this session there
//   POST   /api/v1/me/workspaces/home         { orgId } → land there at sign-in
//   POST   /api/v1/me/invitations/:id/accept  Join
//   POST   /api/v1/me/invitations/:id/decline Decline
//   GET    /api/v1/me/work                    my tasks across every company (?orgId=, ?includeDone=true)
//
// While impersonating, a Super Admin sees the target's companies but
// can't switch, accept, decline or change the target's home company:
// those are the person's own decisions.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  acceptInvitation,
  declineInvitation,
  listInvitations,
  listMyWorkAcrossCompanies,
  listWorkspaces,
  setHomeWorkspace,
  switchWorkspace,
  WorkspaceError,
} from '../services/workspaceService.js';
import { logOrgActionSafely } from '../services/auditLogService.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof WorkspaceError) {
    const status = err.code === 'not_found' ? 404 : 403;
    return reply.status(status).send({ error: err.code, message: err.message });
  }
  throw err;
}

function ownDecision(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.sessionUser!.impersonatedBy) {
    reply.status(403).send({ error: 'forbidden', message: "That's the person's own choice, so it can't be made while viewing as them." });
    return false;
  }
  return true;
}

function orgIdFrom(req: FastifyRequest, reply: FastifyReply): string | null {
  const orgId = (req.body as { orgId?: unknown } | null)?.orgId;
  if (typeof orgId !== 'string' || !UUID.test(orgId)) {
    reply.status(400).send({ error: 'invalid_body', message: 'orgId is required.' });
    return null;
  }
  return orgId;
}

export async function registerWorkspaceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (req) => {
    const u = req.sessionUser!;
    const [workspaces, invitations] = await Promise.all([listWorkspaces(u.userId, u.orgId), listInvitations(u.userId)]);
    return { workspaces, invitations };
  });

  app.post('/switch', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!ownDecision(req, reply)) return;
    const orgId = orgIdFrom(req, reply);
    if (!orgId) return;
    const u = req.sessionUser!;
    try {
      const workspace = await switchWorkspace({ sessionId: u.sessionId, userId: u.userId, orgId });
      return { workspace };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/home', async (req, reply) => {
    if (!ownDecision(req, reply)) return;
    const orgId = orgIdFrom(req, reply);
    if (!orgId) return;
    try {
      await setHomeWorkspace(req.sessionUser!.userId, orgId);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

export async function registerInvitationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.post('/:id/accept', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!ownDecision(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.status(404).send({ error: 'not_found', message: 'That invitation is no longer open.' });
    const u = req.sessionUser!;
    try {
      const workspace = await acceptInvitation(u.userId, id);
      // Recorded in the company that invited them — it's their event.
      await logOrgActionSafely(workspace.orgId, {
        userId: u.userId,
        action: 'invite.accept',
        resourceType: 'invite',
        resourceId: id,
        result: 'success',
      });
      return { workspace };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/:id/decline', async (req, reply) => {
    if (!ownDecision(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.status(404).send({ error: 'not_found', message: 'That invitation is no longer open.' });
    try {
      await declineInvitation(req.sessionUser!.userId, id);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

export async function registerMyWorkRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (req, reply) => {
    const q = req.query as { orgId?: string; includeDone?: string };
    if (q.orgId && !UUID.test(q.orgId)) return reply.status(400).send({ error: 'invalid_query', message: 'orgId must be a company id.' });
    return listMyWorkAcrossCompanies(req.sessionUser!.userId, { orgId: q.orgId, includeDone: q.includeDone === 'true' });
  });
}
