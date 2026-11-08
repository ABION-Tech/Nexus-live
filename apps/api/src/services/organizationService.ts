// ADMIN_BUILD_GUIDE.md §1 (repo Session 37): "organizationService.ts:
// create/edit/deactivate Group and Company, assign/remove Company<->Group
// (including -> null for independent), organizations.plan field + gate
// check (hook only, no real billing), Super Admin can set/change a
// company's plan tier (authority established here, wired to a route in
// a later session)."
//
// No HTTP routes call this yet — `routes/admin/` is an empty shell this
// session (see routes/admin/README.md); the actual Super Admin CRUD
// routes land when superAdmin.ts is built. This file and its tests are
// the load-bearing piece for this session: get the org-hierarchy write
// path and the group-read rule right before anything is built on top.
import { pool, withOrgContext } from '../db.js';
import { canReadOrg, isPlatformAdmin, OrgAccessDeniedError } from './authorizationService.js';
import type { SessionUser } from './sessionService.js';
import type { Organization, OrgType } from '@nexus/shared';

interface OrgRow {
  id: string;
  name: string;
  org_type: OrgType;
  parent_org_id: string | null;
  plan: 'free' | 'paid';
  active: boolean;
  created_at: Date;
}

export function toOrganization(row: OrgRow): Organization {
  return {
    id: row.id,
    name: row.name,
    orgType: row.org_type,
    parentOrgId: row.parent_org_id ?? undefined,
    plan: row.plan,
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

export class OrganizationError extends Error {
  constructor(
    public code: 'not_found' | 'invalid_parent' | 'forbidden',
    message: string
  ) {
    super(message);
    this.name = 'OrganizationError';
  }
}

/** Super Admin only — creating orgs (either tier) is platform-level, not
 * scoped to any existing org, so this deliberately doesn't take an
 * `orgId` to run inside withOrgContext with. Raw pool, same exemption
 * class as platform_admins/sessions. */
export async function createOrganization(
  actor: SessionUser,
  input: { name: string; orgType: OrgType; parentOrgId?: string }
): Promise<Organization> {
  if (!(await isPlatformAdmin(actor.userId))) {
    throw new OrganizationError('forbidden', 'Only a platform admin can create organizations.');
  }
  if (input.orgType === 'group' && input.parentOrgId) {
    throw new OrganizationError('invalid_parent', 'A group cannot have a parent org.');
  }
  if (input.orgType === 'company' && input.parentOrgId) {
    // Session 40: raw-pool select against organizations only ever sees
    // rows matching the (unset, here) app.current_org_id under RLS —
    // not an error, just silently 0 rows, which would make a perfectly
    // valid parent group look "not found". Read via search_organizations
    // (0019's bootstrap-owned, RLS-bypassing read path) instead.
    const { rows } = await pool.query<{ org_type: OrgType }>(
      `select org_type from search_organizations(null) where id = $1`,
      [input.parentOrgId]
    );
    if (rows[0]?.org_type !== 'group') {
      throw new OrganizationError('invalid_parent', "A company's parent must be a group.");
    }
  }

  // Session 40 (0020_organizations_platform_writes.sql): a plain
  // `insert ... returning *` against the raw pool (nexus_app) fails
  // under RLS even with INSERT granted — Postgres re-checks a RETURNING
  // row against organizations' SELECT policy, which a brand-new org
  // with no app.current_org_id set can never satisfy. Routed through
  // the nexus_bootstrap-owned create_organization_row() function
  // instead, confirmed live against a real Postgres instance this
  // session — see the migration's own header comment for the full
  // repro/fix trail.
  const { rows } = await pool.query<OrgRow>(
    `select * from create_organization_row($1, $2, $3)`,
    [input.name, input.orgType, input.parentOrgId ?? null]
  );
  return toOrganization(rows[0]!);
}

/** Group-leader-of-that-group or platform admin can edit a group/company's
 * name; only a platform admin can change its plan (guide §1: "the
 * *authority* is decided now" — this is that authority, enforced here
 * rather than deferred to whichever route ends up calling it). */
export async function updateOrganization(
  actor: SessionUser,
  orgId: string,
  patch: { name?: string; plan?: 'free' | 'paid'; active?: boolean }
): Promise<Organization | null> {
  if (patch.plan !== undefined || patch.active !== undefined) {
    if (!(await isPlatformAdmin(actor.userId))) {
      throw new OrganizationError('forbidden', 'Only a platform admin can change plan or active status.');
    }
  } else {
    const access = await canReadOrg(actor, orgId);
    // Editing (not just reading) a company's own name is a same-org
    // leader action — group_read is read-only per canReadOrg's own
    // doc comment, so it does not authorize this branch.
    if (!access.allowed || (access.scope !== 'own' && access.scope !== 'platform_admin')) {
      throw new OrgAccessDeniedError(orgId);
    }
  }

  if (patch.name === undefined && patch.plan === undefined && patch.active === undefined) {
    // Session 40: a plain `select * from organizations` also needs a
    // real org context to pass the SELECT policy (0020's own fix does
    // not touch reads) — use search_organizations (0019), the
    // bootstrap-owned read path, rather than the raw pool here.
    const { rows } = await pool.query<OrgRow>(`select * from search_organizations(null) where id = $1`, [orgId]);
    return rows[0] ? toOrganization(rows[0]) : null;
  }

  // Session 40 (0020_organizations_platform_writes.sql): same RETURNING-
  // vs-SELECT-policy issue as createOrganization above — routed through
  // update_organization_row(), whose null-means-"leave unchanged"
  // coalesce shape mirrors this function's own partial-patch semantics.
  const { rows } = await pool.query<OrgRow>(
    `select * from update_organization_row($1, $2, $3, $4)`,
    [orgId, patch.name ?? null, patch.plan ?? null, patch.active ?? null]
  );
  return rows[0] ? toOrganization(rows[0]) : null;
}

/** Soft "delete" — flips `active`, doesn't drop the row (this is a
 * tenant root; hard-deleting it would orphan every FK under it). Platform
 * admin only, same reasoning as the plan change above. */
export async function deactivateOrganization(actor: SessionUser, orgId: string): Promise<Organization | null> {
  return updateOrganization(actor, orgId, { active: false });
}

/** Assign a company to a group, or pass `groupOrgId: null` to make it
 * independent again. Platform admin only — moving a company between
 * groups is a platform-level restructuring action, not something a
 * Group Admin can do to acquire a company. */
export async function assignCompanyToGroup(
  actor: SessionUser,
  companyOrgId: string,
  groupOrgId: string | null
): Promise<Organization> {
  if (!(await isPlatformAdmin(actor.userId))) {
    throw new OrganizationError('forbidden', 'Only a platform admin can reassign a company to a different group.');
  }
  // Session 40: same search_organizations rationale as createOrganization
  // above — a raw select here would silently 0-row a real company/group.
  const { rows: companyRows } = await pool.query<OrgRow>(`select * from search_organizations(null) where id = $1`, [companyOrgId]);
  const company = companyRows[0];
  if (!company) throw new OrganizationError('not_found', 'Company not found.');
  if (company.org_type !== 'company') throw new OrganizationError('invalid_parent', 'Only a company can be assigned to a group.');

  if (groupOrgId) {
    const { rows: groupRows } = await pool.query<OrgRow>(`select org_type from search_organizations(null) where id = $1`, [groupOrgId]);
    if (groupRows[0]?.org_type !== 'group') throw new OrganizationError('invalid_parent', 'Target must be a group.');
  }

  // Session 40: same RETURNING-vs-SELECT-policy fix as createOrganization/
  // updateOrganization above, via assign_company_to_group_row().
  const { rows } = await pool.query<OrgRow>(
    `select * from assign_company_to_group_row($1, $2)`,
    [companyOrgId, groupOrgId]
  );
  return toOrganization(rows[0]!);
}

/** The read side of the new group-read rule: companies where
 * parent_org_id = groupOrgId, visible to a leader of that group under
 * 0016's widened organizations RLS policy. Goes through
 * withOrgContext(groupOrgId, ...) — not the raw pool — specifically so
 * this exercises (and is protected by) that RLS policy rather than
 * trusting the caller's authorization alone; canReadOrg is still checked
 * first so a non-leader / wrong-group caller gets a clean
 * OrgAccessDeniedError instead of an empty result that looks like "group
 * has no companies". */
export async function listCompaniesInGroup(actor: SessionUser, groupOrgId: string): Promise<Organization[]> {
  const access = await canReadOrg(actor, groupOrgId);
  if (!access.allowed) throw new OrgAccessDeniedError(groupOrgId);

  return withOrgContext(groupOrgId, async (client) => {
    const { rows } = await client.query<OrgRow>(
      `select * from organizations where parent_org_id = $1 order by name asc`,
      [groupOrgId]
    );
    return rows.map(toOrganization);
  });
}
