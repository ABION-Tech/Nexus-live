// Session issuance/verification/revocation. Kept out of routes/auth.ts so
// the HTTP layer stays thin and this logic is unit-testable without a
// Fastify instance.
//
// Design (PRD §13.2): opaque random token in an httpOnly Secure cookie,
// never a JWT/localStorage/URL token. Server-side session row means
// logout / permission-downgrade revocation is a real DELETE, not "wait
// for the token to expire" — a stateless JWT can't do that without an
// extra revocation-list table, which is just this table with more steps.
import crypto from 'node:crypto';
import { pool, withOrgContext } from '../db.js';

const SESSION_TTL_MINUTES = Number(process.env.SESSION_TTL_MINUTES ?? 60);

/** Session 11 (ADMIN_BUILD_GUIDE.md §5). Present only when this session
 * is an active impersonation. `userId`/`orgId`/`role` above already
 * reflect the *target* — that's the whole point of impersonation, seeing
 * exactly what the target user sees — so this carries the *actor's* real
 * identity plus the session's mode, for two things only: (1) the
 * read-only write guard (impersonationGuard.ts), and (2)
 * auditLogService's metadata choke point, so a write made during
 * impersonation is still attributable to the real actor without every
 * route handler needing to know impersonation exists. */
export interface ImpersonationContext {
  impersonationId: string;
  actorUserId: string;
  actorName: string;
  mode: 'read_only' | 'write';
  startedAt: string;
}

export interface SessionUser {
  sessionId: string;
  userId: string;
  orgId: string;
  role: string;
  name: string;
  email: string;
  impersonatedBy?: ImpersonationContext;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Creates a session row for an already-verified user. Returns the raw
 * opaque token to set as the cookie value — this is the only place the
 * raw value ever exists outside the client's cookie jar. Also returns
 * the new row's id: existing callers (auth.ts, devAuth.ts,
 * seedClickthrough.ts) never needed it and can keep ignoring it: Session
 * 11's impersonationService needs it to link an impersonation_sessions
 * row to the session it mints (0028's own header explains why that's a
 * foreign key rather than columns bolted onto this table). */
export async function createSession(userId: string, orgId: string): Promise<{ sessionId: string; token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60_000);

  const { rows } = await pool.query<{ id: string }>(
    `insert into sessions (user_id, org_id, token_hash, expires_at) values ($1, $2, $3, $4) returning id`,
    [userId, orgId, tokenHash, expiresAt]
  );

  return { sessionId: rows[0]!.id, token, expiresAt };
}

/** Looks up a session by raw cookie value. Returns null for missing,
 * expired, or revoked sessions — callers should treat all three as "not
 * logged in", not distinguish them (don't leak which case it was).
 *
 * Deliberately two queries, not one joined query. `sessions` is
 * RLS-exempt (DECISIONS.md #4) but `users` is not — a single query
 * joining straight to `users` before org context is known would hit
 * `users`' RLS policy with no `app.current_org_id` set and silently
 * return zero rows for every session, valid or not. (Caught exactly this
 * way in Session 5 testing, not by inspection.) Step 1 reads the session
 * row on the raw pool to learn `org_id`; step 2 reads the user row inside
 * `withOrgContext`, which is also the first real exercise of the RLS
 * mechanism through a business table rather than a synthetic test row. */
export async function verifySession(token: string): Promise<SessionUser | null> {
  const tokenHash = hashToken(token);

  const { rows: sessionRows } = await pool.query(
    `select id as session_id, user_id, org_id
       from sessions
      where token_hash = $1
        and revoked_at is null
        and expires_at > now()`,
    [tokenHash]
  );

  if (sessionRows.length === 0) return null;
  const { session_id: sessionId, user_id: userId, org_id: orgId } = sessionRows[0];

  // 0006_org_hierarchy_memberships.sql: role now lives on org_memberships,
  // scoped per (user, org) — not a static users.role. `orgId` here is the
  // session's active workspace, so this resolves "this user's role IN
  // THAT workspace", which is exactly what SessionUser.role has always
  // meant to callers (rbac.ts's `user.role === 'leader'` check, etc.) —
  // no downstream change needed, just how the value gets there.
  const user = await withOrgContext(orgId, async (client) => {
    const { rows } = await client.query(
      `select m.role, u.name, u.email
         from users u
         join org_memberships m on m.user_id = u.id and m.org_id = $2
        where u.id = $1`,
      [userId, orgId]
    );
    return rows[0];
  });

  if (!user) return null; // user row vanished (deleted) after session was issued

  // Session 11: is this session currently an active impersonation? Raw
  // pool, no RLS (0028's own header) — same bootstrapping position as
  // the sessions lookup just above, and for the same reason: this needs
  // to be answerable before org context, not after. actor_name is
  // denormalized on the row for exactly this query (see 0028's comment
  // on that column) so this stays a single indexed lookup, not a second
  // cross-table join fighting the same RLS-ordering trap this file's
  // header already documents for `users`.
  const { rows: impersonationRows } = await pool.query(
    `select id, actor_user_id, actor_name, mode, started_at
       from impersonation_sessions
      where session_id = $1
        and ended_at is null`,
    [sessionId]
  );
  const impersonation = impersonationRows[0];

  return {
    sessionId,
    userId,
    orgId,
    role: user.role,
    name: user.name,
    email: user.email,
    impersonatedBy: impersonation
      ? {
          impersonationId: impersonation.id,
          actorUserId: impersonation.actor_user_id,
          actorName: impersonation.actor_name,
          mode: impersonation.mode,
          startedAt: impersonation.started_at.toISOString(),
        }
      : undefined,
  };
}

/** Revokes a single session (logout). */
export async function revokeSession(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await pool.query(`update sessions set revoked_at = now() where token_hash = $1`, [tokenHash]);
}

// --- Mobile OAuth bridge (PRD §16 / Capacitor) -----------------------
//
// The Android app opens the Google consent screen in the *system*
// browser (routes/auth.ts's mobile branch), not the app's own WebView —
// Google actively rejects embedded WebViews for OAuth
// (`disallowed_useragent`). That means /google/callback runs in the
// system browser's process, which has a completely separate cookie jar
// from the app's WebView. Setting the session cookie on that response
// would authenticate the system browser, not the app.
//
// This is a one-time, 60-second-TTL, single-use exchange code — not a
// bearer credential. It carries no authority itself beyond "redeem once,
// immediately, for the token already minted server-side by
// createSession." The actual opaque session token is never in a URL;
// only this short-lived redemption code is, and it's consumed on first
// use. Functionally this is the same shape as an OAuth authorization
// code (§13.2's "never in URL query strings" is about the long-lived
// session token itself, which this preserves).
//
// In-memory, not a DB table: a single API instance is the current
// deployment topology (no horizontal scaling yet — see hosting table in
// PRD §18/§5). If NEXUS ever runs multiple API instances behind a load
// balancer, this needs to move to a shared store (Redis, or a
// short-lived DB table with an index on expires_at) so redemption
// doesn't depend on hitting the same instance that minted the code.
const MOBILE_EXCHANGE_TTL_MS = 60_000;
const mobileExchangeCodes = new Map<string, { token: string; expiresAt: number }>();

function pruneExpiredExchangeCodes(): void {
  const now = Date.now();
  for (const [code, entry] of mobileExchangeCodes) {
    if (entry.expiresAt <= now) mobileExchangeCodes.delete(code);
  }
}

/** Mints a one-time code redeemable for the given session token. Called
 * only from the mobile branch of /google/callback, after createSession
 * has already run. */
export function createMobileExchangeCode(token: string): string {
  pruneExpiredExchangeCodes();
  const code = crypto.randomBytes(24).toString('base64url');
  mobileExchangeCodes.set(code, { token, expiresAt: Date.now() + MOBILE_EXCHANGE_TTL_MS });
  return code;
}

/** Redeems a one-time code for its session token, or null if unknown,
 * expired, or already used. Always deletes the entry — valid or not —
 * so a code can never be redeemed twice, including by an attacker who
 * observes it after legitimate use. */
export function consumeMobileExchangeCode(code: string): string | null {
  pruneExpiredExchangeCodes();
  const entry = mobileExchangeCodes.get(code);
  mobileExchangeCodes.delete(code);
  if (!entry) return null;
  return entry.token;
}

/** Revokes every session for a user (permission downgrade, forced
 * logout-everywhere). Not yet called from any route — wired here so the
 * RBAC/admin work in a later session has it ready. */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await pool.query(`update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [userId]);
}

/** By-id variant for callers that don't hold the raw token — Session
 * 11's impersonationService ending an impersonation only ever has the
 * session's id (from impersonation_sessions.session_id), never the raw
 * cookie value, since the token was minted and handed to a different
 * request than the one ending it. */
export async function revokeSessionById(sessionId: string): Promise<void> {
  await pool.query(`update sessions set revoked_at = now() where id = $1`, [sessionId]);
}
