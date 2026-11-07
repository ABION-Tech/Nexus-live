// Session 50 — PRD §14 light/dark toggle. Self-service only: no
// resource/action permission gate the way permissions.ts's routes have
// (hasPermission('permissions', ...)) — a user reading/writing their own
// theme preference isn't an RBAC-gated action on someone else's data,
// it's the same "any authenticated user, own record" shape as changing
// your own password would be. requireAuth is the whole check.
import type { FastifyInstance } from 'fastify';
import { getThemePreference, setThemePreference, isThemePreference } from '../services/userPreferencesService.js';

export async function registerUserPreferencesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // Mirrors what GET /auth/session already returns inline — exists as
  // its own endpoint too so a settings page can re-fetch just this one
  // value (e.g. after another tab changes it) without a full session
  // round trip.
  app.get('/theme', async (req, reply) => {
    const user = req.sessionUser!;
    const themePreference = await getThemePreference(user.orgId, user.userId);
    reply.send({ themePreference });
  });

  app.patch('/theme', async (req, reply) => {
    const user = req.sessionUser!;
    const body = (req.body as { themePreference?: unknown }) ?? {};
    if (!isThemePreference(body.themePreference)) {
      reply.status(400).send({ error: 'invalid_body', message: "themePreference must be 'light' or 'dark'." });
      return;
    }
    const themePreference = await setThemePreference(user.orgId, user.userId, body.themePreference);
    reply.send({ themePreference });
  });
}
