// Settings > Integrations (PRD §7.2 11 SETTINGS) — org-scoped AI provider
// connection. Flat `settings_ai` resource, gated read/update like every
// other resource+action pair (rbac.ts) — leaders bypass automatically;
// nobody else has a grant on this by default, which is the right default
// for org-wide provider credentials.
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import { getMaskedAiSettings, testAiConnection, upsertAiSettings } from '../services/aiSettingsService.js';
import { AIProviderNotConfiguredError } from '../integrations/aiProvider.js';
import { AI_MODEL_OPTIONS } from '@nexus/shared';
import type { AiSettingsInput, AiTestTarget } from '@nexus/shared';

export async function registerAiSettingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'settings_ai', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'settings_ai'." });
      return;
    }
    reply.send(await getMaskedAiSettings(user.orgId));
  });

  app.put('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'settings_ai', 'update'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'settings_ai'." });
      return;
    }
    const body = req.body as Partial<AiSettingsInput>;
    if (!body?.chatModel || !AI_MODEL_OPTIONS.includes(body.chatModel as (typeof AI_MODEL_OPTIONS)[number])) {
      reply.status(400).send({ error: 'invalid_body', message: `chatModel must be one of: ${AI_MODEL_OPTIONS.join(', ')}` });
      return;
    }
    if (body.reportModel && !AI_MODEL_OPTIONS.includes(body.reportModel as (typeof AI_MODEL_OPTIONS)[number])) {
      reply.status(400).send({ error: 'invalid_body', message: `reportModel must be one of: ${AI_MODEL_OPTIONS.join(', ')}` });
      return;
    }
    const settings = await upsertAiSettings(user.orgId, body as AiSettingsInput, user.userId);
    reply.send(settings);
  });

  // Test button — a minimal real completion call, never a raw 500. Both
  // "not configured" and "configured but the call failed" surface as a
  // normal { ok: false, message } response the UI shows inline, so a bad
  // key/URL reads as "connection failed", not an unhandled error toast.
  app.post('/test', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'settings_ai', 'update'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'settings_ai'." });
      return;
    }
    const body = req.body as { target?: AiTestTarget };
    const target: AiTestTarget = body?.target === 'report' ? 'report' : 'chat';
    try {
      const result = await testAiConnection(user.orgId, target);
      reply.send(result);
    } catch (err) {
      if (err instanceof AIProviderNotConfiguredError) {
        reply.send({ ok: false, model: target, message: err.message });
        return;
      }
      reply.send({ ok: false, model: target, message: err instanceof Error ? err.message : 'Connection failed.' });
    }
  });
}
