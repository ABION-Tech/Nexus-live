// PRD §13.3 grant/revoke — the editable half of the permissions model
// rbac.ts's `hasPermission`/`requirePermission` only ever read from.
// Flat `permissions` resource grant, same reasoning as automation.ts's
// header for its own flat `automation` resource: managing who can do
// what has no "own record" case the way tasks' assignee-branch does.
//
// Deliberately not leader-hardcoded: a leader can delegate grant/revoke
// itself to a trusted non-leader via a `permissions` row the same way as
// any other resource (rbac.ts has no special case for this resource) —
// consistent with every other route here trusting the flat grants table
// rather than a `role === 'leader'` check sprinkled through handlers.
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import { grantPermission, listPermissionsForUser, revokePermission, UserNotInOrgError } from '../services/permissionService.js';
import { PERMISSION_RESOURCE_ACTIONS } from '@nexus/shared';
import type { PermissionAction } from '@nexus/shared';

function isKnownResourceAction(resource: unknown, action: unknown): resource is string {
  if (typeof resource !== 'string' || typeof action !== 'string') return false;
  const allowed = PERMISSION_RESOURCE_ACTIONS[resource];
  return allowed !== undefined && (allowed as string[]).includes(action);
}

export async function registerPermissionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // GET /permissions?userId=... — a specific user's grants. No
  // list-everyone-in-the-org endpoint: the Team & Roles UI already has
  // the roster from GET /people and asks per-user, on demand, when a
  // row's drawer opens — an org-wide dump would just be that same data
  // refetched and re-grouped client-side for no caller that needs it yet.
  app.get('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'permissions', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'permissions'." });
      return;
    }
    const q = req.query as { userId?: string };
    if (!q.userId) {
      reply.status(400).send({ error: 'invalid_query', message: 'userId is required.' });
      return;
    }
    const permissions = await listPermissionsForUser(user.orgId, q.userId);
    reply.send({ permissions });
  });

  app.post('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'permissions', 'create'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'permissions'." });
      return;
    }
    const body = req.body as { userId?: string; resource?: string; action?: string };
    if (!body?.userId || !isKnownResourceAction(body.resource, body.action)) {
      reply.status(400).send({
        error: 'invalid_body',
        message: 'userId is required, and resource/action must be a pair this app actually gates.',
      });
      return;
    }
    try {
      const permission = await grantPermission(user.orgId, user.userId, body.userId, body.resource, body.action as PermissionAction);
      reply.status(201).send(permission);
    } catch (err) {
      if (err instanceof UserNotInOrgError) {
        reply.status(404).send({ error: 'not_found', message: err.message });
        return;
      }
      throw err;
    }
  });

  app.delete('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'permissions', 'delete'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'delete' permission on 'permissions'." });
      return;
    }
    const { id } = req.params as { id: string };
    const revoked = await revokePermission(user.orgId, id);
    if (!revoked) {
      reply.status(404).send({ error: 'not_found', message: 'No such grant.' });
      return;
    }
    reply.status(204).send();
  });
}
