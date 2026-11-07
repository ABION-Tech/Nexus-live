// Session 11 (ADMIN_BUILD_GUIDE.md §5): "read-only by default." Kept as
// its own tiny global plugin rather than folded into auth.ts's onRequest
// hook — auth.ts's own header is explicit that authentication
// (establishing *who*) and authorization (*whether they're allowed*)
// are deliberately separate plugins; this is an authorization concern
// (blocks an action), so it belongs beside rbac/authorizationService,
// not inside auth.ts. Registered globally in server.ts, immediately
// after authPlugin, so req.sessionUser (and its .impersonatedBy) is
// already resolved by the time this hook runs.
//
// Deliberately method-based (GET/HEAD pass, everything else blocked),
// not route- or permission-based: the whole point of impersonation's
// default mode is "see exactly what they see, change nothing" without
// requiring every existing route to know impersonation exists. A
// platform admin explicitly elevates a session to 'write' mode via
// impersonationService.setImpersonationMode (its own audited action)
// to lift this — there is deliberately no per-route opt-out.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function impersonationGuardPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const impersonation = req.sessionUser?.impersonatedBy;
    if (!impersonation) return;
    if (impersonation.mode !== 'read_only') return;
    if (SAFE_METHODS.has(req.method)) return;

    // The impersonation start/end/elevate routes themselves must still
    // work while impersonating (ending or elevating a read-only session
    // is how a caller gets out of this state at all) — everything else
    // under that prefix is blocked like any other write.
    if (req.url.startsWith('/api/v1/admin/impersonation/')) return;

    reply.status(403).send({
      error: 'impersonation_read_only',
      message: 'This impersonation session is read-only. Elevate to write mode to make changes.',
    });
  });
}

export default fp(impersonationGuardPlugin);
