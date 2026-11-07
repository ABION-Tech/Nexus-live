// ADMIN_BUILD_GUIDE.md §1 (repo Session 37): "Guest sign-in: Company
// (any admin tier) generates guest credentials and shares them; guest
// signs in with password-capable login — not OAuth-only."
//
// This is the one deliberate exception to PRD §13.2's "Google OAuth is
// the only login path" — scoped narrowly to the new `guest` role only.
// No bcrypt/argon2 dependency added for one code path; Node's built-in
// scrypt (already used elsewhere in this codebase for token hashing,
// see sessionService.ts) is used for password hashing too, with a
// per-password random salt (scrypt has no built-in salt handling the
// way bcrypt does, so it's stored and applied by hand here).
import crypto from 'node:crypto';
import { pool, withOrgContext } from '../db.js';
import type { Role } from '@nexus/shared';

const SCRYPT_KEYLEN = 64;

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  // Lengths always match (fixed SCRYPT_KEYLEN) so timingSafeEqual won't
  // throw on a length mismatch here the way it can on attacker-controlled
  // input elsewhere.
  return crypto.timingSafeEqual(expected, actual);
}

function generateTempPassword(): string {
  // 12 base64url chars, no ambiguous-character concerns worth solving for
  // a one-time credential the leader copies and hands over once — this
  // isn't a password the guest is expected to remember or retype often.
  return crypto.randomBytes(9).toString('base64url');
}

export interface GuestCredential {
  userId: string;
  name: string;
  email: string;
  tempPassword: string; // returned exactly once, at creation — never re-derivable after this
}

export class GuestServiceError extends Error {
  constructor(
    public code: 'email_taken',
    message: string
  ) {
    super(message);
    this.name = 'GuestServiceError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** Leader-only (enforced by the calling route, same pattern
 * TeamRoles.tsx's `canManage = user.role === 'leader'` already uses
 * client-side, mirrored server-side here). Creates a real `users` row
 * plus an `org_memberships` row with role='guest', is_home=true — a
 * guest has exactly one org, unlike the multi-membership case leaders/
 * team members can have. */
export async function createGuestCredential(orgId: string, name: string, email: string): Promise<GuestCredential> {
  const tempPassword = generateTempPassword();
  const passwordHash = hashPassword(tempPassword);
  const role: Role = 'guest';

  try {
    return await withOrgContext(orgId, async (client) => {
      // Session 9 hardening pass fix: this used to insert into a
      // `users.org_id` column, which 0006_org_hierarchy_memberships.sql
      // dropped in favor of `home_org_id` + `org_memberships` — a stale
      // reference that would fail with "column org_id does not exist"
      // regardless of RLS. Also folds in the same insert-time RLS fix
      // seedClickthrough.ts and inviteService.ts already rely on
      // (0027_fix_users_insert_rls.sql): setting home_org_id directly on
      // insert, matching the org context this whole call already runs
      // under, satisfies the new tenant_isolation_insert policy — no
      // separate follow-up `update users set home_org_id = ...` needed.
      const { rows: userRows } = await client.query<{ id: string }>(
        `insert into users (home_org_id, name, email, password_hash) values ($1, $2, $3, $4) returning id`,
        [orgId, name, email, passwordHash]
      );
      const userId = userRows[0]!.id;

      await client.query(
        `insert into org_memberships (user_id, org_id, role, is_home) values ($1, $2, $3, true)`,
        [userId, orgId, role]
      );

      return { userId, name, email, tempPassword };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new GuestServiceError('email_taken', `A user with email ${email} already exists.`);
    }
    throw err;
  }
}

/** Verifies email+password against a guest account. Deliberately checked
 * on the raw pool, not withOrgContext — a login attempt doesn't have an
 * org context yet (that's what this call establishes), same bootstrap
 * ordering sessionService.verifySession's own doc comment describes for
 * `sessions` -> `users`. Returns null for "no such guest", "wrong
 * password", and "this account isn't a guest" alike — same
 * don't-leak-which-case-it-was posture verifySession already takes. */
export async function verifyGuestLogin(email: string, password: string): Promise<{ userId: string; orgId: string } | null> {
  const { rows } = await pool.query<{ id: string; org_id: string; password_hash: string | null; role: string }>(
    `select u.id, u.home_org_id as org_id, u.password_hash, m.role
       from users u
       join org_memberships m on m.user_id = u.id and m.is_home = true
      where u.email = $1`,
    [email]
  );
  const row = rows[0];
  if (!row || row.role !== 'guest' || !row.password_hash) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return { userId: row.id, orgId: row.org_id };
}
