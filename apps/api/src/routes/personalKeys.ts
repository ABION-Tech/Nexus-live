// Session 56 — personal API keys.
//
//   /api/v1/me/keys          (signed in, browser session)
//     GET     list my active keys (never the key itself)
//     POST    { name, canImport? } → create; the response carries the key ONCE
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
import { findMyCompany, importTasks, TaskImportError, type ImportTaskInput } from '../services/taskImportService.js';
import { logOrgAction } from '../services/auditLogService.js';
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
        const body = req.body as { name?: unknown; canImport?: unknown } | null;
        const { key, secret } = await createKey(user.userId, user.orgId, body?.name, body?.canImport === true);
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

// Session 59 — POST /api/v1/integrations/tasks/import
//   { company: "RescueTap", tasks: ImportTaskInput[] (≤ 200) }
// Key must carry 'tasks:import'; the company must be one you belong to.
// Returns one { externalRef, id, outcome } per task, in order.
export async function registerImportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    const identity = await requireKey(req);
    if (!identity) return reply.status(401).header('WWW-Authenticate', 'Bearer').send({ error: 'invalid_key', message: 'Missing, unknown or revoked key.' });
    if (!identity.scopes.includes('tasks:import')) return reply.status(403).send({ error: 'forbidden', message: 'This key cannot import tasks.' });
    req.keyIdentity = identity;
  });

  app.post('/import', { bodyLimit: 2_000_000, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const who = req.keyIdentity!;
    const body = req.body as { company?: unknown; tasks?: unknown } | null;
    if (typeof body?.company !== 'string' || !Array.isArray(body.tasks) || body.tasks.length === 0 || body.tasks.length > 200) {
      return reply.status(400).send({ error: 'invalid_body', message: 'Send { company, tasks: [...] } with 1 to 200 tasks.' });
    }
    // Session 60 (C-14): every import is logged — in the server log, and
    // in the company's own Activity/audit log once we know the company —
    // with which key did it and what happened to each task.
    const source = String(req.headers['user-agent'] ?? '').slice(0, 120);
    let company: { orgId: string; name: string } | null = null;
    try {
      company = await findMyCompany(who.userId, body.company);
      const results = await importTasks(who.userId, company.orgId, body.tasks as ImportTaskInput[]);
      const counts = results.reduce<Record<string, number>>((m, r) => ((m[r.outcome] = (m[r.outcome] ?? 0) + 1), m), {});
      req.log.info({ keyId: who.keyId, userId: who.userId, orgId: company.orgId, counts }, 'tasks imported');
      await logOrgAction(company.orgId, {
        userId: who.userId,
        action: 'tasks.import',
        resourceType: 'task',
        result: 'success',
        userAgent: source,
        metadata: { keyId: who.keyId, sent: results.length, ...counts },
      }).catch((e: unknown) => req.log.error({ err: e instanceof Error ? e.message : String(e) }, 'import audit log failed'));
      return { company, results };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.warn({ keyId: who.keyId, userId: who.userId, company: body.company, err: message }, 'task import failed');
      if (company) {
        await logOrgAction(company.orgId, {
          userId: who.userId,
          action: 'tasks.import',
          resourceType: 'task',
          result: 'error',
          userAgent: source,
          metadata: { keyId: who.keyId, sent: body.tasks.length, error: message.slice(0, 500) },
        }).catch(() => undefined);
      }
      if (err instanceof TaskImportError) return reply.status(err.code === 'not_member' ? 403 : 400).send({ error: err.code, message: err.message });
      throw err;
    }
  });
}
