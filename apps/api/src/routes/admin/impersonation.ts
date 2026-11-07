// routes/admin/impersonation.ts — ADMIN_BUILD_GUIDE.md §5 "Session 11".
// Own prefix, own gate (requireImpersonationGrant, not
// requirePlatformAdmin) — mirrors superAdmin.ts's per-route gating
// style (403 with the same { error, message } shape) but deliberately
// does NOT reuse requirePlatformAdmin: the guide is explicit that
// holding platform_admins must never be sufficient on its own (see
// authorizationService.isImpersonationGranted's own doc comment).
import type { FastifyInstance } from 'fastify';
import { isImpersonationGranted } from '../../services/authorizationService.js';
import { startImpersonation, endImpersonation, setImpersonationMode, ImpersonationError } from '../../services/impersonationService.js';

async function requireImpersonationGrant(req: any, reply: any): Promise<boolean> {
  const user = req.sessionUser;
  if (!user) {
    reply.status(401).send({ error: 'unauthenticated', message: 'Sign in required.' });
    return false;
  }
  if (!(await isImpersonationGranted(user.userId))) {
    reply.status(403).send({ error: 'forbidden', message: 'Impersonation has not been granted to this account.' });
    return false;
  }
  return true;
}

function statusFor(code: ImpersonationError['code']): number {
  switch (code) {
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'already_active':
      return 409;
    default:
      return 400;
  }
}

export async function registerImpersonationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // Starting an impersonation is itself gated on the grant, checked
  // before startImpersonation() re-checks it (defense in depth, same
  // posture as its own doc comment) — this route-level check exists so
  // an ungranted caller gets a clean 403 without touching the session
  // table at all.
  app.post('/start', async (req, reply) => {
    if (!(await requireImpersonationGrant(req, reply))) return;
    const user = req.sessionUser!;
    const body = req.body as { targetUserId?: string; targetOrgId?: string; reason?: string; mode?: 'read_only' | 'write' };
    if (!body?.targetUserId || !body?.targetOrgId || !body?.reason) {
      reply.status(400).send({ error: 'invalid_body', message: 'targetUserId, targetOrgId, and reason are required.' });
      return;
    }
    try {
      const result = await startImpersonation(
        user,
        { targetUserId: body.targetUserId, targetOrgId: body.targetOrgId, reason: body.reason, mode: body.mode },
        { ipAddress: req.ip, userAgent: req.headers['user-agent'] }
      );
      // Same cookie mechanics as routes/auth.ts's own login — httpOnly,
      // Secure in prod, sameSite. Overwrites the actor's own session
      // cookie for the duration of the impersonation (that's the point:
      // the browser genuinely becomes the target). The actor's original
      // session row is untouched, not revoked — logging out of the
      // impersonation (POST /end) is what restores it; the actor should
      // sign back in normally afterward, same as this codebase's
      // existing session model has no "return to previous session"
      // stack.
      reply.setCookie('nexus_session', result.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        expires: result.expiresAt,
      });
      reply.status(201).send({ impersonationId: result.impersonationId, mode: result.mode, expiresAt: result.expiresAt.toISOString() });
    } catch (err) {
      if (err instanceof ImpersonationError) {
        reply.status(statusFor(err.code)).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  // No requireImpersonationGrant here on purpose: the caller of this
  // route is, by construction, authenticated *as the target* — the
  // whole point of impersonation. Gating this on the actor's own grant
  // would mean the grant needs re-checking from inside someone else's
  // identity, which is backwards. endImpersonation() itself derives
  // everything it needs from req.sessionUser.impersonatedBy, and throws
  // ImpersonationError('invalid', ...) if this session isn't actually
  // an impersonation — that's the real gate here.
  app.post('/end', async (req, reply) => {
    const user = req.sessionUser;
    if (!user) {
      reply.status(401).send({ error: 'unauthenticated', message: 'Sign in required.' });
      return;
    }
    try {
      await endImpersonation(user, 'manual_exit');
      reply.clearCookie('nexus_session', { path: '/' });
      reply.status(204).send();
    } catch (err) {
      if (err instanceof ImpersonationError) {
        reply.status(statusFor(err.code)).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  // Same "no requireImpersonationGrant" reasoning as /end above — this
  // is scoped to the caller's own current impersonation session, not a
  // general capability check.
  app.post('/mode', async (req, reply) => {
    const user = req.sessionUser;
    if (!user) {
      reply.status(401).send({ error: 'unauthenticated', message: 'Sign in required.' });
      return;
    }
    const body = req.body as { mode?: 'read_only' | 'write' };
    if (body?.mode !== 'read_only' && body?.mode !== 'write') {
      reply.status(400).send({ error: 'invalid_body', message: "mode must be 'read_only' or 'write'." });
      return;
    }
    try {
      await setImpersonationMode(user, body.mode);
      reply.status(204).send();
    } catch (err) {
      if (err instanceof ImpersonationError) {
        reply.status(statusFor(err.code)).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });
}
