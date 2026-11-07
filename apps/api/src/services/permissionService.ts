// PRD §13.3 — the editable half of the permissions model rbac.ts's
// hasPermission/requirePermission only ever read from. Same layering as
// every other service here: no permission logic in this file, that's
// routes/permissions.ts's job — this is pure data access.
import { withOrgContext } from '../db.js';
import type { Permission, PermissionAction } from '@nexus/shared';

interface PermissionRow {
  id: string;
  user_id: string;
  org_id: string;
  resource: string;
  action: PermissionAction;
  granted_by: string;
  granted_at: Date;
}

function toPermission(row: PermissionRow): Permission {
  return {
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    resource: row.resource,
    action: row.action,
    grantedByUserId: row.granted_by,
    grantedAt: row.granted_at.toISOString(),
  };
}

/** Thrown by grantPermission when the target user has no org_memberships
 * row in this org — granting a permission to someone who isn't actually
 * a member would create an orphaned row `hasPermission`'s own query
 * (user_id + org_id + resource + action) could still technically match,
 * silently authorizing someone the Team & Roles roster (GET /people,
 * itself scoped to org_memberships) doesn't even list. Routes translate
 * this to 404, not 400 — the request shape is fine, the referenced user
 * just isn't a real target in this org. */
export class UserNotInOrgError extends Error {
  constructor(userId: string) {
    super(`User ${userId} is not a member of this organization.`);
    this.name = 'UserNotInOrgError';
  }
}

export async function listPermissionsForUser(orgId: string, userId: string): Promise<Permission[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<PermissionRow>(
      `select * from permissions where org_id = $1 and user_id = $2 order by granted_at desc`,
      [orgId, userId]
    );
    return rows.map(toPermission);
  });
}

/**
 * Idempotent grant — re-granting an already-held resource+action pair
 * updates granted_by/granted_at rather than erroring, since the caller's
 * intent ("this person should have this") is unchanged whether or not a
 * row already exists; the UI has no "already granted" state to show
 * around, it just re-confirms. Conflict target matches
 * 0006_org_hierarchy_memberships.sql's own
 * permissions_user_org_resource_action_key constraint exactly.
 */
export async function grantPermission(
  orgId: string,
  grantedByUserId: string,
  targetUserId: string,
  resource: string,
  action: PermissionAction
): Promise<Permission> {
  return withOrgContext(orgId, async (client) => {
    const membership = await client.query(
      `select 1 from org_memberships where org_id = $1 and user_id = $2 limit 1`,
      [orgId, targetUserId]
    );
    if (membership.rows.length === 0) {
      throw new UserNotInOrgError(targetUserId);
    }

    const { rows } = await client.query<PermissionRow>(
      `insert into permissions (user_id, org_id, resource, action, granted_by)
       values ($1, $2, $3, $4, $5)
       on conflict (user_id, org_id, resource, action)
       do update set granted_by = excluded.granted_by, granted_at = now()
       returning *`,
      [targetUserId, orgId, resource, action, grantedByUserId]
    );
    return toPermission(rows[0]!);
  });
}

/** Returns true if a row was actually deleted — false lets the route
 * distinguish "already gone / never existed" (404) from a real failure,
 * same convention deleteRowAction-equivalents use elsewhere in this
 * codebase's history (GAS's own deleteRowAction did the same). */
export async function revokePermission(orgId: string, id: string): Promise<boolean> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query(
      `delete from permissions where org_id = $1 and id = $2 returning id`,
      [orgId, id]
    );
    return rows.length > 0;
  });
}
