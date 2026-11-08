// routes/admin/superAdmin.ts — ADMIN_BUILD_GUIDE.md §3 "Session 4 —
// Super Admin backend" (repo Session 40). Every route here is gated on
// isPlatformAdmin() first, before anything else runs — this file is the
// one HTTP surface for the "Super Admin cross-org read path built and
// reviewed as its own isolated unit" the guide calls out by name; the
// isolation itself lives in authorizationService.ts (Session 37) and
// the 0019/0020/0021 migrations (this session) — this file is the thin
// route layer on top, not where the trust decisions are made.
//
// Not yet registered in server.ts by design intent of routes/admin's
// own README until this file existed — registered at the bottom of
// this session's server.ts change, same as every other route module.
import type { FastifyInstance } from 'fastify';
import { isPlatformAdmin, OrgAccessDeniedError } from '../../services/authorizationService.js';
import {
  createOrganization,
  updateOrganization,
  deactivateOrganization,
  assignCompanyToGroup,
  listCompaniesInGroup,
  OrganizationError,
  toOrganization,
} from '../../services/organizationService.js';
import { logPlatformActionSafely, searchAuditLog } from '../../services/auditLogService.js';
import { getSystemHealth } from '../../services/systemMetricsService.js';
import { listBillingPendingReview, resolveBillingReviewEntry } from '../../services/billingService.js';
import { pool } from '../../db.js';
import { listOrgPeople } from '../../services/peopleService.js';
import { createInvite, listPendingInvites, revokeInvite, InviteError } from '../../services/inviteService.js';
import { checkSeatLimit, BillingLimitError, getBillingSummary, setOrgBillingTierManually } from '../../services/billingService.js';
import { sendInviteEmail, getUserDisplayName } from '../../services/emailService.js';
import {
  addPlatformAdmin,
  changeMemberRole,
  listPlatformAdmins,
  removePlatformAdmin,
  MEMBER_ROLES,
  TeamAdminError,
} from '../../services/teamAdminService.js';
import type { MemberRole } from '@nexus/shared';
import type { OrgType, PlatformUserSummary, PlatformAnalyticsSummary, BillingTierKey, BillingStatusKey } from '@nexus/shared';

async function requirePlatformAdmin(req: any, reply: any): Promise<boolean> {
  const user = req.sessionUser;
  if (!user) {
    reply.status(401).send({ error: 'unauthenticated', message: 'Sign in required.' });
    return false;
  }
  if (!(await isPlatformAdmin(user.userId))) {
    reply.status(403).send({ error: 'forbidden', message: 'Super Admin access required.' });
    return false;
  }
  return true;
}

export async function registerSuperAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // ---- Organizations: Groups & Companies CRUD --------------------------

  app.post('/organizations', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const user = req.sessionUser!;
    const body = req.body as { name?: string; orgType?: OrgType; parentOrgId?: string };
    if (!body?.name || (body.orgType !== 'group' && body.orgType !== 'company')) {
      reply.status(400).send({ error: 'invalid_body', message: 'name and orgType (group|company) are required.' });
      return;
    }
    try {
      const org = await createOrganization(user, { name: body.name, orgType: body.orgType, parentOrgId: body.parentOrgId });
      await logPlatformActionSafely({
        userId: user.userId,
        action: 'organization.create',
        resourceType: 'organization',
        resourceId: org.id,
        result: 'success',
        newValue: org,
      });
      reply.status(201).send(org);
    } catch (err) {
      if (err instanceof OrganizationError) {
        reply.status(err.code === 'forbidden' ? 403 : 400).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  app.patch('/organizations/:id', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };
    const body = req.body as { name?: string; plan?: 'free' | 'paid'; active?: boolean };
    try {
      const org = await updateOrganization(user, id, body);
      if (!org) {
        reply.status(404).send({ error: 'not_found', message: 'No such organization.' });
        return;
      }
      // Plan changes get their own action label so the audit trail can
      // be filtered on "who changed billing tier and when" specifically
      // (PRD §13.10 / this session's own plan-change endpoint requirement)
      // rather than folded into a generic "organization.update".
      const action = body.plan !== undefined ? 'organization.plan_change' : 'organization.update';
      await logPlatformActionSafely({
        userId: user.userId,
        action,
        resourceType: 'organization',
        resourceId: id,
        result: 'success',
        newValue: body,
      });
      reply.send(org);
    } catch (err) {
      if (err instanceof OrganizationError) {
        reply.status(err.code === 'forbidden' ? 403 : 400).send({ error: err.code, message: err.message });
        return;
      }
      if (err instanceof OrgAccessDeniedError) {
        reply.status(403).send({ error: 'forbidden', message: err.message });
        return;
      }
      throw err;
    }
  });

  app.post('/organizations/:id/deactivate', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };
    const org = await deactivateOrganization(user, id);
    if (!org) {
      reply.status(404).send({ error: 'not_found', message: 'No such organization.' });
      return;
    }
    await logPlatformActionSafely({
      userId: user.userId,
      action: 'organization.deactivate',
      resourceType: 'organization',
      resourceId: id,
      result: 'success',
    });
    reply.send(org);
  });

  app.post('/organizations/:id/assign-group', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };
    const body = req.body as { groupOrgId?: string | null };
    try {
      const org = await assignCompanyToGroup(user, id, body.groupOrgId ?? null);
      await logPlatformActionSafely({
        userId: user.userId,
        action: 'organization.assign_group',
        resourceType: 'organization',
        resourceId: id,
        result: 'success',
        newValue: { groupOrgId: body.groupOrgId ?? null },
      });
      reply.send(org);
    } catch (err) {
      if (err instanceof OrganizationError) {
        reply.status(err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  app.get('/organizations/:id/companies', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };
    try {
      const companies = await listCompaniesInGroup(user, id);
      reply.send({ companies });
    } catch (err) {
      if (err instanceof OrgAccessDeniedError) {
        reply.status(403).send({ error: 'forbidden', message: err.message });
        return;
      }
      throw err;
    }
  });

  // ---- Investigation: search + drill-down -------------------------------
  // Both routed through the 0019 nexus_bootstrap search functions —
  // genuinely cross-org, no-single-target queries per that migration's
  // own header comment ("list every organization", "find every user
  // matching this name/email, in any org").

  app.get('/investigate/organizations', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const q = req.query as { q?: string };
    const { rows } = await pool.query(`select * from search_organizations($1)`, [q.q ?? null]);
    // Session 53: map to the camelCase Organization shape the web app
    // reads. Raw rows (org_type, created_at, parent_org_id) left the
    // Organizations table's Type column blank and its dates invalid.
    reply.send({ organizations: rows.map(toOrganization) });
  });

  app.get('/investigate/users', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const q = req.query as { q?: string };
    const { rows } = await pool.query<{
      id: string;
      name: string;
      email: string;
      home_org_id: string | null;
      home_org_name: string | null;
      role: string | null;
      created_at: Date;
    }>(`select * from search_users_platform($1)`, [q.q ?? null]);
    const users: PlatformUserSummary[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      homeOrgId: r.home_org_id ?? undefined,
      homeOrgName: r.home_org_name ?? undefined,
      role: r.role ?? undefined,
      createdAt: r.created_at.toISOString(),
    }));
    reply.send({ users });
  });

  // ---- Platform-wide analytics (N-query merge) --------------------------
  // Deliberately several small raw-pool queries against nexus_bootstrap-
  // granted tables/functions, merged in JS — same "N of these merged at
  // the API layer, never a single widened query" doctrine
  // authorizationService.ts's own doc comments already establish for
  // every other cross-org read in this codebase (DECISIONS.md §5's
  // corollary).
  //
  // organizations/users counts route through 0022's nexus_bootstrap-owned
  // functions, not a plain `select ... from organizations`/`from users` —
  // both tables carry `force row level security`, and a real production
  // connection (`nexus_app`, NOBYPASSRLS) has no `app.current_org_id` set
  // on this raw pool, so an unguarded query here silently returns zero
  // rows always. Confirmed live this session (0022's own header comment
  // has the full repro). `platform_admins` has no RLS at all
  // (0016_admin_foundation.sql never enabled it) so that count is left as
  // a plain query — it was never actually broken.
  app.get('/analytics/overview', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const { rows: orgRows } = await pool.query<{ org_type: OrgType; active: boolean; org_count: string }>(
      `select * from platform_organization_counts()`
    );
    const { rows: userRows } = await pool.query<{ platform_user_count: string }>(`select platform_user_count()`);
    const { rows: adminRows } = await pool.query<{ count: string }>(`select count(*) as count from platform_admins`);

    let totalGroups = 0;
    let totalCompanies = 0;
    let activeOrganizations = 0;
    for (const row of orgRows) {
      const n = Number(row.org_count);
      if (row.org_type === 'group') totalGroups += n;
      if (row.org_type === 'company') totalCompanies += n;
      if (row.active) activeOrganizations += n;
    }

    const summary: PlatformAnalyticsSummary = {
      totalOrganizations: totalGroups + totalCompanies,
      totalGroups,
      totalCompanies,
      activeOrganizations,
      totalUsers: Number(userRows[0]?.platform_user_count ?? 0),
      totalPlatformAdmins: Number(adminRows[0]?.count ?? 0),
      generatedAt: new Date().toISOString(),
    };
    reply.send(summary);
  });

  // ---- System health ------------------------------------------------------

  app.get('/system-health', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const report = await getSystemHealth();
    reply.send(report);
  });

  // ---- Audit query/filter --------------------------------------------------

  app.get('/audit-log', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const q = req.query as {
      orgId?: string;
      userId?: string;
      action?: string;
      resourceType?: string;
      result?: 'success' | 'forbidden' | 'error';
      since?: string;
      until?: string;
      limit?: string;
    };
    const entries = await searchAuditLog({
      orgId: q.orgId,
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

  // ---- Billing review queue (Session 47) -----------------------------------
  // §1's locked decision: a past-due org that runs out its grace period
  // (automationJobs.ts's runBillingGraceCheck) lands here, not an
  // automatic suspend. These two routes are the entire Super Admin side
  // of that — list the queue, resolve one entry.

  app.get('/billing/review-queue', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const entries = await listBillingPendingReview();
    reply.send({ entries });
  });

  app.post('/billing/review-queue/:orgId/resolve', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const user = req.sessionUser!;
    const { orgId } = req.params as { orgId: string };
    const body = req.body as { tier?: string; billingStatus?: string; note?: string };

    const validTiers = ['free', 'starter', 'pro'];
    const validStatuses = ['active', 'past_due', 'pending_review', 'suspended'];
    if (body.tier !== undefined && !validTiers.includes(body.tier)) {
      reply.status(400).send({ error: 'invalid_body', message: `tier must be one of ${validTiers.join(', ')}.` });
      return;
    }
    if (body.billingStatus !== undefined && !validStatuses.includes(body.billingStatus)) {
      reply.status(400).send({ error: 'invalid_body', message: `billingStatus must be one of ${validStatuses.join(', ')}.` });
      return;
    }

    const resolved = await resolveBillingReviewEntry(
      orgId,
      (body.tier as BillingTierKey | undefined) ?? null,
      (body.billingStatus as BillingStatusKey | undefined) ?? 'active',
      body.note ?? null,
      user.userId
    );
    if (!resolved) {
      reply.status(404).send({ error: 'not_found', message: 'No org_billing row found for that org.' });
      return;
    }

    await logPlatformActionSafely({
      userId: user.userId,
      action: 'billing.review_resolved',
      resourceType: 'org_billing',
      resourceId: orgId,
      result: 'success',
      newValue: resolved,
      metadata: { tier: body.tier, billingStatus: body.billingStatus, note: body.note },
    });

    reply.send(resolved);
  });

  // ---- Session 53: people, invites and Super Admins -----------------------
  // A Super Admin can manage any organization's people directly. This is
  // how a new company gets its first admin: create the company, then
  // invite its leader from here (ordinary org invites only ever go into
  // the inviter's own org).

  function teamAdminErrorStatus(err: TeamAdminError): number {
    if (err.code === 'not_found') return 404;
    if (err.code === 'invalid') return 400;
    if (err.code === 'self') return 403;
    return 409;
  }

  app.get('/organizations/:id/members', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const { id } = req.params as { id: string };
    const [people, invites] = await Promise.all([listOrgPeople(id), listPendingInvites(id)]);
    reply.send({ people: people.filter((p) => p.role !== 'guest'), invites });
  });

  app.post('/organizations/:id/invites', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };
    const body = req.body as { email?: string; role?: string };
    const email = body?.email?.trim() ?? '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      reply.status(400).send({ error: 'invalid_body', message: 'A valid email is required.' });
      return;
    }
    if (!MEMBER_ROLES.includes(body.role as MemberRole)) {
      reply.status(400).send({ error: 'invalid_body', message: `role must be one of ${MEMBER_ROLES.join(', ')}` });
      return;
    }
    try {
      await checkSeatLimit(id);
      const invite = await createInvite({ orgId: id, email, role: body.role as MemberRole, invitedBy: user.userId });
      await logPlatformActionSafely({
        userId: user.userId,
        action: 'organization.invite',
        resourceType: 'invite',
        resourceId: invite.id,
        result: 'success',
        newValue: { orgId: id, email: invite.email, role: invite.role },
      });
      getUserDisplayName(user.orgId, user.userId)
        .then((name) => sendInviteEmail(invite, name))
        .catch((err) => req.log.warn({ err, inviteId: invite.id }, 'Failed to send invite email'));
      reply.status(201).send(invite);
    } catch (err) {
      if (err instanceof BillingLimitError) {
        reply.status(err.statusCode).send({ error: err.code, message: err.message });
        return;
      }
      if (err instanceof InviteError) {
        reply.status(409).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  app.delete('/organizations/:id/invites/:inviteId', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const user = req.sessionUser!;
    const { id, inviteId } = req.params as { id: string; inviteId: string };
    try {
      await revokeInvite(id, inviteId);
      await logPlatformActionSafely({
        userId: user.userId,
        action: 'organization.invite_revoke',
        resourceType: 'invite',
        resourceId: inviteId,
        result: 'success',
        newValue: { orgId: id },
      });
      reply.status(204).send();
    } catch (err) {
      if (err instanceof InviteError) {
        reply.status(404).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  app.patch('/organizations/:id/members/:userId/role', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const user = req.sessionUser!;
    const { id, userId } = req.params as { id: string; userId: string };
    const body = req.body as { role?: string };
    try {
      const result = await changeMemberRole({ orgId: id, userId, role: body?.role as MemberRole });
      await logPlatformActionSafely({
        userId: user.userId,
        action: 'organization.member_role_change',
        resourceType: 'user',
        resourceId: userId,
        result: 'success',
        previousValue: { role: result.previousRole },
        newValue: { orgId: id, role: result.role },
      });
      reply.send(result);
    } catch (err) {
      if (err instanceof TeamAdminError) {
        reply.status(teamAdminErrorStatus(err)).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  // Session 53 — read and set an organization's plan by hand. Without
  // this a company stuck on Free (5 seats) can't invite anyone, and
  // there's no way to comp internal companies before Paystack is live.
  app.get('/organizations/:id/billing', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const { id } = req.params as { id: string };
    reply.send(await getBillingSummary(id));
  });

  app.patch('/organizations/:id/billing', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };
    const body = req.body as { tier?: string; cascadesToChildren?: boolean; note?: string };
    if (!body?.tier || !['free', 'starter', 'pro'].includes(body.tier)) {
      reply.status(400).send({ error: 'invalid_body', message: 'tier must be one of free, starter, pro' });
      return;
    }
    const before = await getBillingSummary(id).catch(() => null);
    const summary = await setOrgBillingTierManually({
      orgId: id,
      tier: body.tier as BillingTierKey,
      cascadesToChildren: typeof body.cascadesToChildren === 'boolean' ? body.cascadesToChildren : undefined,
      note: body.note?.trim() || null,
      actorUserId: user.userId,
    });
    await logPlatformActionSafely({
      userId: user.userId,
      action: 'organization.billing_set_manually',
      resourceType: 'organization',
      resourceId: id,
      result: 'success',
      previousValue: before ? { tier: before.tier, billingStatus: before.billingStatus } : undefined,
      newValue: { tier: summary.tier, billingStatus: summary.billingStatus },
    });
    reply.send(summary);
  });

  app.get('/platform-admins', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const admins = await listPlatformAdmins();
    reply.send({ admins });
  });

  app.post('/platform-admins', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const user = req.sessionUser!;
    const body = req.body as { email?: string; homeOrgId?: string; role?: string };
    const email = body?.email?.trim() ?? '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      reply.status(400).send({ error: 'invalid_body', message: 'A valid email is required.' });
      return;
    }
    if (body.role !== undefined && !MEMBER_ROLES.includes(body.role as MemberRole)) {
      reply.status(400).send({ error: 'invalid_body', message: `role must be one of ${MEMBER_ROLES.join(', ')}` });
      return;
    }
    try {
      const result = await addPlatformAdmin({
        email,
        actorUserId: user.userId,
        homeOrgId: body.homeOrgId || undefined,
        role: (body.role as MemberRole | undefined) ?? undefined,
      });
      await logPlatformActionSafely({
        userId: user.userId,
        action: result.status === 'granted' ? 'platform_admin.grant' : 'platform_admin.invite',
        resourceType: result.status === 'granted' ? 'user' : 'invite',
        resourceId: result.status === 'granted' ? result.admin.userId : result.invite.id,
        result: 'success',
        newValue: { email },
      });
      if (result.status === 'invited') {
        const invite = result.invite;
        getUserDisplayName(user.orgId, user.userId)
          .then((name) => sendInviteEmail(invite, name))
          .catch((err) => req.log.warn({ err, inviteId: invite.id }, 'Failed to send Super Admin invite email'));
      }
      reply.status(result.status === 'granted' ? 200 : 201).send(result);
    } catch (err) {
      if (err instanceof TeamAdminError) {
        reply.status(teamAdminErrorStatus(err)).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  app.delete('/platform-admins/:userId', async (req, reply) => {
    if (!(await requirePlatformAdmin(req, reply))) return;
    const user = req.sessionUser!;
    const { userId } = req.params as { userId: string };
    try {
      await removePlatformAdmin({ actorUserId: user.userId, userId });
      await logPlatformActionSafely({
        userId: user.userId,
        action: 'platform_admin.revoke',
        resourceType: 'user',
        resourceId: userId,
        result: 'success',
      });
      reply.status(204).send();
    } catch (err) {
      if (err instanceof TeamAdminError) {
        reply.status(teamAdminErrorStatus(err)).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });
}
