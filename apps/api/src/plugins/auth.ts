// Decorates every request with `req.sessionUser` (or undefined) by
// reading the httpOnly session cookie. This runs globally and is
// non-blocking — it establishes *who*, not *whether they're allowed*.
// Authorization (the RBAC 4-check chain, PRD §13.3) is a separate
// plugin (rbac.ts) applied per-route, deliberately: PRD is explicit that
// authentication and authorization are independent checks.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { verifySession, type SessionUser } from '../services/sessionService.js';

export const SESSION_COOKIE_NAME = 'nexus_session';

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser?: SessionUser;
  }
}

async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('sessionUser', undefined);

  app.addHook('onRequest', async (req: FastifyRequest) => {
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    if (!token) return;
    const user = await verifySession(token);
    if (user) req.sessionUser = user;
    // Invalid/expired/revoked token: leave sessionUser undefined and say
    // nothing further here. requireAuth (below) is what turns "no user"
    // into a 401 for routes that need it — routes that don't require
    // auth (e.g. /system/health) should keep working with a stale cookie
    // present.
  });

  // Route-level guard: attach as a preHandler on anything that needs a
  // logged-in user. Kept as a decorator (not the onRequest hook itself)
  // so public routes aren't forced through it.
  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.sessionUser) {
      reply.status(401).send({ error: 'unauthenticated', message: 'Sign in required.' });
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(authPlugin);
