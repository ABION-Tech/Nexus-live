// PRD §6.4.1 `knowledge/` domain routes — Knowledge Base CRUD + context
// retrieval (§8.6). Flat `knowledge` resource grant, same shape as
// goals.ts: no per-record owner in the source sheet to branch on (see
// knowledgeService.ts's header comment).
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import {
  archiveKnowledgeEntry,
  createKnowledgeEntry,
  getKnowledgeEntryById,
  listKnowledgeEntries,
  updateKnowledgeEntry,
} from '../services/knowledgeService.js';
import type { KnowledgeEntryInput } from '@nexus/shared';

export async function registerKnowledgeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'knowledge', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'knowledge'." });
      return;
    }
    const q = req.query as { search?: string; category?: string; includeArchived?: string };
    const entries = await listKnowledgeEntries(user.orgId, {
      search: q.search,
      category: q.category,
      includeArchived: q.includeArchived === 'true',
    });
    reply.send({ entries });
  });

  app.get('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'knowledge', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'knowledge'." });
      return;
    }
    const { id } = req.params as { id: string };
    const entry = await getKnowledgeEntryById(user.orgId, id);
    if (!entry) {
      reply.status(404).send({ error: 'not_found', message: 'Knowledge entry not found.' });
      return;
    }
    reply.send(entry);
  });

  app.post('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'knowledge', 'create'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'knowledge'." });
      return;
    }
    const body = req.body as Partial<KnowledgeEntryInput>;
    if (!body?.title || typeof body.title !== 'string') {
      reply.status(400).send({ error: 'invalid_body', message: 'title is required.' });
      return;
    }
    if (!body?.content || typeof body.content !== 'string') {
      reply.status(400).send({ error: 'invalid_body', message: 'content is required.' });
      return;
    }
    const entry = await createKnowledgeEntry(user.orgId, body as KnowledgeEntryInput, user.userId);
    reply.status(201).send(entry);
  });

  app.patch('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'knowledge', 'update'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'knowledge'." });
      return;
    }
    const { id } = req.params as { id: string };
    const body = req.body as Partial<KnowledgeEntryInput>;
    const entry = await updateKnowledgeEntry(user.orgId, id, body, user.userId);
    if (!entry) {
      reply.status(404).send({ error: 'not_found', message: 'Knowledge entry not found or already archived.' });
      return;
    }
    reply.send(entry);
  });

  // Archive, not hard-delete — PRD §6.4.1's "DELETE archives" convention,
  // same as goals.ts / networkService.ts's own archive endpoints.
  app.delete('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'knowledge', 'delete'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'delete' permission on 'knowledge'." });
      return;
    }
    const { id } = req.params as { id: string };
    const entry = await archiveKnowledgeEntry(user.orgId, id, user.userId);
    if (!entry) {
      reply.status(404).send({ error: 'not_found', message: 'Knowledge entry not found or already archived.' });
      return;
    }
    reply.send(entry);
  });
}
