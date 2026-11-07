// PRD §6.4.1-style domain routes for Chat (AI Analyst > Chat, PRD §7.2
// 08). AI Analyst is `permissionGated` in ia.ts, same as Goals — flat
// `hasPermission` checks here, no own-record branch, matching goals.ts's
// reasoning (PRD §13.3's example grants show this at the `chat.*`
// leader-role level, no `chat.own` case).
//
// Session 33/34 additions: `GET /stream` (SSE, real-time delivery —
// supersedes the "polling interval is currently client-driven" note in
// PRD §8.11), cursor pagination on `GET /`, and `GET /export`.
import type { FastifyInstance } from 'fastify';
import type { FastifyReply } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import {
  exportChatThread,
  listChatMessagesPage,
  sendChatMessage,
} from '../services/chatService.js';
import { subscribeToChatStream } from '../services/sseHub.js';
import { canViewTaskThread, getTaskById } from '../services/taskService.js';
import type { SessionUser } from '../services/sessionService.js';

// Session 35 — a task thread's access rule is task visibility, not the
// 'chat' resource at all: a general `tasks.read` grant OR being the
// task's assignee/support/supervisor (canViewTaskThread). Shared by
// GET/POST/stream below rather than duplicated three times; returns the
// task on success so callers don't need a second getTaskById round trip,
// or sends the 404/403 itself and returns null so the caller can bail.
async function authorizeTaskThread(user: SessionUser, taskId: string, reply: FastifyReply) {
  const task = await getTaskById(user.orgId, taskId);
  if (!task) {
    reply.status(404).send({ error: 'not_found', message: 'Task not found.' });
    return null;
  }
  const allowed = (await hasPermission(user, 'tasks', 'read')) || canViewTaskThread(task, user.userId);
  if (!allowed) {
    reply.status(403).send({ error: 'forbidden', message: 'Missing access to this task thread.' });
    return null;
  }
  return task;
}

// Matches sseHub's own heartbeat expectation: frequent enough that a
// proxy/load-balancer's idle-connection timeout (commonly 30-60s) never
// fires on a quiet thread, infrequent enough not to be noise in server
// logs or network tabs.
const HEARTBEAT_INTERVAL_MS = 25_000;

export async function registerChatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (req, reply) => {
    const user = req.sessionUser!;
    const q = req.query as { before?: string; limit?: string; taskId?: string };

    if (q.taskId) {
      const task = await authorizeTaskThread(user, q.taskId, reply);
      if (!task) return; // authorizeTaskThread already sent 404/403
    } else if (!(await hasPermission(user, 'chat', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'chat'." });
      return;
    }

    const limit = q.limit ? Number(q.limit) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      reply.status(400).send({ error: 'invalid_query', message: 'limit must be a positive number.' });
      return;
    }
    const page = await listChatMessagesPage(user.orgId, { before: q.before, limit, taskId: q.taskId });
    reply.send(page);
  });

  app.post('/', async (req, reply) => {
    const user = req.sessionUser!;
    const body = req.body as { body?: string; taskId?: string };

    if (body.taskId) {
      const task = await authorizeTaskThread(user, body.taskId, reply);
      if (!task) return;
    } else if (!(await hasPermission(user, 'chat', 'create'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'chat'." });
      return;
    }

    if (!body?.body || typeof body.body !== 'string' || !body.body.trim()) {
      reply.status(400).send({ error: 'invalid_body', message: 'body is required.' });
      return;
    }

    // Session 7 — AI chat cross-referencing. Only meaningful for the
    // org-wide 'ai' thread (task threads get no AI reply at all, see
    // chatService.ts's own early return), so this is never even checked
    // when body.taskId is set — no point spending a permissions lookup
    // on a flag sendChatMessage would ignore anyway.
    const crossReferenceEnabled = !body.taskId && (await hasPermission(user, 'ai_cross_reference', 'read'));

    const result = await sendChatMessage(user.orgId, user.userId, body.body.trim(), body.taskId, crossReferenceEnabled);
    reply.status(201).send(result);
  });

  // GET /chat/export — plain-text download of the full thread, gated on
  // the 'export' action already defined in rbac.ts's PermissionAction
  // union (used nowhere else yet). Leaders get this for free the same
  // way they get every other flat grant (rbac.ts's role bypass); any
  // other role needs an explicit `chat`+`export` row, matching the
  // plan's "leaders only" intent without hardcoding a role check the
  // rest of this codebase deliberately avoids.
  app.get('/export', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'chat', 'export'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'export' permission on 'chat'." });
      return;
    }
    const text = await exportChatThread(user.orgId);
    reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="nexus-chat-export.txt"')
      .send(text);
  });

  // GET /chat/stream — SSE. Auth via the same httpOnly session cookie
  // as every other route (browsers attach cookies to EventSource
  // requests automatically when `withCredentials: true` is set
  // client-side — no separate token scheme needed, and PRD §13.2's
  // "never in URL query strings" rule stays intact).
  app.get('/stream', async (req, reply) => {
    const user = req.sessionUser!;
    const q = req.query as { taskId?: string };

    if (q.taskId) {
      const task = await authorizeTaskThread(user, q.taskId, reply);
      if (!task) return;
    } else if (!(await hasPermission(user, 'chat', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'chat'." });
      return;
    }

    // Hijack: take raw control of the response so it can be held open
    // and written to repeatedly, instead of Fastify closing it after a
    // single `reply.send()`. This is the one route in the codebase that
    // needs this — every other route returns once and is done.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disables buffering on nginx-style reverse proxies that would
      // otherwise hold the stream open without flushing chunks through.
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');

    const unsubscribe = subscribeToChatStream(user.orgId, res, q.taskId);
    const heartbeat = setInterval(() => {
      res.write(':heartbeat\n\n');
    }, HEARTBEAT_INTERVAL_MS);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
