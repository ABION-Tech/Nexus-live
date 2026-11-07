// routes/admin/groupAdmin.ts — ADMIN_BUILD_GUIDE.md §3 "Session 6"
// (repo Session 41), Group Admin backend half. Per the guide's own
// locked table, "Group Admin" is not a new role — it's `leader` on a
// membership where the org is `org_type = 'group'` — so this file adds
// no new auth primitive of its own beyond authorizationService.
// isGroupAdmin() (this session), and leans entirely on canReadOrg's
// existing group_read rule / withAuthorizedOrgContext (both fixed and
// verified live in Session 40) for every actual data read below.
//
// Two routes, matching exactly what the guide calls out for this half:
//   - GET /companies — the companies-in-group read, reusing
//     organizationService.listCompaniesInGroup() as-is (it already
//     takes (actor, groupOrgId); here groupOrgId is simply the caller's
//     own current org, since a Group Admin's group *is* their org).
//   - GET /analytics/overview — an N-query merge scoped to this one
//     group's children, same doctrine as superAdmin.ts's platform-wide
//     analytics (DECISIONS.md §5's corollary: never a single widened
//     query across orgs) but N here is "however many companies this
//     group actually has", not a fixed handful of platform-wide counts.
import type { FastifyInstance } from 'fastify';
import { isGroupAdmin, withAuthorizedOrgContext } from '../../services/authorizationService.js';
import { listCompaniesInGroup } from '../../services/organizationService.js';
import { searchAuditLog } from '../../services/auditLogService.js';
import type { GroupAnalyticsSummary } from '@nexus/shared';

async function requireGroupAdmin(req: any, reply: any): Promise<boolean> {
  const user = req.sessionUser;
  if (!user) {
    reply.status(401).send({ error: 'unauthenticated', message: 'Sign in required.' });
    return false;
  }
  if (!(await isGroupAdmin(user))) {
    reply.status(403).send({ error: 'forbidden', message: 'Group Admin access required.' });
    return false;
  }
  return true;
}

export async function registerGroupAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // ---- Companies in this group -----------------------------------------

  app.get('/companies', async (req, reply) => {
    if (!(await requireGroupAdmin(req, reply))) return;
    const user = req.sessionUser!;
    // A Group Admin's group is their own current org — canReadOrg's
    // 'own' branch authorizes this without needing the group_read rule
    // at all (that rule is for a *different* org's data; this is the
    // caller's own directory row and its listed children).
    const companies = await listCompaniesInGroup(user, user.orgId);
    reply.send({ companies });
  });

  // ---- Group-scoped aggregate analytics ---------------------------------

  app.get('/analytics/overview', async (req, reply) => {
    if (!(await requireGroupAdmin(req, reply))) return;
    const user = req.sessionUser!;
    const companies = await listCompaniesInGroup(user, user.orgId);

    // N-query merge, N = this group's own company count — not the whole
    // platform. Each count is read through withAuthorizedOrgContext (not
    // a plain withOrgContext) so this genuinely re-exercises canReadOrg's
    // group_read rule per child, the same primitive the guide names by
    // name for this session, rather than trusting the earlier
    // listCompaniesInGroup() authorization to cover a materially
    // different read (that call authorized the group's own directory
    // row; this authorizes each child's own tenant data).
    let totalUsers = 0;
    for (const company of companies) {
      totalUsers += await withAuthorizedOrgContext(user, company.id, async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `select count(*) as count from org_memberships where org_id = $1`,
          [company.id]
        );
        return Number(rows[0]?.count ?? 0);
      });
    }

    const summary: GroupAnalyticsSummary = {
      groupOrgId: user.orgId,
      totalCompanies: companies.length,
      activeCompanies: companies.filter((c) => c.active).length,
      totalUsers,
      generatedAt: new Date().toISOString(),
    };
    reply.send(summary);
  });

  // ---- Activity: this group's own audit log ------------------------------
  // Session 42 (dashboard UI pass) — the guide's Session 6 dashboard shell
  // names an Activity tab for Group Admin same as it does for Company
  // Admin, but the backend half (Session 41) only shipped Companies +
  // Analytics. Added here rather than left as a UI gap: same shape as
  // companyAdmin.ts's own /activity (searchAuditLog with a mandatory,
  // non-overridable orgId filter — the group's own org id, not a
  // per-child merge, since audit_log rows are written against the org
  // the action happened in and a group admin's own actions/organization-
  // level events are what this tab is for, not a synthetic cross-company
  // feed — company-level activity is each company's own admin's concern).
  app.get('/activity', async (req, reply) => {
    if (!(await requireGroupAdmin(req, reply))) return;
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
      orgId: user.orgId, // always this group's own org — not overridable
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
