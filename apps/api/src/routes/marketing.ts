// PRD §7.2 09 COMMS & OPS → Marketing / §8.9 content calendar. Flat
// `marketing` resource grant for the calendar entry itself (create/read/
// update/delete), same shape as knowledge.ts. Each content item is
// backed by three real `tasks` rows (Script/Production/SMM per
// marketingService.ts) — reassigning or rescheduling one of those goes
// through PATCH /:id/stages/:stage below rather than the flat tasks.ts
// route, since a stage is only reachable in context of its content item
// (no standalone "list all marketing stage tasks" need exists yet).
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import {
  archiveMarketingContent,
  createMarketingContent,
  getMarketingContentWithStages,
  listMarketingContent,
  updateMarketingContent,
  updateMarketingStage,
} from '../services/marketingService.js';
import type {
  CreateMarketingContentInput,
  MarketingContentInput,
  MarketingContentStatus,
  MarketingStage,
  TaskStatus,
} from '@nexus/shared';

const VALID_STATUSES: MarketingContentStatus[] = ['planned', 'in_progress', 'posted', 'skipped'];
const VALID_STAGES: MarketingStage[] = ['script', 'production', 'smm'];
const VALID_TASK_STATUSES: TaskStatus[] = ['not_started', 'in_progress', 'blocked', 'done'];

function isValidStatus(value: unknown): value is MarketingContentStatus {
  return typeof value === 'string' && (VALID_STATUSES as string[]).includes(value);
}

function isValidStage(value: unknown): value is MarketingStage {
  return typeof value === 'string' && (VALID_STAGES as string[]).includes(value);
}

function isValidTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (VALID_TASK_STATUSES as string[]).includes(value);
}

function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export async function registerMarketingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'marketing', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'marketing'." });
      return;
    }
    const q = req.query as { status?: string; platform?: string; includeArchived?: string };
    if (q.status && !isValidStatus(q.status)) {
      reply.status(400).send({ error: 'invalid_query', message: `status must be one of: ${VALID_STATUSES.join(', ')}.` });
      return;
    }
    const items = await listMarketingContent(user.orgId, {
      status: q.status as MarketingContentStatus | undefined,
      platform: q.platform,
      includeArchived: q.includeArchived === 'true',
    });
    reply.send({ items });
  });

  // Returns the calendar entry plus its three stage tasks (script/
  // production/smm) — same "record + constituent tasks" shape as
  // GET /goals/:id, so the edit page never needs a second round trip.
  app.get('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'marketing', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'marketing'." });
      return;
    }
    const { id } = req.params as { id: string };
    const item = await getMarketingContentWithStages(user.orgId, id);
    if (!item) {
      reply.status(404).send({ error: 'not_found', message: 'Marketing content item not found.' });
      return;
    }
    reply.send(item);
  });

  // Creates the content item AND its three stage tasks in one call —
  // marketingService.createMarketingContent does this as one transaction
  // so a client never sees a partially-created item. `create` on
  // `marketing` covers this whole operation; it does not additionally
  // require `tasks.create`, since these tasks only exist as a
  // consequence of creating marketing content, not as independently
  // authored tasks.
  app.post('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'marketing', 'create'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'marketing'." });
      return;
    }
    const body = req.body as Partial<CreateMarketingContentInput>;
    if (body.status && !isValidStatus(body.status)) {
      reply.status(400).send({ error: 'invalid_body', message: `status must be one of: ${VALID_STATUSES.join(', ')}.` });
      return;
    }
    if (body.dueDate && !isValidIsoDate(body.dueDate)) {
      reply.status(400).send({ error: 'invalid_body', message: 'dueDate must be an ISO date (YYYY-MM-DD).' });
      return;
    }
    const item = await createMarketingContent(user.orgId, body as CreateMarketingContentInput, user.userId);
    reply.status(201).send(item);
  });

  // Updates the calendar entry's own fields only (type, platform, due
  // date, top-level status, post link, owner) — stage reassignment goes
  // through PATCH /:id/stages/:stage below, not here.
  app.patch('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'marketing', 'update'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'marketing'." });
      return;
    }
    const { id } = req.params as { id: string };
    const body = req.body as Partial<MarketingContentInput>;
    if (body.status && !isValidStatus(body.status)) {
      reply.status(400).send({ error: 'invalid_body', message: `status must be one of: ${VALID_STATUSES.join(', ')}.` });
      return;
    }
    if (body.dueDate && !isValidIsoDate(body.dueDate)) {
      reply.status(400).send({ error: 'invalid_body', message: 'dueDate must be an ISO date (YYYY-MM-DD).' });
      return;
    }
    const item = await updateMarketingContent(user.orgId, id, body, user.userId);
    if (!item) {
      reply.status(404).send({ error: 'not_found', message: 'Marketing content item not found or already archived.' });
      return;
    }
    reply.send(item);
  });

  // Reassign, reschedule, or update status on a single stage (script,
  // production, or smm) without touching the other two. Gated on the
  // same 'marketing' resource as the parent record — a stage task isn't
  // independently reachable via tasks.ts, so `tasks.*` grants are beside
  // the point here.
  app.patch('/:id/stages/:stage', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'marketing', 'update'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'marketing'." });
      return;
    }
    const { id, stage } = req.params as { id: string; stage: string };
    if (!isValidStage(stage)) {
      reply.status(400).send({ error: 'invalid_stage', message: `stage must be one of: ${VALID_STAGES.join(', ')}.` });
      return;
    }
    const body = req.body as { assignedToUserId?: string; deadline?: string; status?: string };
    if (body.status && !isValidTaskStatus(body.status)) {
      reply.status(400).send({ error: 'invalid_body', message: `status must be one of: ${VALID_TASK_STATUSES.join(', ')}.` });
      return;
    }
    const task = await updateMarketingStage(
      user.orgId,
      id,
      stage,
      {
        assignedToUserId: body.assignedToUserId,
        deadline: body.deadline,
        status: body.status as TaskStatus | undefined,
      },
      user.userId
    );
    if (!task) {
      reply.status(404).send({ error: 'not_found', message: 'Content item, stage, or stage task not found.' });
      return;
    }
    reply.send(task);
  });

  // Archives the calendar entry, not hard-delete — same "DELETE
  // archives" convention as knowledge.ts / goals.ts. The three stage
  // tasks are left as-is (see marketingService.archiveMarketingContent).
  app.delete('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'marketing', 'delete'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'delete' permission on 'marketing'." });
      return;
    }
    const { id } = req.params as { id: string };
    const item = await archiveMarketingContent(user.orgId, id, user.userId);
    if (!item) {
      reply.status(404).send({ error: 'not_found', message: 'Marketing content item not found or already archived.' });
      return;
    }
    reply.send(item);
  });
}
