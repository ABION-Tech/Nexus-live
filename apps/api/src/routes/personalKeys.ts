// Session 56 — personal API keys.
//
//   /api/v1/me/keys          (signed in, browser session)
//     GET     list my active keys (never the key itself)
//     POST    { name } → create; the response carries the key ONCE
//     DELETE  /:id → revoke
//
//   /api/v1/integrations     (personal key: "Authorization: Bearer nxk_…")
//     GET /my-tasks          tasks I own, support or supervise, in every company I'm in
//
// The two halves never mix: key management only accepts a session cookie
// (a leaked key can't mint more keys or revoke yours), and the
// integration routes only accept a key (a browser session can't be used
// to drive them cross-site).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { listMyWorkAcrossCompanies } from '../services/workspaceService.js';
import { createKey, listKeys, revokeKey, verifyKey, PersonalKeyError, type KeyIdentity } from '../services/personalKeyService.js';

const WEB_ORIGIN = () => (process.env.WEB_ORIGIN || 'https://app.nexusabion.com').replace(/\/$/, '');

export async function registerPersonalKeyRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.requireAuth }, async (req) => {
    return { keys: await listKeys(req.sessionUser!.userId) };
  });

  app.post(
    '/',
    { preHandler: app.requireAuth, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const user = req.sessionUser!;
      if (user.impersonatedBy) {
        return reply.status(403).send({ error: 'forbidden', message: "Keys can't be created while viewing as someone else." });
      }
      try {
        const { key, secret } = await createKey(user.userId, user.orgId, (req.body as { name?: unknown } | null)?.name);
        return reply.status(201).send({ key, secret });
      } catch (err) {
        if (err instanceof PersonalKeyError) return reply.status(400).send({ error: err.code, message: err.message });
        throw err;
      }
    }
  );

  app.delete('/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const ok = await revokeKey(req.sessionUser!.userId, (req.params as { id: string }).id);
    if (!ok) return reply.status(404).send({ error: 'not_found', message: 'No such key.' });
    return { ok: true };
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    keyIdentity?: KeyIdentity;
  }
}

async function requireKey(req: FastifyRequest): Promise<KeyIdentity | null> {
  const header = req.headers.authorization || '';
  const raw = header.replace(/^Bearer\s+/i, '').trim();
  if (!raw) return null;
  return verifyKey(raw);
}

export async function registerIntegrationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    const identity = await requireKey(req);
    if (!identity) {
      return reply
        .status(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ error: 'invalid_key', message: 'Missing, unknown or revoked key. Create one in Nexus → Settings → Account.' });
    }
    req.keyIdentity = identity;
  });

  app.get('/my-tasks', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const who = req.keyIdentity!;
    if (!who.scopes.includes('tasks:read')) return reply.status(403).send({ error: 'forbidden', message: 'This key cannot read tasks.' });

    const q = req.query as { includeDone?: string };
    const includeDone = q.includeDone === 'true';
    // Session 57: your tasks in every company you belong to, each tagged
    // with its company. `organization` (top level) stays the company the
    // key was created in, so older readers keep working.
    const { companies, tasks } = await listMyWorkAcrossCompanies(who.userId, { includeDone: true });
    const keyOrg = companies.find((c) => c.id === who.orgId);

    const base = WEB_ORIGIN();
    return {
      organization: { id: who.orgId, name: keyOrg?.name ?? null },
      companies: companies.map((c) => ({ id: c.id, name: c.name })),
      fetchedAt: new Date().toISOString(),
      tasks: tasks
        .filter((t) => includeDone || t.status !== 'done')
        .map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description ?? null,
          status: t.status,
          priority: t.priority,
          role: t.role,
          startDate: t.startDate ?? null,
          deadline: t.deadline ?? null,
          department: t.department ?? null,
          business: t.business ?? null,
          updatedAt: t.updatedAt,
          organization: t.company,
          url: `${base}/work/my-tasks`,
        })),
    };
  });
}
