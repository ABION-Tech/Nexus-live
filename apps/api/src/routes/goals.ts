// PRD §6.4.1 goals/ domain routes. Goals section is permission-gated
// (PRD §7.1: "Goals (permission-gated)") — every route here is a flat
// `hasPermission` check, unlike tasks.ts's own-record branch: PRD §13.3's
// example grants show goals only at the `goals.*` (leader) level, no
// `goals.own` case to account for.
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import {
  archiveGoal,
  createGoal,
  DecompositionInputError,
  getGoalWithProgress,
  GoalStateError,
  listGoals,
  regenerateGoal,
  restoreGoal,
} from '../services/goalService.js';
import { AIDecompositionError, getAIService } from '../services/aiService.js';
import { BillingLimitError } from '../services/billingService.js';
import type { GoalStatus, ProposedTaskInput } from '@nexus/shared';

const VALID_STATUSES: GoalStatus[] = ['drafting', 'active', 'archived'];

function validateProposedTasks(input: unknown): ProposedTaskInput[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return null;
  for (const item of input) {
    if (!item || typeof item.title !== 'string' || !item.title) return null;
    if (item.dependsOnIndex !== undefined && typeof item.dependsOnIndex !== 'number') return null;
  }
  return input as ProposedTaskInput[];
}

// PRD §8.5's real lifecycle is "Create goal → AI decomposes → Review
// Queue" — proposedTasks in the request body is still accepted (manual
// entry, tests, or a caller that already ran its own decomposition), but
// when it's genuinely ABSENT from the body (not an explicit `[]`, which
// means "no tasks, on purpose") this is now the AIService call site
// referenced in goalService.ts's top-of-file comment. AIService itself is
// still just the stub provider (see integrations/aiProvider.ts) — this is
// the wiring, not the real model.
async function resolveProposedTasks(
  bodyProposedTasks: unknown,
  goalTitle: string,
  orgId: string,
  actorUserId: string
): Promise<{ tasks: ProposedTaskInput[] } | { error: string; message: string; status: number }> {
  if (bodyProposedTasks === undefined) {
    try {
      const tasks = await getAIService().decomposeGoal({ orgId, goalTitle, actorUserId });
      return { tasks };
    } catch (err) {
      // Session 47: checked ahead of AIDecompositionError — a
      // usage-capped org never reaches the provider, so this is the
      // only AI-related error that can actually surface here for that
      // case. 402, not 403: this isn't a permission problem, it's a
      // "you've used what this billing period includes" one.
      if (err instanceof BillingLimitError) {
        return {
          error: err.code,
          message: err.message,
          status: 402,
        };
      }
      if (err instanceof AIDecompositionError) {
        return {
          error: 'ai_decomposition_failed',
          message: `AI decomposition failed: ${err.message} You can retry, or supply "proposedTasks" yourself in the request body.`,
          status: 502,
        };
      }
      throw err;
    }
  }
  const tasks = validateProposedTasks(bodyProposedTasks);
  if (tasks === null) {
    return {
      error: 'invalid_body',
      message: 'proposedTasks must be an array of { title, description?, reasoning?, dependsOnIndex? }.',
      status: 400,
    };
  }
  return { tasks };
}

export async function registerGoalRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'goals', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'goals'." });
      return;
    }
    const q = req.query as { status?: string };
    if (q.status && !VALID_STATUSES.includes(q.status as GoalStatus)) {
      reply.status(400).send({ error: 'invalid_status', message: `status must be one of ${VALID_STATUSES.join(', ')}` });
      return;
    }
    const goals = await listGoals(user.orgId, q.status as GoalStatus | undefined);
    reply.send({ goals });
  });

  app.get('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'goals', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'goals'." });
      return;
    }
    const { id } = req.params as { id: string };
    const goal = await getGoalWithProgress(user.orgId, id);
    if (!goal) {
      reply.status(404).send({ error: 'not_found', message: 'Goal not found.' });
      return;
    }
    reply.send(goal);
  });

  app.post('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'goals', 'create'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'goals'." });
      return;
    }

    const body = req.body as { title?: string; proposedTasks?: unknown };
    if (!body?.title || typeof body.title !== 'string') {
      reply.status(400).send({ error: 'invalid_body', message: 'title is required.' });
      return;
    }
    const resolved = await resolveProposedTasks(body.proposedTasks, body.title, user.orgId, user.userId);
    if ('error' in resolved) {
      reply.status(resolved.status).send({ error: resolved.error, message: resolved.message });
      return;
    }

    try {
      const result = await createGoal(user.orgId, {
        title: body.title,
        createdByUserId: user.userId,
        proposedTasks: resolved.tasks,
      });
      reply.status(201).send(result);
    } catch (err) {
      if (err instanceof DecompositionInputError) {
        reply.status(400).send({ error: 'invalid_dependency', message: err.message });
        return;
      }
      throw err;
    }
  });

  // PRD §6.4.1: `POST /goals/:id/regenerate → re-trigger decomposition`.
  app.post('/:id/regenerate', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'goals', 'create'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'goals'." });
      return;
    }
    const { id } = req.params as { id: string };
    const body = req.body as { proposedTasks?: unknown };

    // Regenerating via AI needs the goal's title to re-prompt with, and
    // regenerateGoal itself already re-fetches + validates the goal (must
    // exist, must be active) inside its own transaction — so this lookup
    // is done again there regardless. Fetching it here too (read-only,
    // outside that transaction) is the price of knowing whether it's even
    // worth calling the AI service before doing so; it's not a
    // race-sensitive decision since regenerateGoal re-validates state itself.
    let goalTitle: string;
    if (body?.proposedTasks === undefined) {
      const goal = await getGoalWithProgress(user.orgId, id);
      if (!goal) {
        reply.status(404).send({ error: 'not_found', message: 'Goal not found.' });
        return;
      }
      goalTitle = goal.title;
    } else {
      goalTitle = ''; // unused — proposedTasks is present, resolveProposedTasks won't call the AI service
    }

    const resolved = await resolveProposedTasks(body?.proposedTasks, goalTitle, user.orgId, user.userId);
    if ('error' in resolved) {
      reply.status(resolved.status).send({ error: resolved.error, message: resolved.message });
      return;
    }

    try {
      const result = await regenerateGoal(user.orgId, id, resolved.tasks);
      reply.send(result);
    } catch (err) {
      if (err instanceof GoalStateError) {
        const status = err.message === 'not_found' ? 404 : 409;
        reply.status(status).send({
          error: err.message,
          message: err.message === 'not_found' ? 'Goal not found.' : 'Cannot regenerate an archived goal.',
        });
        return;
      }
      if (err instanceof DecompositionInputError) {
        reply.status(400).send({ error: 'invalid_dependency', message: err.message });
        return;
      }
      throw err;
    }
  });

  // PRD §13.3's example grant text says "archive" for this action, but
  // the actual `permissions.action` CHECK constraint (0001_init.sql) —
  // and `rbac.ts`'s `PermissionAction` type, which mirrors it — only
  // allows read/create/update/delete/approve/export; "archive" isn't
  // one of them. Using 'delete' here for the same reason tasks.ts does:
  // the HTTP verb is DELETE, the actual effect is archive-not-hard-delete,
  // and the permission action tracks the verb, not the storage detail.
  app.delete('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'goals', 'delete'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'delete' permission on 'goals'." });
      return;
    }
    const { id } = req.params as { id: string };
    const archived = await archiveGoal(user.orgId, id, user.userId);
    if (!archived) {
      reply.status(404).send({ error: 'not_found', message: 'Goal not found or already archived.' });
      return;
    }
    reply.send(archived);
  });

  // Not in the original PRD §6.4.1 route list (only archive was
  // specified) — added as the counterpart to `DELETE /:id` so archived
  // goals aren't a one-way trip. Gated on 'update' rather than 'delete':
  // PRD §13.3's example grant text lists update alongside delete for
  // `goals.*`, and restoring is semantically an update to the goal's
  // status, not a repeat of the delete action.
  app.post('/:id/restore', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'goals', 'update'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'goals'." });
      return;
    }
    const { id } = req.params as { id: string };
    const restored = await restoreGoal(user.orgId, id, user.userId);
    if (!restored) {
      reply.status(404).send({ error: 'not_found', message: 'Goal not found or not archived.' });
      return;
    }
    reply.send(restored);
  });
}
