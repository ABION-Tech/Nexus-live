// Dev-only "log in as" roster picker — the fallback the login blocker
// this session actually needs: testing NEXUS on a machine/browser where
// Google OAuth isn't set up (no client configured) or where the tester's
// own Google account isn't the one signed into that device/browser.
//
// PRD §10.1 is unchanged by this file: Google OAuth is still the only
// production login path. This is not a password system — there is no
// password anywhere in this flow, on purpose. It's a straight "you are
// already on the roster (a leader added you), so pick your name and
// skip Google" shortcut, and it is refused entirely (isDevLoginEnabled()
// returns false, buildServer() never registers this router) unless
// DEV_LOGIN=true is explicitly set AND NODE_ENV !== 'production'. Both
// conditions are checked here, not just at the call site in server.ts,
// so this file is safe to import even if a future refactor changes how
// it gets mounted.
import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { createSession } from '../services/sessionService.js';
import { SESSION_COOKIE_NAME } from '../plugins/auth.js';

const isProd = process.env.NODE_ENV === 'production';

export function isDevLoginEnabled(): boolean {
  return !isProd && process.env.DEV_LOGIN === 'true';
}

export async function registerDevAuthRoutes(app: FastifyInstance) {
  // Belt-and-suspenders: even if this somehow got registered anyway,
  // every handler below re-checks and refuses.
  app.addHook('onRequest', async (_req, reply) => {
    if (!isDevLoginEnabled()) {
      reply.status(404).send({ error: 'not_found' });
    }
  });

  // Roster for the picker — id/name/email/org only, via the same narrow
  // SECURITY DEFINER shape as find_user_by_email (0003_invites.sql).
  app.get('/roster', async () => {
    const { rows } = await pool.query(
      `select id, name, email, org_id, role from list_users_for_dev_login()`
    );
    return {
      users: rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        orgId: r.org_id,
        role: r.role,
      })),
    };
  });

  // Log in as the chosen roster user — no password, no verification
  // beyond "this id came back from /roster", because the whole point is
  // that a leader already vouched for this person by adding them.
  app.post('/', async (req, reply) => {
    const { userId } = (req.body as { userId?: string }) ?? {};
    if (!userId) {
      reply.status(400).send({ error: 'missing_user_id', message: 'userId is required.' });
      return;
    }

    const { rows } = await pool.query(
      `select org_id from list_users_for_dev_login() where id = $1`,
      [userId]
    );
    if (rows.length === 0) {
      reply.status(404).send({ error: 'not_found', message: 'No such roster user.' });
      return;
    }

    const { token, expiresAt } = await createSession(userId, rows[0].org_id);

    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      expires: expiresAt,
      path: '/',
    });

    reply.send({ ok: true });
  });
}
