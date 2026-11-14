// PRD §3 invite-and-approval flow. Closes SESSION_LOG Session 5's
// `not_invited` interim gap: a leader creates an invite up front — that
// creation *is* the approval PRD §3 describes ("pending until leader
// approves"), there's no separate post-signup approval queue. Acceptance
// is just the invitee's first successful Google OAuth landing on a
// still-pending, unexpired invite for their email.
import type { Role } from '@nexus/shared';
import { pool, withOrgContext } from '../db.js';

export interface Invite {
  id: string;
  orgId: string;
  email: string;
  role: Role;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  /** Session 53: accepting this invite also makes the person a Super Admin. */
  grantPlatformAdmin: boolean;
  /** Session 57: the email already has a NEXUS account (in another
   * company). They accept or decline from inside the app. */
  existingAccount?: boolean;
}

export interface AcceptedInvite {
  userId: string;
  orgId: string;
  role: Role;
}

export class InviteError extends Error {
  constructor(
    public code: 'conflict' | 'not_found' | 'expired' | 'user_exists' | 'already_member',
    message: string
  ) {
    super(message);
    this.name = 'InviteError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function mapInviteRow(row: {
  id: string;
  org_id: string;
  email: string;
  role: Role;
  invited_by: string;
  created_at: string;
  expires_at: string;
  grant_platform_admin?: boolean;
}): Invite {
  return {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    grantPlatformAdmin: row.grant_platform_admin ?? false,
  };
}

/**
 * Leader-only (enforce with `requirePermission('users', 'create')` — or
 * whatever resource the invites route settles on — at the route level;
 * this function itself doesn't re-check the caller's role). Creates a
 * pending invite for an email within the caller's own org.
 *
 * Runs inside `withOrgContext(orgId, ...)` like any other authenticated
 * write — the caller already has org context from their session, so no
 * bootstrap function is needed here (that's only for the pre-login
 * lookups below, where org context is exactly what's unknown yet).
 */
export async function createInvite(params: {
  orgId: string;
  email: string;
  role: Role;
  invitedBy: string;
  /** Session 53 — set only by the Super Admin "Add Super Admin" flow. */
  grantPlatformAdmin?: boolean;
}): Promise<Invite> {
  const email = params.email.trim().toLowerCase();

  // `email` is globally unique on `users` (0001_init.sql), not
  // per-org — someone could already have a NEXUS account (in this org
  // or, in principle, another) before a leader tries to invite that
  // same address. Without this check, `createInvite` would happily
  // insert a pending invite that can never be consumed: `acceptInvite`
  // (below) is only reached from `routes/auth.ts` when
  // `find_user_by_email` comes back empty, so an already-registered
  // email would just sit there until it expired with no feedback to
  // the inviting leader about why. Caught while exercising the full
  // create-invite → accept-invite loop end to end this session, not by
  // inspection — same `find_user_by_email` SECURITY DEFINER lookup
  // `routes/auth.ts` and `findLiveInviteByEmail` (below) already use,
  // for the same RLS reason: org isn't known yet at this point.
  //
  // Session 57: an existing account is no longer a dead end. One person
  // can belong to several companies, so the invite is created as normal
  // and waits in that person's app (Join / Decline) — see
  // workspaceService.acceptInvitation. The only refusal left is inviting
  // someone who is already in *this* company.
  const existingUser = await pool.query<{ id: string }>(`select id from find_user_by_email($1)`, [email]);
  const existingId = existingUser.rows[0]?.id;
  if (existingId) {
    const { rows } = await pool.query(`select 1 from my_workspaces($1) where org_id = $2`, [existingId, params.orgId]);
    if (rows.length > 0) {
      throw new InviteError('already_member', `${email} is already a member of this company.`);
    }
  }

  try {
    return await withOrgContext(params.orgId, async (client) => {
      // The partial unique index on (org_id, lower(email)) can only
      // condition on accepted_at/revoked_at being null — it can't also
      // check expires_at > now() (index predicates must be immutable,
      // now() isn't). So a pending invite that expired months ago still
      // reads as "live" to that index and would block a fresh invite to
      // the same address forever. Sweep it to revoked first so
      // re-inviting after expiry just works.
      await client.query(
        `update invites set revoked_at = now()
          where org_id = $1 and lower(email) = $2
            and accepted_at is null and revoked_at is null
            and expires_at <= now()`,
        [params.orgId, email]
      );

      const { rows } = await client.query(
        `insert into invites (org_id, email, role, invited_by, grant_platform_admin)
         values ($1, $2, $3, $4, $5)
         returning id, org_id, email, role, invited_by, created_at, expires_at, grant_platform_admin`,
        [params.orgId, email, params.role, params.invitedBy, params.grantPlatformAdmin ?? false]
      );

      return { ...mapInviteRow(rows[0]), existingAccount: Boolean(existingId) };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new InviteError('conflict', `An invite for ${email} is already pending.`);
    }
    throw err;
  }
}

/**
 * Leader-only. Revokes a still-pending invite (e.g. sent to the wrong
 * address). Silently a no-op-turned-error for an invite that's already
 * been accepted or revoked — there's nothing left to revoke, and an
 * accepted invite shouldn't be retroactively undone this way (that's a
 * role change or account deactivation, not an invite action).
 */
export async function revokeInvite(orgId: string, inviteId: string): Promise<void> {
  const revoked = await withOrgContext(orgId, async (client) => {
    const { rowCount } = await client.query(
      `update invites set revoked_at = now()
        where id = $1 and accepted_at is null and revoked_at is null`,
      [inviteId]
    );
    return (rowCount ?? 0) > 0;
  });

  if (!revoked) {
    throw new InviteError('not_found', 'No pending invite with that id.');
  }
}

/**
 * Pre-login lookup: does a *live* (unaccepted, unrevoked — expiry is
 * returned, not filtered, so the caller can give a specific "expired"
 * message rather than a generic "not found") invite exist for this
 * email? Uses the `find_invite_by_email` SECURITY DEFINER function
 * (0003_invites.sql) via the raw `pool`, not `withOrgContext` — RLS is
 * FORCE'd on `invites` and `nexus_app` is NOBYPASSRLS, so a plain SELECT
 * here would need `app.current_org_id` set, which is exactly what this
 * call exists to discover. Same shape as `findUserByEmail` in
 * `routes/auth.ts`, and the same bug class Session 5 already hit once
 * for sessions→users (DECISIONS.md #4) — caught here for users/invites
 * specifically by testing against a real Postgres instance, not by
 * inspection (see 0003_invites.sql's header comment).
 */
export async function findLiveInviteByEmail(
  email: string
): Promise<{ id: string; orgId: string; role: Role; expiresAt: string } | null> {
  const { rows } = await pool.query(
    `select id, org_id, role, expires_at from find_invite_by_email($1)`,
    [email.trim().toLowerCase()]
  );
  if (rows.length === 0) return null;

  return {
    id: rows[0].id,
    orgId: rows[0].org_id,
    role: rows[0].role,
    expiresAt: rows[0].expires_at,
  };
}

/**
 * Consumes a pending invite: creates the `users` row (org + role from
 * the invite; name from the Google account's display name, falling back
 * to the email's local-part only if Google didn't return one — see
 * `routes/auth.ts`) and marks the invite accepted. Called right after
 * `verifyAuthCode` succeeds and `findUserByEmail` comes back empty —
 * i.e. only for a Google identity with no existing NEXUS account yet.
 *
 * The invite is claimed with `UPDATE ... WHERE accepted_at IS NULL`
 * *before* the user row is created, and the return value is checked —
 * this is the atomic guard against two concurrent OAuth callbacks (e.g.
 * a double-click, or a retried request) both trying to consume the same
 * invite and creating two `users` rows for one email. Whichever request
 * wins the UPDATE proceeds; the other gets a clean `not_found`-style
 * `InviteError` rather than a duplicate account or a unique-constraint
 * 500.
 *
 * Runs inside `withOrgContext(invite.orgId, ...)`: by this point the org
 * *is* known — it came off the invite row via the bootstrap function
 * above — so the `users` insert satisfies the normal `tenant_isolation`
 * policy without needing any further RLS bypass. The bootstrap
 * function's only job was answering "which org"; the write itself is
 * ordinary, already-org-scoped application code.
 */
export async function acceptInvite(params: {
  email: string;
  googleDisplayName?: string;
}): Promise<AcceptedInvite> {
  const email = params.email.trim().toLowerCase();
  const invite = await findLiveInviteByEmail(email);

  if (!invite) {
    throw new InviteError('not_found', 'No pending invite for this email.');
  }
  if (new Date(invite.expiresAt).getTime() <= Date.now()) {
    throw new InviteError('expired', 'This invite has expired — ask a leader to send a new one.');
  }

  const name = params.googleDisplayName?.trim() || email.split('@')[0];

  return withOrgContext(invite.orgId, async (client) => {
    const claim = await client.query<{ id: string; invited_by: string; grant_platform_admin: boolean }>(
      `update invites set accepted_at = now()
        where id = $1 and accepted_at is null and revoked_at is null
        returning id, invited_by, grant_platform_admin`,
      [invite.id]
    );

    if (claim.rowCount === 0) {
      // Lost the race (or the invite was revoked between the lookup
      // above and this claim) — surface the same error a stale/expired
      // invite would, rather than a generic 500.
      throw new InviteError('not_found', 'This invite was already used or revoked.');
    }

    // 0006_org_hierarchy_memberships.sql: users no longer carries
    // org_id/role directly — a fresh user gets a home_org_id pointer plus
    // its matching org_memberships row (is_home = true, since this is
    // necessarily their first and only org at signup time).
    const { rows: userRows } = await client.query(
      `insert into users (name, email, home_org_id)
       values ($1, $2, $3)
       returning id`,
      [name, email, invite.orgId]
    );
    const user = userRows[0];

    await client.query(
      `insert into org_memberships (user_id, org_id, role, is_home)
       values ($1, $2, $3, true)`,
      [user.id, invite.orgId, invite.role]
    );

    await client.query(`update invites set accepted_user_id = $1 where id = $2`, [user.id, invite.id]);

    // Session 53: a Super Admin invite grants platform access in the same
    // transaction that creates the account, so there's never a window
    // where the person exists but the grant silently didn't apply.
    if (claim.rows[0]?.grant_platform_admin) {
      await client.query(
        `insert into platform_admins (user_id, granted_by) values ($1, $2)
         on conflict (user_id) do nothing`,
        [user.id, claim.rows[0].invited_by]
      );
    }

    return { userId: user.id, orgId: invite.orgId, role: invite.role };
  });
}

/** Session 53. Pending (unaccepted, unrevoked, unexpired) invites for one
 * org, newest first — backs Settings > Team & Roles' "Pending invites"
 * list and the Super Admin organization drawer. */
export async function listPendingInvites(orgId: string): Promise<Invite[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query(
      `select id, org_id, email, role, invited_by, created_at, expires_at, grant_platform_admin
         from invites
        where org_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()
        order by created_at desc`,
      [orgId]
    );
    return rows.map(mapInviteRow);
  });
}
