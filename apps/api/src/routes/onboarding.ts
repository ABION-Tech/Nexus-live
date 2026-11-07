// PRD §7.2 04 PEOPLE → Onboarding routes.
//
// Two permission shapes, matching the two-part model in
// onboardingService.ts:
//  - Template (steps): flat `onboarding.create`/`update`/`delete` grants,
//    same style as approvals.ts/goals.ts — "leaders, or those authorized"
//    per the product ask, which is exactly what a resource+action grant
//    already expresses (leaders bypass via rbac.ts's role check; anyone
//    else needs an explicit `permissions` row). Reading the template
//    (GET /steps) is requireAuth-only, same reasoning people.ts gives for
//    its own read: every org member needs to see the checklist to work
//    through it, it isn't sensitive.
//  - Checklist (progress): row-branching, same shape as tasks.ts's check
//    4 — a user can always read/toggle their *own* checklist with no
//    grant needed (self-service, like eod.ts's own-filing case); acting
//    on someone else's requires `onboarding.update`.
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import {
  OnboardingError,
  archiveStep,
  createStep,
  getChecklistForUser,
  listSteps,
  setStepCompletion,
  updateStep,
  type StepInput,
} from '../services/onboardingService.js';

export async function registerOnboardingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/steps', async (req, reply) => {
    const user = req.sessionUser!;
    // includeInactive is only honoured for someone who could have
    // deactivated a step in the first place — otherwise it's just the
    // live checklist template everyone sees.
    const q = req.query as { includeInactive?: string };
    const wantsInactive = q.includeInactive === 'true' && (await hasPermission(user, 'onboarding', 'update'));
    const steps = await listSteps(user.orgId, wantsInactive);
    reply.send({ steps });
  });

  app.post('/steps', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'onboarding', 'create'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'onboarding'." });
      return;
    }
    const body = req.body as Partial<StepInput>;
    if (!body?.title || typeof body.title !== 'string') {
      reply.status(400).send({ error: 'invalid_body', message: 'title is required.' });
      return;
    }
    const step = await createStep(user.orgId, body as StepInput);
    reply.status(201).send(step);
  });

  app.patch('/steps/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'onboarding', 'update'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'onboarding'." });
      return;
    }
    const { id } = req.params as { id: string };
    try {
      const step = await updateStep(user.orgId, id, req.body as Partial<StepInput>);
      reply.send(step);
    } catch (err) {
      if (err instanceof OnboardingError) {
        reply.status(404).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  // Archives (soft-deletes), never hard-deletes — see onboardingService's
  // comment on why, same convention as tasks/goals' own DELETE.
  app.delete('/steps/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'onboarding', 'delete'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'delete' permission on 'onboarding'." });
      return;
    }
    const { id } = req.params as { id: string };
    try {
      const step = await archiveStep(user.orgId, id);
      reply.send(step);
    } catch (err) {
      if (err instanceof OnboardingError) {
        reply.status(404).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  app.get('/checklist', async (req, reply) => {
    const user = req.sessionUser!;
    const q = req.query as { userId?: string };
    const targetUserId = q.userId ?? user.userId;

    if (targetUserId !== user.userId) {
      const granted = await hasPermission(user, 'onboarding', 'read');
      if (!granted) {
        reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'onboarding'." });
        return;
      }
    }

    const checklist = await getChecklistForUser(user.orgId, targetUserId);
    reply.send({ checklist });
  });

  app.patch('/checklist/:stepId', async (req, reply) => {
    const user = req.sessionUser!;
    const { stepId } = req.params as { stepId: string };
    const body = req.body as { userId?: string; completed?: boolean };

    if (typeof body?.completed !== 'boolean') {
      reply.status(400).send({ error: 'invalid_body', message: 'completed (boolean) is required.' });
      return;
    }

    const targetUserId = body.userId ?? user.userId;
    if (targetUserId !== user.userId) {
      const granted = await hasPermission(user, 'onboarding', 'update');
      if (!granted) {
        reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'onboarding' to edit another user's checklist." });
        return;
      }
    }

    try {
      const item = await setStepCompletion(user.orgId, stepId, targetUserId, body.completed, user.userId);
      reply.send(item);
    } catch (err) {
      if (err instanceof OnboardingError) {
        reply.status(404).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });
}
