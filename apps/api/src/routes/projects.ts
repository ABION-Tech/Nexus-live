// Projects domain routes. ADMIN_BUILD_GUIDE.md §2 / mirrors
// apps/api/src/routes/goals.ts's actual structure — see projectService.ts's
// top-of-file comment for the two-read-path design this reflects.
//
// Every route here first tries the normal flat `hasPermission(user,
// 'projects', action)` check (same as goals.ts). List/detail routes fall
// back to the project_memberships path when that's false, rather than
// 403ing outright — that fallback is what makes a guest's "sees only
// their project(s)" access actually reachable through this route rather
// than only through projectService directly.
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import { pool } from '../db.js';
import {
  addProjectMember,
  archiveProject,
  createProject,
  getProjectForMember,
  getProjectWithTasks,
  listProjectsForMember,
  listProjectsWithTasks,
  ProjectMembershipError,
  removeProjectMember,
  restoreProject,
} from '../services/projectService.js';
import type { ProjectStatus } from '@nexus/shared';

const VALID_STATUSES: ProjectStatus[] = ['active', 'archived'];

export async function registerProjectRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // ADMIN_BUILD_GUIDE.md §2: "List view with inline expand" — always
  // returns ProjectWithTasks[], not bare Project[] (contrast with
  // goals.ts's GET /, which deliberately returns bare Goal[] to avoid an
  // N+1 — see ActiveGoals.tsx's comment on why). Here the summary is
  // part of the spec, not an optimization avoided.
  app.get('/', async (req, reply) => {
    const user = req.sessionUser!;
    const q = req.query as { status?: string };
    if (q.status && !VALID_STATUSES.includes(q.status as ProjectStatus)) {
      reply.status(400).send({ error: 'invalid_status', message: `status must be one of ${VALID_STATUSES.join(', ')}` });
      return;
    }

    if (await hasPermission(user, 'projects', 'read')) {
      const projects = await listProjectsWithTasks(user.orgId, q.status as ProjectStatus | undefined);
      reply.send({ projects });
      return;
    }

    // No blanket grant — fall back to project_memberships. A guest (or
    // any cross-org collaborator) reaches exactly this branch.
    let projects = await listProjectsForMember(user.userId);
    if (q.status) projects = projects.filter((p) => p.status === q.status);
    reply.send({ projects });
  });

  app.get('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };

    if (await hasPermission(user, 'projects', 'read')) {
      const project = await getProjectWithTasks(user.orgId, id);
      if (!project) {
        reply.status(404).send({ error: 'not_found', message: 'Project not found.' });
        return;
      }
      reply.send(project);
      return;
    }

    const project = await getProjectForMember(user.userId, id);
    if (!project) {
      // Same "don't distinguish not-found from not-authorized" posture
      // authorizationService/guestService already take elsewhere — a
      // guest probing project ids they're not on gets the same 404 as
      // a genuinely nonexistent id, not a 403 confirming existence.
      reply.status(404).send({ error: 'not_found', message: 'Project not found.' });
      return;
    }
    reply.send(project);
  });

  app.post('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'projects', 'create'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'projects'." });
      return;
    }
    const body = req.body as { title?: string; description?: string };
    if (!body?.title || typeof body.title !== 'string') {
      reply.status(400).send({ error: 'invalid_body', message: 'title is required.' });
      return;
    }
    const project = await createProject(user.orgId, {
      title: body.title,
      description: body.description,
      createdByUserId: user.userId,
    });
    reply.status(201).send(project);
  });

  // Archive — same 'delete'-action-tracks-the-verb reasoning goals.ts's
  // own DELETE /:id comment gives (the permissions.action CHECK
  // constraint has no 'archive' value).
  app.delete('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'projects', 'delete'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'delete' permission on 'projects'." });
      return;
    }
    const { id } = req.params as { id: string };
    const archived = await archiveProject(user.orgId, id, user.userId);
    if (!archived) {
      reply.status(404).send({ error: 'not_found', message: 'Project not found or already archived.' });
      return;
    }
    reply.send(archived);
  });

  app.post('/:id/restore', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'projects', 'update'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'projects'." });
      return;
    }
    const { id } = req.params as { id: string };
    const restored = await restoreProject(user.orgId, id, user.userId);
    if (!restored) {
      reply.status(404).send({ error: 'not_found', message: 'Project not found or not archived.' });
      return;
    }
    reply.send(restored);
  });

  // Membership management — gated on 'update' (adding/removing a member
  // is an edit to the project's own state, same reasoning goals.ts's
  // restore route gives for using 'update' over a dedicated action).
  // This is the only route in this file that can grant access to
  // someone from a *different* org (DECISIONS.md §5's sketch) — worth
  // being explicit that the 400/404 responses below intentionally don't
  // reveal whether a matched email belongs to the caller's own org or
  // another one; find_user_by_email (0003_invites.sql) is a SECURITY
  // DEFINER lookup for exactly this reason, same as inviteService.ts's
  // own use of it.
  app.post('/:id/members', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'projects', 'update'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'projects'." });
      return;
    }
    const { id } = req.params as { id: string };
    const body = req.body as { email?: string };
    if (!body?.email) {
      reply.status(400).send({ error: 'invalid_body', message: 'email is required.' });
      return;
    }

    const { rows } = await pool.query<{ id: string }>(`select id from find_user_by_email($1)`, [body.email]);
    const targetUserId = rows[0]?.id;
    if (!targetUserId) {
      reply.status(404).send({ error: 'user_not_found', message: 'No user with that email.' });
      return;
    }

    try {
      const member = await addProjectMember(user.orgId, id, targetUserId, user.userId);
      reply.status(201).send(member);
    } catch (err) {
      if (err instanceof ProjectMembershipError) {
        const status = err.code === 'not_found' ? 404 : 409;
        reply.status(status).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  app.delete('/:id/members/:userId', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'projects', 'update'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'projects'." });
      return;
    }
    const { id, userId } = req.params as { id: string; userId: string };
    const removed = await removeProjectMember(user.orgId, id, userId);
    if (!removed) {
      reply.status(404).send({ error: 'not_found', message: 'That user is not a member of this project.' });
      return;
    }
    reply.status(204).send();
  });
}
