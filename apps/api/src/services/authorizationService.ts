// ADMIN_BUILD_GUIDE.md §1 (repo Session 37): "Consolidate hasPermission/
// rbac.ts into one authorizationService.ts." This file is now the single
// source of truth for all four PRD §13.3 authorization checks; rbac.ts
// becomes a thin re-export so the ~15 existing route files that import
// `hasPermission`/`requirePermission`/`PermissionAction` from
// '../plugins/rbac.js' don't all need touching in this session.
//
// New in this session, on top of what rbac.ts already had:
//   - isPlatformAdmin() — Super Admin, checked ahead of the org-scoped
//     chain entirely (guide §1: "not an org concept").
//   - canReadOrg() — the one new authorization rule the guide calls out
//     as highest-risk: a leader of a group gets read-scoped access to
//     any company where parent_org_id = that group.
//   - withAuthorizedOrgContext() — canReadOrg() + withOrgContext() in one
//     call, so every future cross-org read (group dashboards, Super
//     Admin drill-downs) goes through the same authorization gate rather
//     than each call site re-deriving it. Still one org per query
//     (DECISIONS.md §5's corollary) — this helper does not merge results
//     across orgs itself, callers loop and merge at the API layer.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool, withOrgContext } from '../db.js';
import type { SessionUser } from './sessionService.js';
import type { PermissionAction } from '@nexus/shared';
import type { PoolClient } from 'pg';

export type { PermissionAction };

/** Unchanged from rbac.ts's original hasPermission — same leader-bypass,
 * same org-scoped `permissions` lookup. A `guest` membership has no
 * bypass and (per 0016's design note) no row is ever auto-granted to
 * it, so this returns false for a guest on every resource+action unless
 * a leader explicitly grants one via permissionService.grantPermission —
 * exactly the "most restrictive default" the guide asks for, with no
 * special-case code needed here for it. */
export async function hasPermission(
  user: SessionUser,
  resource: string,
  action: PermissionAction
): Promise<boolean> {
  if (user.role === 'leader') return true;

  return withOrgContext(user.orgId, async (client) => {
    const { rows } = await client.query(
      `select 1 from permissions
        where user_id = $1 and org_id = $2 and resource = $3 and action = $4
        limit 1`,
      [user.userId, user.orgId, resource, action]
    );
    return rows.length > 0;
  });
}

/** Super Admin check — deliberately its own query against the raw pool,
 * not routed through withOrgContext/RLS: platform_admins isn't tenant
 * data (0016_admin_foundation.sql), and this needs to be answerable
 * before any org context exists at all, mirroring how sessions.ts
 * already reads the raw pool ahead of establishing org context
 * (DECISIONS.md #4). */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { rows } = await pool.query(`select 1 from platform_admins where user_id = $1 limit 1`, [userId]);
  return rows.length > 0;
}

/** Session 11 (ADMIN_BUILD_GUIDE.md §5). Deliberately its own table/check,
 * not derived from isPlatformAdmin() or isGroupAdmin()/isCompanyAdmin() —
 * the guide is explicit that impersonation needs "an own permission gate,
 * distinct from both platform_admins and the group-leader rule —
 * impersonation should never be a side effect of holding either of
 * those." Same raw-pool, no-RLS shape as isPlatformAdmin for the same
 * reason: this is a global capability check, not tenant data. */
export async function isImpersonationGranted(userId: string): Promise<boolean> {
  const { rows } = await pool.query(`select 1 from impersonation_grants where user_id = $1 limit 1`, [userId]);
  return rows.length > 0;
}

/** Session 41 (ADMIN_BUILD_GUIDE.md §3 "Session 6", Group Admin backend
 * half). "Group Admin" per the guide's own locked table is just `leader`
 * role *on a membership where the org is `org_type = 'group'`* — no new
 * table, no new role value. This is the route-time gate for that: is
 * this caller currently sitting in a group org as its leader.
 *
 * Deliberately reads `organizations` through withOrgContext(user.orgId,
 * ...) rather than the search_organizations bootstrap function
 * canReadOrg reaches for: this query's target row (the caller's own
 * current org) is covered by 0016's own tenant_isolation policy first
 * clause (`id = current_org_id`) with no circularity to route around,
 * so the RLS-bypassing path canReadOrg needs for a *different* org's
 * metadata isn't needed here — same minimal-privilege posture, cheaper
 * mechanism, because the question being asked is narrower ("what's my
 * own org's type", not "what's some other org's type"). */
export async function isGroupAdmin(user: SessionUser): Promise<boolean> {
  if (user.role !== 'leader') return false;
  return withOrgContext(user.orgId, async (client) => {
    const { rows } = await client.query<{ org_type: string }>(
      `select org_type from organizations where id = $1`,
      [user.orgId]
    );
    return rows[0]?.org_type === 'group';
  });
}

/** Session 41 (ADMIN_BUILD_GUIDE.md §3 "Session 6", Company Admin backend
 * half). "Company Admin" per the guide's own locked table is just the
 * existing `leader` role on a company org — no new role, no new code. This
 * mirrors isGroupAdmin exactly but checks for `org_type = 'company'`.
 *
 * A group leader (whose org_type is 'group') operating in their group
 * context is explicitly excluded — they have their own admin shell at
 * /admin/group. A company leader inside a group's child company is
 * included: their own current org is still 'company'. */
export async function isCompanyAdmin(user: SessionUser): Promise<boolean> {
  if (user.role !== 'leader') return false;
  return withOrgContext(user.orgId, async (client) => {
    const { rows } = await client.query<{ org_type: string }>(
      `select org_type from organizations where id = $1`,
      [user.orgId]
    );
    return rows[0]?.org_type === 'company';
  });
}

export type OrgAccessScope = 'own' | 'group_read' | 'platform_admin';

export interface OrgAccessResult {
  allowed: boolean;
  scope: OrgAccessScope | 'none';
}

/** The one new rule this session adds. Three ways `targetOrgId` can be
 * legitimately read by `user`:
 *   1. It's the user's own current org.
 *   2. `user` is a platform admin — every org is readable for
 *      investigation purposes (guide §1: Super Admin's own cross-org
 *      read path is reviewed as its own isolated unit — that review is
 *      this function's `platform_admin` branch plus the caller
 *      discipline documented on withAuthorizedOrgContext below; the
 *      actual Super Admin routes land in a later session).
 *   3. `user` is a `leader` whose *current* org is a `group`, and
 *      `targetOrgId` is a `company` whose `parent_org_id` is that group.
 *      This is a READ-only rule — it authorizes looking, not writing;
 *      nothing in this file grants group leaders write access to a
 *      child company's data, and no route should assume it does.
 *
 * Deliberately does not use withOrgContext for the org_type/parent_org_id
 * lookup: that lookup is against `organizations`, whose own RLS policy
 * (widened in 0016) already permits a group to see its direct children's
 * rows when app.current_org_id = the group — but confirming *that*
 * requires already knowing the answer this function computes, so this
 * check queries organizations directly on the raw pool instead of
 * fighting that circularity. This is read-only metadata (org id/type/
 * parent), not business data, so bypassing RLS here is the same
 * exemption class as `sessions`/`platform_admins`, not a general
 * precedent for business tables. */
export async function canReadOrg(user: SessionUser, targetOrgId: string): Promise<OrgAccessResult> {
  if (targetOrgId === user.orgId) return { allowed: true, scope: 'own' };

  if (await isPlatformAdmin(user.userId)) return { allowed: true, scope: 'platform_admin' };

  if (user.role !== 'leader') return { allowed: false, scope: 'none' };

  // Session 40: this used to select straight off the raw pool with no
  // org context, which — even setting aside the pre-0019 recursion bug —
  // silently returns 0 rows under organizations' own SELECT policy
  // (id = current_org_id, and no context is ever set here), so this
  // group_read branch could never actually match anything. Confirmed
  // live this session: the exact query below returned 0 rows for a
  // real org id with no context set. Routed through search_organizations
  // (0019's bootstrap-owned, RLS-bypassing read) instead — this is
  // read-only directory metadata (org id/type/parent), the same
  // exemption class this function's own doc comment already claims for
  // bypassing RLS here, just via the mechanism that actually works.
  const { rows } = await pool.query<{ org_type: string }>(`select org_type from search_organizations(null) where id = $1`, [
    user.orgId,
  ]);
  if (rows[0]?.org_type !== 'group') return { allowed: false, scope: 'none' };

  const target = await pool.query<{ parent_org_id: string | null }>(
    `select parent_org_id from search_organizations(null) where id = $1`,
    [targetOrgId]
  );
  if (target.rows[0]?.parent_org_id === user.orgId) return { allowed: true, scope: 'group_read' };

  return { allowed: false, scope: 'none' };
}

export class OrgAccessDeniedError extends Error {
  constructor(public targetOrgId: string) {
    super(`User is not authorized to read org ${targetOrgId}.`);
    this.name = 'OrgAccessDeniedError';
  }
}

/** canReadOrg() + withOrgContext() in one call — throws
 * OrgAccessDeniedError rather than returning a sentinel, so a caller
 * that forgets to check the boolean can't accidentally fall through to
 * an unauthorized read; callers translate the error to a 403 the same
 * way every other service's typed error classes already get translated
 * in their route handlers (GoalStateError, InviteError, etc.). One org
 * per call, on purpose — DECISIONS.md §5's corollary is that a cross-org
 * view is N of these merged in the route/service layer, never a single
 * widened query. */
export async function withAuthorizedOrgContext<T>(
  user: SessionUser,
  targetOrgId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const access = await canReadOrg(user, targetOrgId);
  if (!access.allowed) throw new OrgAccessDeniedError(targetOrgId);
  return withOrgContext(targetOrgId, fn);
}

/** Fastify preHandler form — unchanged behavior from rbac.ts's original. */
export function requirePermission(resource: string, action: PermissionAction) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.sessionUser;
    if (!user) {
      reply.status(401).send({ error: 'unauthenticated', message: 'Sign in required.' });
      return;
    }
    const granted = await hasPermission(user, resource, action);
    if (!granted) {
      reply.status(403).send({ error: 'forbidden', message: `Missing '${action}' permission on '${resource}'.` });
    }
  };
}
