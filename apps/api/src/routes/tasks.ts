// PRD §6.4.1 tasks/ domain routes.
//
// Permission shape here is deliberately not a single `requirePermission`
// preHandler for every route — PRD §13.3's own example grants include a
// row-dependent case that a flat preHandler can't express:
//
//   Leader      → tasks.*   → read, create, update, delete, approve
//   Team Member → tasks.own → read, update (status, notes only)
//
// A generic preHandler runs before the row is loaded, so it can't know
// whether *this* task is "your own". Read/update/archive therefore load
// the task first, then decide access with `hasPermission(...)` (the
// general grant) OR `isOwnTask(...)` (the row-specific one) — the first
// real caller of hasPermission's standalone form outside rbac.ts's own
// preHandler wrapper (SESSION_LOG Session 6 next steps #1).
//
// Create has no row yet to be "your own", so it's a flat
// `requirePermission('tasks', 'create')` gate. List is scoped to the
// caller's own tasks unless they hold the general `tasks.read` grant —
// same reasoning, applied to a collection instead of a single record.
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import {
  addTaskAssignee,
  archiveTask,
  canViewTaskThread,
  createTask,
  getTaskById,
  isOwnTask,
  listTaskAssignees,
  listTasks,
  removeTaskAssignee,
  updateTask,
  type CreateTaskInput,
  type TaskAssigneeRole,
  type UpdateTaskInput,
} from '../services/taskService.js';
import type { TaskListQuery, TaskPriority, TaskStatus } from '@nexus/shared';

const VALID_STATUSES: TaskStatus[] = ['not_started', 'in_progress', 'blocked', 'done'];
// 0033_task_priority.sql
const VALID_PRIORITIES: TaskPriority[] = ['urgent', 'high', 'medium', 'low'];
const VALID_ASSIGNEE_ROLES: TaskAssigneeRole[] = ['assignee', 'support'];

// Fields a `tasks.own` caller may set on update, per PRD §13.3's example
// grant ("update (status, notes only)"). `description` stands in for
// "notes" — see taskService.ts's UpdateTaskInput comment; there's no
// separate notes column in 0001_init.sql.
const OWN_UPDATE_FIELDS = new Set<keyof UpdateTaskInput>(['status', 'description']);

export async function registerTaskRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (req, reply) => {
    const user = req.sessionUser!;
    const q = req.query as Record<string, string | undefined>;

    const query: TaskListQuery = {
      status: q.status as TaskStatus | undefined,
      priority: q.priority as TaskPriority | undefined,
      assignedToUserId: q.assignedToUserId,
      involvingUserId: q.involvingUserId,
      goalId: q.goalId,
      includeArchived: q.includeArchived === 'true',
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    };

    if (query.status && !VALID_STATUSES.includes(query.status)) {
      reply.status(400).send({ error: 'invalid_status', message: `status must be one of ${VALID_STATUSES.join(', ')}` });
      return;
    }
    if (query.priority && !VALID_PRIORITIES.includes(query.priority)) {
      reply.status(400).send({ error: 'invalid_priority', message: `priority must be one of ${VALID_PRIORITIES.join(', ')}` });
      return;
    }

    // No general `tasks.read` grant → force the query to the caller's
    // own visibility rather than 403ing outright. PRD §13.3's
    // `tasks.own` grant is a read grant too, just scoped to a filter
    // instead of a flat allow — this is that filter being applied.
    //
    // Session 35: a caller may explicitly ask for either the narrow
    // assignment-only filter or the broader "involving me" one (assigned
    // OR support OR supervisor — the AI Analyst "My Tasks" tab and the
    // task drawer's own visibility rule use the latter). Either is fine
    // as long as it's scoped to themselves; asking for someone *else's*
    // id on either filter still 403s. If the caller didn't ask for
    // either, default to the broader `involvingUserId` filter — this is
    // a pure widening versus the old default (assignedToUserId-only), so
    // nothing that could see a task before stops being able to.
    const canReadAll = await hasPermission(user, 'tasks', 'read');
    if (!canReadAll) {
      if (query.assignedToUserId && query.assignedToUserId !== user.userId) {
        reply.status(403).send({ error: 'forbidden', message: "Can only list your own tasks." });
        return;
      }
      if (query.involvingUserId && query.involvingUserId !== user.userId) {
        reply.status(403).send({ error: 'forbidden', message: "Can only list tasks involving you." });
        return;
      }
      if (!query.assignedToUserId && !query.involvingUserId) {
        query.involvingUserId = user.userId;
      }
    }

    const result = await listTasks(user.orgId, query);
    reply.send(result);
  });

  app.get('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };

    const task = await getTaskById(user.orgId, id);
    if (!task) {
      reply.status(404).send({ error: 'not_found', message: 'Task not found.' });
      return;
    }

    const allowed = (await hasPermission(user, 'tasks', 'read')) || isOwnTask(task, user.userId);
    if (!allowed) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'tasks'." });
      return;
    }

    reply.send(task);
  });

  app.post('/', async (req, reply) => {
    const user = req.sessionUser!;

    const granted = await hasPermission(user, 'tasks', 'create');
    if (!granted) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'tasks'." });
      return;
    }

    const body = req.body as Partial<CreateTaskInput>;
    if (!body?.title || typeof body.title !== 'string') {
      reply.status(400).send({ error: 'invalid_body', message: 'title is required.' });
      return;
    }
    if (body.status && !VALID_STATUSES.includes(body.status)) {
      reply.status(400).send({ error: 'invalid_status', message: `status must be one of ${VALID_STATUSES.join(', ')}` });
      return;
    }
    if (body.priority && !VALID_PRIORITIES.includes(body.priority)) {
      reply.status(400).send({ error: 'invalid_priority', message: `priority must be one of ${VALID_PRIORITIES.join(', ')}` });
      return;
    }

    const task = await createTask(user.orgId, body as CreateTaskInput, user.userId);
    reply.status(201).send(task);
  });

  app.patch('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };

    const existing = await getTaskById(user.orgId, id);
    if (!existing) {
      reply.status(404).send({ error: 'not_found', message: 'Task not found.' });
      return;
    }

    const canUpdateAll = await hasPermission(user, 'tasks', 'update');
    const own = isOwnTask(existing, user.userId);
    if (!canUpdateAll && !own) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'tasks'." });
      return;
    }

    const body = req.body as UpdateTaskInput;
    if (body.status && !VALID_STATUSES.includes(body.status)) {
      reply.status(400).send({ error: 'invalid_status', message: `status must be one of ${VALID_STATUSES.join(', ')}` });
      return;
    }
    if (body.priority && !VALID_PRIORITIES.includes(body.priority)) {
      reply.status(400).send({ error: 'invalid_priority', message: `priority must be one of ${VALID_PRIORITIES.join(', ')}` });
      return;
    }

    let input = body;
    if (!canUpdateAll && own) {
      // Own-record grant only covers status/notes (PRD §13.3) — silently
      // drop anything else rather than 403 the whole request for one
      // extra field the client sent.
      input = Object.fromEntries(
        Object.entries(body).filter(([key]) => OWN_UPDATE_FIELDS.has(key as keyof UpdateTaskInput))
      ) as UpdateTaskInput;
    }

    const updated = await updateTask(user.orgId, id, input, user.userId);
    reply.send(updated);
  });

  // PRD §6.4.1: DELETE archives, never hard-deletes.
  app.delete('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };

    const existing = await getTaskById(user.orgId, id);
    if (!existing) {
      reply.status(404).send({ error: 'not_found', message: 'Task not found.' });
      return;
    }

    const granted = (await hasPermission(user, 'tasks', 'delete')) || isOwnTask(existing, user.userId);
    if (!granted) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'delete' permission on 'tasks'." });
      return;
    }

    const archived = await archiveTask(user.orgId, id, user.userId);
    reply.send(archived);
  });

  // Session 35 follow-up (0032_task_assignees.sql) — TaskDrawer.tsx's
  // "People on this task" panel. Read gate matches the task thread's own
  // (chat.ts's authorizeTaskThread): a general `tasks.read` grant OR
  // canViewTaskThread (assignee/support/supervisor on the task's primary
  // fields) — broader than isOwnTask, same reasoning as the thread.
  // Write gate (add/remove) matches PATCH /tasks/:id instead: `tasks.update`
  // OR isOwnTask — the same pair TaskSection.tsx's client-side `canEditTask`
  // already gates the panel's controls on, so a caller who can't see the
  // Add/Remove buttons also can't hit these routes directly.
  app.get('/:id/assignees', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };

    const task = await getTaskById(user.orgId, id);
    if (!task) {
      reply.status(404).send({ error: 'not_found', message: 'Task not found.' });
      return;
    }

    const allowed = (await hasPermission(user, 'tasks', 'read')) || canViewTaskThread(task, user.userId);
    if (!allowed) {
      reply.status(403).send({ error: 'forbidden', message: 'Missing access to this task.' });
      return;
    }

    const assignees = await listTaskAssignees(user.orgId, id);
    reply.send(assignees);
  });

  app.post('/:id/assignees', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };

    const task = await getTaskById(user.orgId, id);
    if (!task) {
      reply.status(404).send({ error: 'not_found', message: 'Task not found.' });
      return;
    }

    const allowed = (await hasPermission(user, 'tasks', 'update')) || isOwnTask(task, user.userId);
    if (!allowed) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'tasks'." });
      return;
    }

    const body = req.body as { userId?: string; role?: TaskAssigneeRole };
    if (!body?.userId || typeof body.userId !== 'string') {
      reply.status(400).send({ error: 'invalid_body', message: 'userId is required.' });
      return;
    }
    if (!body.role || !VALID_ASSIGNEE_ROLES.includes(body.role)) {
      reply.status(400).send({ error: 'invalid_role', message: `role must be one of ${VALID_ASSIGNEE_ROLES.join(', ')}` });
      return;
    }

    const created = await addTaskAssignee(user.orgId, id, body.userId, body.role, user.userId);
    if (!created) {
      reply.status(409).send({ error: 'already_exists', message: 'That person already has this role on this task.' });
      return;
    }
    reply.status(201).send(created);
  });

  app.delete('/:id/assignees/:userId/:role', async (req, reply) => {
    const user = req.sessionUser!;
    const { id, userId, role } = req.params as { id: string; userId: string; role: string };

    if (!VALID_ASSIGNEE_ROLES.includes(role as TaskAssigneeRole)) {
      reply.status(400).send({ error: 'invalid_role', message: `role must be one of ${VALID_ASSIGNEE_ROLES.join(', ')}` });
      return;
    }

    const task = await getTaskById(user.orgId, id);
    if (!task) {
      reply.status(404).send({ error: 'not_found', message: 'Task not found.' });
      return;
    }

    const allowed = (await hasPermission(user, 'tasks', 'update')) || isOwnTask(task, user.userId);
    if (!allowed) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'tasks'." });
      return;
    }

    const removed = await removeTaskAssignee(user.orgId, id, userId, role as TaskAssigneeRole, user.userId);
    if (!removed) {
      reply.status(404).send({ error: 'not_found', message: 'That person is not on this task in that role.' });
      return;
    }
    reply.status(204).send();
  });
}
