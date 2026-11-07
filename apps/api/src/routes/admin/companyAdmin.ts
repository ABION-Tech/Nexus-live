// routes/admin/companyAdmin.ts — ADMIN_BUILD_GUIDE.md §3 "Session 6"
// (repo Session 41), Company Admin backend half. Per the guide's own locked
// table: "Company Admin = existing `leader` role. No new role, no new code —
// a leader already has full CRUD on their one org." This file adds no new
// auth primitive; the gate is isCompanyAdmin() (leader of a company-type
// org, not a group), same minimal-new-code posture as groupAdmin.ts.
//
// Four routes, matching the guide's admin shell for this half:
//   - GET /overview       — aggregate counts (people, task statuses, goals,
//                           knowledge) in one RLS-scoped withOrgContext pass.
//   - GET /analytics/overview — task + failsafe counts, proxying existing
//                           analyticsService functions unchanged.
//   - GET /automation     — proxy automationService.listAutomationControls.
//   - GET /activity       — org-scoped audit log via searchAuditLog.
//
// A fifth route, GET /people (a plain listOrgPeople proxy), shipped in
// Session 41 alongside these but was removed in Session 43's finalization
// pass: nothing on the frontend ever called it. Company Admin's People tab
// was never built — per the guide, People/Work/Goals/Knowledge deliberately
// reuse the existing top-level modules (modules/people/TeamMembers.tsx
// already calls plain GET /people via peopleService.ts, same org-scoped
// result for a leader) rather than being duplicated under /admin. The
// overview aggregate above answers `totalPeople` with its own count query,
// not by calling this route either, so it had zero real consumers.
//
// No write-side routes here: leaders already have full write access via the
// existing task/goal/knowledge/people routes. This file is a read-aggregation
// shell, not a new CRUD surface.
import type { FastifyInstance } from 'fastify';
import { isCompanyAdmin } from '../../services/authorizationService.js';
import { withOrgContext } from '../../db.js';
import { getBlockedTasks, getTaskTrends, getUpcomingDeadlines } from '../../services/analyticsService.js';
import { listAutomationControls } from '../../services/automationService.js';
import { searchAuditLog } from '../../services/auditLogService.js';
import { getOrgStorageQuota, getOrgStorageUsage } from '../../services/fileService.js';
import type { CompanyAnalyticsSummary, TaskTrendQuery } from '@nexus/shared';

async function requireCompanyAdmin(req: any, reply: any): Promise<boolean> {
  const user = req.sessionUser;
  if (!user) {
    reply.status(401).send({ error: 'unauthenticated', message: 'Sign in required.' });
    return false;
  }
  if (!(await isCompanyAdmin(user))) {
    reply.status(403).send({ error: 'forbidden', message: 'Company Admin access required.' });
    return false;
  }
  return true;
}

export async function registerCompanyAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // ---- Overview: aggregate counts in one org-scoped pass ---------------
  // Four small count queries inside one withOrgContext transaction —
  // cheaper than four separate service calls and lets the DB do the
  // aggregation rather than loading full row sets into JS just to
  // .length them. All four tables are standard tenant tables (org_id
  // column, RLS-gated) so the single-org-per-context doctrine holds.

  app.get('/overview', async (req, reply) => {
    if (!(await requireCompanyAdmin(req, reply))) return;
    const user = req.sessionUser!;

    const summary = await withOrgContext(user.orgId, async (client) => {
      const [peopleResult, taskResult, goalResult, knowledgeResult, storageUsedBytes, storageQuotaBytes] = await Promise.all([
        client.query<{ count: string }>(
          `select count(*)::int as count from org_memberships where org_id = $1`,
          [user.orgId]
        ),
        client.query<{ status: string; count: string }>(
          `select status, count(*)::int as count from tasks
            where org_id = $1 and archived_at is null
            group by status`,
          [user.orgId]
        ),
        client.query<{ count: string }>(
          `select count(*)::int as count from goals where org_id = $1 and status = 'active'`,
          [user.orgId]
        ),
        client.query<{ count: string }>(
          `select count(*)::int as count from knowledge_entries where org_id = $1 and archived_at is null`,
          [user.orgId]
        ),
        // 0023: rides this same aggregate pass rather than a new route —
        // getOrgStorageUsage/getOrgStorageQuota each open their own
        // withOrgContext internally, which is fine to run alongside this
        // outer one (same org_id, just a nested short-lived connection).
        getOrgStorageUsage(user.orgId),
        getOrgStorageQuota(user.orgId),
      ]);

      const taskCounts: Record<string, number> = {};
      for (const row of taskResult.rows) {
        taskCounts[row.status] = Number(row.count);
      }

      const result: CompanyAnalyticsSummary = {
        orgId: user.orgId,
        totalPeople: Number(peopleResult.rows[0]?.count ?? 0),
        openTasks: (taskCounts['not_started'] ?? 0) + (taskCounts['in_progress'] ?? 0),
        blockedTasks: taskCounts['blocked'] ?? 0,
        doneTasks: taskCounts['done'] ?? 0,
        activeGoals: Number(goalResult.rows[0]?.count ?? 0),
        knowledgeEntries: Number(knowledgeResult.rows[0]?.count ?? 0),
        generatedAt: new Date().toISOString(),
        storageUsedBytes,
        storageQuotaBytes,
      };
      return result;
    });

    reply.send(summary);
  });

  // ---- Analytics overview: task trends + failsafe counts ---------------
  // Proxies the same analyticsService functions the existing /analytics
  // routes already call. Not a duplication: the company admin view gets
  // these pre-assembled as one response rather than requiring the UI to
  // make three separate fetches. Same leader-sees-all default (no
  // assignedToUserId filter) since a Company Admin is always a leader.

  app.get('/analytics/overview', async (req, reply) => {
    if (!(await requireCompanyAdmin(req, reply))) return;
    const user = req.sessionUser!;
    const q = req.query as { from?: string; to?: string };

    const trendQuery: TaskTrendQuery = { from: q.from, to: q.to };
    const [trends, blocked, deadlines] = await Promise.all([
      getTaskTrends(user.orgId, trendQuery),
      getBlockedTasks(user.orgId, {}),
      getUpcomingDeadlines(user.orgId, {}),
    ]);

    reply.send({
      trends,
      blockedCount: blocked.length,
      upcomingDeadlineCount: deadlines.length,
    });
  });

  // ---- Automation: list controls ----------------------------------------
  // Direct proxy — automationService.listAutomationControls is already
  // gated by the org context, nothing extra needed here.

  app.get('/automation', async (req, reply) => {
    if (!(await requireCompanyAdmin(req, reply))) return;
    const user = req.sessionUser!;
    const controls = await listAutomationControls(user.orgId);
    reply.send({ controls });
  });

  // ---- Activity: org-scoped audit log ----------------------------------
  // searchAuditLog uses the raw pool (0021's search_audit_log function is
  // nexus_bootstrap-owned, not tenant-scoped), so the orgId parameter is
  // what scopes the results to this company's own actions — same pattern
  // as superAdmin's /audit-log but with a mandatory orgId filter rather
  // than the optional one Super Admin uses for platform-wide queries.

  app.get('/activity', async (req, reply) => {
    if (!(await requireCompanyAdmin(req, reply))) return;
    const user = req.sessionUser!;
    const q = req.query as {
      userId?: string;
      action?: string;
      resourceType?: string;
      result?: 'success' | 'forbidden' | 'error';
      since?: string;
      until?: string;
      limit?: string;
    };

    const entries = await searchAuditLog({
      orgId: user.orgId, // always scoped to this org — not overridable
      userId: q.userId,
      action: q.action,
      resourceType: q.resourceType,
      result: q.result,
      since: q.since ? new Date(q.since) : undefined,
      until: q.until ? new Date(q.until) : undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    reply.send({ entries });
  });
}
