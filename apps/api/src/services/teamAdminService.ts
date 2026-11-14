// Session 53 — role assignment and Super Admin management.
//
// Role changes: a member's role is per-org, on org_memberships (0006).
// Sessions resolve the role from org_memberships on every request
// (sessionService.verifySession), so a change takes effect on the
// person's next request — no sign-out needed.
//
// Super Admins: platform_admins (0016) is global, not tenant data, so it's
// read/written on the raw pool like authorizationService.isPlatformAdmin().
// Adding someone without an account goes through an ordinary invite with
// grant_platform_admin = true (0037); acceptInvite applies the grant.
import type { MemberRole, PlatformAdminEntry } from '@nexus/shared';
import { pool, withOrgContext } from '../db.js';
import { createInvite, InviteError, type Invite } from './inviteService.js';

export const MEMBER_ROLES: MemberRole[] = ['leader', 'team_member', 'intern'];

export class TeamAdminError extends Error {
  constructor(
    public code: 'not_found' | 'last_leader' | 'last_platform_admin' | 'self' | 'invalid' | 'conflict' | 'user_exists',
    message: string
  ) {
    super(message);
    this.name = 'TeamAdminError';
  }
}

/** Changes one member's role inside one org. Refuses to demote the org's
 * last leader, which would leave nobody able to manage it. */
export async function changeMemberRole(params: {
  orgId: string;
  userId: string;
  role: MemberRole;
}): Promise<{ userId: string; role: MemberRole; previousRole: MemberRole }> {
  if (!MEMBER_ROLES.includes(params.role)) {
    throw new TeamAdminError('invalid', `role must be one of ${MEMBER_ROLES.join(', ')}`);
  }

  return withOrgContext(params.orgId, async (client) => {
    // Lock this org's membership rows for the duration of the check-then-
    // update, so two simultaneous demotions can't both pass the
    // "another leader exists" check and leave zero leaders.
    const { rows: members } = await client.query<{ user_id: string; role: MemberRole }>(
      `select user_id, role from org_memberships where org_id = $1 for update`,
      [params.orgId]
    );
    const target = members.find((m) => m.user_id === params.userId);
    if (!target) throw new TeamAdminError('not_found', 'That person is not a member of this organization.');

    if (target.role === params.role) {
      return { userId: params.userId, role: params.role, previousRole: target.role };
    }

    if (target.role === 'leader' && params.role !== 'leader') {
      const leaders = members.filter((m) => m.role === 'leader').length;
      if (leaders <= 1) {
        throw new TeamAdminError(
          'last_leader',
          'This is the only leader. Make someone else a leader first, so the organization always has one.'
        );
      }
    }

    await client.query(`update org_memberships set role = $1 where org_id = $2 and user_id = $3`, [
      params.role,
      params.orgId,
      params.userId,
    ]);
    return { userId: params.userId, role: params.role, previousRole: target.role };
  });
}

export async function listPlatformAdmins(): Promise<PlatformAdminEntry[]> {
  const { rows } = await pool.query<{
    user_id: string;
    name: string;
    email: string;
    granted_at: string;
    granted_by_name: string | null;
  }>(
    // users has FORCE RLS and this raw pool has no org context, so this
    // goes through 0037's nexus_bootstrap SECURITY DEFINER function.
    `select user_id, name, email, granted_at, granted_by_name from list_platform_admins()`
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    grantedAt: r.granted_at,
    grantedByName: r.granted_by_name ?? undefined,
  }));
}

/** Adds a Super Admin by email. Existing account: granted immediately.
 * No account yet: an invite into `homeOrgId` (required in that case) that
 * grants Super Admin when accepted. */
export async function addPlatformAdmin(params: {
  email: string;
  actorUserId: string;
  homeOrgId?: string;
  role?: MemberRole;
}): Promise<{ status: 'granted'; admin: PlatformAdminEntry } | { status: 'invited'; invite: Invite }> {
  const email = params.email.trim().toLowerCase();
  const existing = await pool.query<{ id: string }>(`select id from find_user_by_email($1)`, [email]);

  if (existing.rows.length > 0) {
    const userId = existing.rows[0]!.id;
    await pool.query(
      `insert into platform_admins (user_id, granted_by) values ($1, $2) on conflict (user_id) do nothing`,
      [userId, params.actorUserId]
    );
    const admin = (await listPlatformAdmins()).find((a) => a.userId === userId)!;
    return { status: 'granted', admin };
  }

  if (!params.homeOrgId) {
    throw new TeamAdminError(
      'invalid',
      `${email} doesn't have a NEXUS account yet. Choose the organization they'll belong to, and they'll become a Super Admin when they first sign in.`
    );
  }

  try {
    const invite = await createInvite({
      orgId: params.homeOrgId,
      email,
      role: params.role ?? 'leader',
      invitedBy: params.actorUserId,
      grantPlatformAdmin: true,
    });
    return { status: 'invited', invite };
  } catch (err) {
    if (err instanceof InviteError && (err.code === 'conflict' || err.code === 'user_exists' || err.code === 'already_member')) {
      throw new TeamAdminError(err.code === 'already_member' ? 'conflict' : err.code, err.message);
    }
    throw err;
  }
}

/** Removes Super Admin access (the person keeps their normal account and
 * org roles). Refuses to remove yourself or the last Super Admin. */
export async function removePlatformAdmin(params: { actorUserId: string; userId: string }): Promise<void> {
  if (params.actorUserId === params.userId) {
    throw new TeamAdminError('self', "You can't remove your own Super Admin access. Ask another Super Admin.");
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    // nexus_app has select/insert/delete (not update) on platform_admins,
    // so SELECT ... FOR UPDATE isn't available; a table lock (needs only
    // DELETE) serialises concurrent removals so the last-admin check holds.
    await client.query(`lock table platform_admins in share row exclusive mode`);
    const { rows } = await client.query<{ user_id: string }>(`select user_id from platform_admins`);
    if (!rows.some((r) => r.user_id === params.userId)) {
      throw new TeamAdminError('not_found', 'That person is not a Super Admin.');
    }
    if (rows.length <= 1) {
      throw new TeamAdminError('last_platform_admin', 'NEXUS must always have at least one Super Admin.');
    }
    await client.query(`delete from platform_admins where user_id = $1`, [params.userId]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
