// Session 54 — email + password sign-in for members.
//
// A password is only ever chosen by its owner, through a one-time emailed
// link ("set your password"): first-time setup, forgotten password, and
// accepting an invite without Google all use the same flow. Nobody, admins
// included, ever sees or types someone else's password.
//
// Failure handling deliberately doesn't reveal whether an email has an
// account: login says "email or password is incorrect" either way, and
// requesting a link always reports success.
import crypto from 'node:crypto';
import { pool } from '../db.js';
import { hashPassword, verifyPassword } from './passwordHashing.js';
import { acceptInvite, InviteError } from './inviteService.js';
import { getEmailProvider } from '../integrations/emailProvider.js';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
const TOKEN_TTL_MINUTES = 60;

// verifyPassword against this when the email is unknown, so a miss costs
// the same scrypt time as a wrong password and response timing doesn't
// reveal which addresses have accounts.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

export class PasswordAuthError extends Error {
  constructor(
    public code: 'invalid_token' | 'weak_password' | 'not_invited' | 'invite_expired',
    message: string
  ) {
    super(message);
    this.name = 'PasswordAuthError';
  }
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  return null;
}

/** Returns the account to start a session for, or null for any failure. */
export async function loginWithPassword(email: string, password: string): Promise<{ userId: string; orgId: string } | null> {
  const { rows } = await pool.query<{ id: string; org_id: string; role: string; password_hash: string | null }>(
    `select id, org_id, role, password_hash from find_password_login($1)`,
    [email.trim().toLowerCase()]
  );
  const row = rows[0];
  // Guests have their own credential path (/auth/guest-login).
  const usable = row && row.role !== 'guest' && row.password_hash ? row : null;
  const ok = verifyPassword(password, usable?.password_hash ?? DUMMY_HASH);
  if (!usable || !ok) return null;
  return { userId: usable.id, orgId: usable.org_id };
}

/** Emails a one-time set-password link if the address has an account or a
 * pending invite. Always resolves the same way (no account enumeration). */
export async function requestPasswordLink(email: string, webOrigin: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return;

  const { rows: users } = await pool.query<{ id: string; role: string }>(
    `select id, role from find_user_by_email($1)`,
    [normalized]
  );
  let kind: 'account' | 'invite' | null = users[0] && users[0].role !== 'guest' ? 'account' : null;
  if (!kind && users.length === 0) {
    const { rows: invites } = await pool.query(`select id from find_invite_by_email($1)`, [normalized]);
    if (invites.length > 0) kind = 'invite';
  }
  if (!kind) return;

  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `insert into password_tokens (email, token_hash, expires_at) values ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [normalized, hashToken(token), String(TOKEN_TTL_MINUTES)]
  );

  const link = `${webOrigin.replace(/\/$/, '')}/set-password?token=${encodeURIComponent(token)}`;
  const intro =
    kind === 'invite'
      ? 'You have been invited to NEXUS. Use this link to choose a password and finish setting up your account.'
      : 'Use this link to choose a NEXUS password. If you already had one, it will be replaced.';
  await getEmailProvider().send({
    to: normalized,
    subject: kind === 'invite' ? 'Set up your NEXUS account' : 'Your NEXUS password link',
    text: `${intro}\n\n${link}\n\nThis link works once and expires in ${TOKEN_TTL_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`,
    html:
      `<p>${intro}</p>` +
      `<p><a href="${link}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#5b52f0;color:#ffffff;text-decoration:none;font-weight:600">Choose a password</a></p>` +
      `<p style="color:#666;font-size:13px">This link works once and expires in ${TOKEN_TTL_MINUTES} minutes. If you didn't ask for it, you can ignore this email.</p>`,
  });
}

/** Consumes a one-time link: sets the password (accepting a pending invite
 * first if the person has no account yet) and returns who to sign in. */
export async function setPasswordWithToken(params: {
  token: string;
  password: string;
  name?: string;
}): Promise<{ userId: string; orgId: string; createdAccount: boolean }> {
  const problem = validatePassword(params.password);
  if (problem) throw new PasswordAuthError('weak_password', problem);

  const { rows } = await pool.query<{ email: string }>(
    `update password_tokens set used_at = now()
      where token_hash = $1 and used_at is null and expires_at > now()
      returning email`,
    [hashToken(params.token ?? '')]
  );
  const email = rows[0]?.email;
  if (!email) {
    throw new PasswordAuthError('invalid_token', 'This link has expired or was already used. Ask for a new one.');
  }

  let userId: string;
  let orgId: string;
  let createdAccount = false;
  const { rows: users } = await pool.query<{ id: string; org_id: string }>(
    `select id, org_id from find_user_by_email($1)`,
    [email]
  );
  if (users[0]) {
    ({ id: userId, org_id: orgId } = users[0]);
  } else {
    try {
      const displayName = params.name?.trim() || email.split('@')[0]!;
      const accepted = await acceptInvite({ email, googleDisplayName: displayName.slice(0, 120) });
      userId = accepted.userId;
      orgId = accepted.orgId;
      createdAccount = true;
    } catch (err) {
      if (err instanceof InviteError) {
        throw new PasswordAuthError(err.code === 'expired' ? 'invite_expired' : 'not_invited', err.message);
      }
      throw err;
    }
  }

  await pool.query(`select set_user_password($1, $2)`, [userId, hashPassword(params.password)]);
  // Any other outstanding links for this address stop working.
  await pool.query(`update password_tokens set used_at = now() where lower(email) = $1 and used_at is null`, [email]);
  return { userId, orgId, createdAccount };
}
