// PRD §7.1 (\"Analytics ... permission-gated\") §8.7 domain routes —
// Phase 1: Task Trends + the two Failsafe categories that need no new
// schema. See analyticsService.ts for the scope note on why EOD/partners
// aren't here yet.
//
// Two different scoping strategies on purpose, matching tasks.ts's own
// split:
//  - /task-trends uses a new 'analytics' resource: a personal trend line
//    is a new kind of thing (not just "your tasks filtered"), so it gets
//    its own grant rather than piggybacking on 'tasks'.
//  - /failsafe/* reuses the existing 'tasks' resource: these are just
//    filtered task lists (status=blocked, deadline<=X), the same data
//    tasks.ts's own list route already gates — a second permission
//    concept for the same rows would be redundant, not more correct.
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import { getBlockedTasks, getTaskTrends, getUpcomingDeadlines } from '../services/analyticsService.js';
import { getStalePartnerFollowUps } from '../services/networkService.js';
import type { TaskTrendQuery } from '@nexus/shared';

function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export async function registerAnalyticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/task-trends', async (req, reply) => {
    const user = req.sessionUser!;
    const q = req.query as Record<string, string | undefined>;

    for (const field of ['from', 'to'] as const) {
      if (q[field] && !isValidIsoDate(q[field]!)) {
        reply.status(400).send({ error: 'invalid_date', message: `${field} must be an ISO date (YYYY-MM-DD).` });
        return;
      }
    }

    const query: TaskTrendQuery = { from: q.from, to: q.to, userId: q.userId };

    // Same fallback shape as tasks.ts's list route: no general
    // 'analytics.read' grant → force the query to the caller's own
    // trend line instead of 403ing the whole request.
    const canReadAll = await hasPermission(user, 'analytics', 'read');
    if (!canReadAll) {
      if (query.userId && query.userId !== user.userId) {
        reply.status(403).send({ error: 'forbidden', message: 'Can only view your own trend line.' });
        return;
      }
      query.userId = user.userId;
    }

    const points = await getTaskTrends(user.orgId, query);
    reply.send({ points });
  });

  app.get('/failsafe/blocked', async (req, reply) => {
    const user = req.sessionUser!;
    const canReadAll = await hasPermission(user, 'tasks', 'read');
    const assignedToUserId = canReadAll ? undefined : user.userId;
    const tasks = await getBlockedTasks(user.orgId, { assignedToUserId });
    reply.send({ tasks });
  });

  app.get('/failsafe/deadlines', async (req, reply) => {
    const user = req.sessionUser!;
    const q = req.query as { withinDays?: string };
    const withinDays = q.withinDays ? Number(q.withinDays) : 7;
    if (!Number.isFinite(withinDays) || withinDays <= 0) {
      reply.status(400).send({ error: 'invalid_within_days', message: 'withinDays must be a positive number.' });
      return;
    }

    const canReadAll = await hasPermission(user, 'tasks', 'read');
    const assignedToUserId = canReadAll ? undefined : user.userId;
    const tasks = await getUpcomingDeadlines(user.orgId, { assignedToUserId }, withinDays);
    reply.send({ tasks });
  });

  // 4th and last Failsafe category (§8.7/§8.9) — unblocked now that
  // 0008_network.sql's partnerships table exists. Same resource/scoping
  // reasoning as /failsafe/blocked and /failsafe/deadlines: reuses
  // 'network.partnerships' rather than inventing a second permission
  // concept for the same rows routes/network.ts already gates.
  app.get('/failsafe/partners', async (req, reply) => {
    const user = req.sessionUser!;
    const canReadAll = await hasPermission(user, 'network.partnerships', 'read');
    const assignedToUserId = canReadAll ? undefined : user.userId;
    const partnerships = await getStalePartnerFollowUps(user.orgId, assignedToUserId);
    reply.send({ partnerships });
  });
}
