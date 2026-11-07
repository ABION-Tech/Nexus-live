// impersonationService.ts — ADMIN_BUILD_GUIDE.md §5 "Session 11 —
// Impersonation". Unblocked by 0027's live-Postgres isolation pass per
// the guide's own gating note.
//
// Three operations: start, end, change mode (elevate/de-elevate). Each
// is its own audited platform action (logPlatformActionSafely) — start
// and end are never silent, and a mode change to 'write' is exactly as
// visible in the audit trail as the impersonation itself, not folded
// into it, so "who turned write mode on and when" is its own filterable
// question in the Super Admin audit-log view.
//
// Deliberately does not touch the target's own live sessions (doesn't
// force-revoke them). Two valid sessions for one user_id is already a
// supported shape (sessions has no uniqueness constraint on user_id) —
// this reuses that rather than inventing new behavior. Flagged as an
// open question in this session's own scoping pass, not resolved here:
// revisit if support workflows show it's actually needed.
import { pool, withOrgContext } from '../db.js';
import { createSession, revokeSessionById, type SessionUser } from './sessionService.js';
import { isImpersonationGranted } from './authorizationService.js';
import { logPlatformActionSafely } from './auditLogService.js';

export class ImpersonationError extends Error {
  constructor(
    public code: 'forbidden' | 'not_found' | 'invalid' | 'already_active',
    message: string
  ) {
    super(message);
    this.name = 'ImpersonationError';
  }
}

export interface StartImpersonationInput {
  targetUserId: string;
  targetOrgId: string;
  reason: string;
  mode?: 'read_only' | 'write';
}

export interface StartImpersonationResult {
  impersonationId: string;
  token: string;
  expiresAt: Date;
  mode: 'read_only' | 'write';
}

/** Starts an impersonation: mints a real session for the target (so the
 * actor's browser genuinely sees exactly what the target sees — routes,
 * permission checks, everything runs as the target, no shadow code
 * path), then links it to a new impersonation_sessions row.
 *
 * Checks isImpersonationGranted() itself, not just at the route layer —
 * same defense-in-depth posture organizationService.createOrganization
 * already takes for isPlatformAdmin(): "JS checks first" happens twice
 * on purpose (route + service), the DB/table itself is the only single
 * point of truth. */
export async function startImpersonation(
  actor: SessionUser,
  input: StartImpersonationInput,
  meta: { ipAddress?: string; userAgent?: string } = {}
): Promise<StartImpersonationResult> {
  if (!(await isImpersonationGranted(actor.userId))) {
    throw new ImpersonationError('forbidden', 'Impersonation has not been granted to this account.');
  }
  if (input.targetUserId === actor.userId) {
    throw new ImpersonationError('invalid', 'Cannot impersonate your own account.');
  }
  if (!input.reason || input.reason.trim().length === 0) {
    throw new ImpersonationError('invalid', 'A reason is required to start an impersonation session.');
  }

  // One active impersonation per actor at a time — prevents a stray
  // browser tab from silently holding two impersonation cookies for two
  // different targets, which would make "who am I right now" ambiguous
  // for the very audit trail this whole feature exists to keep honest.
  const { rows: existing } = await pool.query(
    `select 1 from impersonation_sessions where actor_user_id = $1 and ended_at is null limit 1`,
    [actor.userId]
  );
  if (existing.length > 0) {
    throw new ImpersonationError('already_active', 'You already have an active impersonation session. End it before starting another.');
  }

  // Confirm the target is actually a member of the target org — inside
  // withOrgContext, same as every other membership check in this
  // codebase, not a raw-pool query against `users`/`org_memberships`
  // (both RLS-protected, would silently return nothing with no context
  // set, per sessionService.ts's own doc comment on exactly this trap).
  const membership = await withOrgContext(input.targetOrgId, async (client) => {
    const { rows } = await client.query(
      `select 1 from org_memberships where user_id = $1 and org_id = $2 limit 1`,
      [input.targetUserId, input.targetOrgId]
    );
    return rows.length > 0;
  });
  if (!membership) {
    throw new ImpersonationError('not_found', 'No such user in that organization.');
  }

  const mode = input.mode === 'write' ? 'write' : 'read_only';
  const { sessionId, token, expiresAt } = await createSession(input.targetUserId, input.targetOrgId);

  const { rows } = await pool.query<{ id: string }>(
    `insert into impersonation_sessions (
       actor_user_id, actor_name, target_user_id, target_org_id, session_id, reason, mode, ip_address, user_agent
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id`,
    [actor.userId, actor.name, input.targetUserId, input.targetOrgId, sessionId, input.reason.trim(), mode, meta.ipAddress ?? null, meta.userAgent ?? null]
  );
  const impersonationId = rows[0]!.id;

  await logPlatformActionSafely({
    userId: actor.userId,
    action: 'impersonation.start',
    resourceType: 'user',
    resourceId: input.targetUserId,
    result: 'success',
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { impersonationId, targetOrgId: input.targetOrgId, reason: input.reason.trim(), mode },
  });

  return { impersonationId, token, expiresAt, mode };
}

/** Ends the impersonation identified by the *current* session's
 * `impersonatedBy` context — deliberately not by an id passed in the
 * request body: the caller of POST /end is, by definition, authenticated
 * as the target (that's what impersonation means), so the only
 * impersonation it's ever valid for this request to end is the one the
 * session itself carries. Taking an arbitrary id from the body would let
 * an impersonated write-mode session end a *different, unrelated*
 * impersonation it has no business touching. */
export async function endImpersonation(
  user: SessionUser,
  endReason: 'manual_exit' | 'revoked' = 'manual_exit'
): Promise<void> {
  const impersonation = user.impersonatedBy;
  if (!impersonation) {
    throw new ImpersonationError('invalid', 'This session is not an active impersonation.');
  }

  const { rows } = await pool.query<{ session_id: string | null }>(
    `update impersonation_sessions
        set ended_at = now(), end_reason = $2
      where id = $1 and ended_at is null
      returning session_id`,
    [impersonation.impersonationId, endReason]
  );
  if (rows.length === 0) {
    // Already ended (e.g. double-click, or expired) — not an error;
    // same "treat as already logged out" posture verifySession takes
    // for missing/expired/revoked sessions.
    return;
  }
  if (rows[0]!.session_id) {
    await revokeSessionById(rows[0]!.session_id);
  }

  await logPlatformActionSafely({
    userId: impersonation.actorUserId,
    action: 'impersonation.end',
    resourceType: 'user',
    resourceId: user.userId,
    result: 'success',
    metadata: { impersonationId: impersonation.impersonationId, endReason },
  });
}

/** Elevates (or steps back down) an in-progress impersonation's write
 * access. Its own audited action, deliberately separate from
 * impersonation.start — ADMIN_BUILD_GUIDE.md §5's "read-only by
 * default" means going to 'write' is always a distinct, visible,
 * after-the-fact-reviewable decision, not a parameter chosen once at
 * the start and forgotten. */
export async function setImpersonationMode(user: SessionUser, mode: 'read_only' | 'write'): Promise<void> {
  const impersonation = user.impersonatedBy;
  if (!impersonation) {
    throw new ImpersonationError('invalid', 'This session is not an active impersonation.');
  }

  const { rows } = await pool.query(
    `update impersonation_sessions
        set mode = $2
      where id = $1 and ended_at is null
      returning id`,
    [impersonation.impersonationId, mode]
  );
  if (rows.length === 0) {
    throw new ImpersonationError('not_found', 'No active impersonation session found.');
  }

  await logPlatformActionSafely({
    userId: impersonation.actorUserId,
    action: 'impersonation.mode_change',
    resourceType: 'user',
    resourceId: user.userId,
    result: 'success',
    metadata: { impersonationId: impersonation.impersonationId, mode },
  });
}
