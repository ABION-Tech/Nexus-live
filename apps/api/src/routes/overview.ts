// Session 58 — GET /api/v1/overview: the Dashboard's alerts, headline
// numbers and latest tasks, and the sidebar's live counts (one call).
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import { getOverview } from '../services/overviewService.js';

export async function registerOverviewRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (req) => {
    const user = req.sessionUser!;
    const q = req.query as { recent?: string };
    const canReadAll = await hasPermission(user, 'tasks', 'read');
    return getOverview(user.orgId, {
      scopeUserId: canReadAll ? undefined : user.userId,
      includeEod: user.role === 'leader',
      recent: q.recent ? Number(q.recent) || 10 : 10,
    });
  });
}
