// PRD §7.2 08 / §8.11 Chat route tests. Same strategy as automation.test.ts/
// files.test.ts: mock sessionService and chatService entirely — this is
// the route/RBAC/validation layer, not a migration/integration test.
// `GET /stream`'s 403 paths are exercised via `app.inject`; its 200
// happy path needs a real listener + `fetch`+`AbortController` instead
// (see that test's own comment — `inject` can't observe a hijacked
// response). Either way, the actual fan-out logic is covered directly
// in sseHub.test.ts, not here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatMessage, ChatMessagePage, SendChatMessageResult } from '@nexus/shared';

const GRANTED_TOKEN = 'granted-token'; // chat.read + chat.create
const EXPORT_TOKEN = 'export-token'; // chat.read + chat.export
const READONLY_TOKEN = 'readonly-token'; // chat.read only
const UNGRANTED_TOKEN = 'ungranted-token'; // nothing
// Session 35 additions — task-thread access, which is gated on task
// visibility (tasks.read grant OR assignee/support/supervisor), not the
// 'chat' resource at all.
const TASK_ASSIGNEE_TOKEN = 'task-assignee-token'; // assignedToUserId on TASK_ONE, no chat/tasks grants
const TASK_SUPPORT_TOKEN = 'task-support-token'; // supportUserId on TASK_ONE, no chat/tasks grants
const TASKS_READER_TOKEN = 'tasks-reader-token'; // general tasks.read grant, uninvolved in any task
// Session 7 — AI chat cross-referencing: chat.create + ai_cross_reference.read
const CROSS_REF_TOKEN = 'cross-ref-token';

const GRANTED = { sessionId: 's1', userId: 'user-granted', orgId: 'org-1', role: 'member', name: 'Granted', email: 'granted@abion.test' };
const EXPORTER = { sessionId: 's2', userId: 'user-exporter', orgId: 'org-1', role: 'leader', name: 'Exporter', email: 'exporter@abion.test' };
const READONLY = { sessionId: 's3', userId: 'user-readonly', orgId: 'org-1', role: 'member', name: 'ReadOnly', email: 'readonly@abion.test' };
const UNGRANTED = { sessionId: 's4', userId: 'user-ungranted', orgId: 'org-1', role: 'member', name: 'Ungranted', email: 'ungranted@abion.test' };
const TASK_ASSIGNEE = { sessionId: 's5', userId: 'user-assignee', orgId: 'org-1', role: 'member', name: 'Assignee', email: 'assignee@abion.test' };
const TASK_SUPPORT = { sessionId: 's6', userId: 'user-support', orgId: 'org-1', role: 'member', name: 'Support', email: 'support@abion.test' };
const TASKS_READER = { sessionId: 's7', userId: 'user-tasks-reader', orgId: 'org-1', role: 'member', name: 'TasksReader', email: 'reader@abion.test' };
const CROSS_REF = { sessionId: 's8', userId: 'user-cross-ref', orgId: 'org-1', role: 'member', name: 'CrossRef', email: 'crossref@abion.test' };

const TASK_ONE_ID = 'task-1'; // assignee: TASK_ASSIGNEE, support: TASK_SUPPORT
const TASK_OTHER_ID = 'task-2'; // nobody in this test file is assigned/support/supervisor

vi.mock('../services/sessionService.js', () => ({
  verifySession: vi.fn(async (token: string) => {
    if (token === GRANTED_TOKEN) return GRANTED;
    if (token === EXPORT_TOKEN) return EXPORTER;
    if (token === READONLY_TOKEN) return READONLY;
    if (token === UNGRANTED_TOKEN) return UNGRANTED;
    if (token === TASK_ASSIGNEE_TOKEN) return TASK_ASSIGNEE;
    if (token === TASK_SUPPORT_TOKEN) return TASK_SUPPORT;
    if (token === TASKS_READER_TOKEN) return TASKS_READER;
    if (token === CROSS_REF_TOKEN) return CROSS_REF;
    return null;
  }),
}));

vi.mock('../plugins/rbac.js', async () => {
  const actual = await vi.importActual<typeof import('../plugins/rbac.js')>('../plugins/rbac.js');
  return {
    ...actual,
    hasPermission: vi.fn(async (user: { userId: string; role: string }, resource: string, action: string) => {
      if (user.role === 'leader') return true; // rbac.ts's own role bypass, applies to every resource
      if (resource === 'chat') {
        if (user.userId === GRANTED.userId) return action === 'read' || action === 'create';
        if (user.userId === READONLY.userId) return action === 'read';
        if (user.userId === CROSS_REF.userId) return action === 'read' || action === 'create';
        return false;
      }
      if (resource === 'tasks') {
        // TASKS_READER and CROSS_REF hold a general tasks.read grant
        // (CROSS_REF's is what lets the "never enables cross-referencing
        // on a task thread" test below reach the thread at all) —
        // everyone else's task-thread access (if any) must come from
        // canViewTaskThread's assignee/support/supervisor check instead,
        // which is exercised via the real taskService.js mock below.
        return (user.userId === TASKS_READER.userId || user.userId === CROSS_REF.userId) && action === 'read';
      }
      // Session 7 — its own resource, deliberately not implied by any
      // 'chat' grant above (CROSS_REF is the only caller who holds it,
      // and holds chat.create separately, same as any other user would
      // need both grants independently in the real permissions table).
      if (resource === 'ai_cross_reference') {
        return user.userId === CROSS_REF.userId && action === 'read';
      }
      return false;
    }),
  };
});

vi.mock('../services/taskService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/taskService.js')>('../services/taskService.js');
  return {
    ...actual, // real canViewTaskThread — exercised for real, not re-mocked
    getTaskById: vi.fn(async (_orgId: string, taskId: string) => {
      if (taskId === TASK_ONE_ID) {
        return {
          id: TASK_ONE_ID,
          orgId: 'org-1',
          title: 'Task one',
          status: 'in_progress',
          assignedToUserId: TASK_ASSIGNEE.userId,
          supportUserId: TASK_SUPPORT.userId,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
      }
      if (taskId === TASK_OTHER_ID) {
        return {
          id: TASK_OTHER_ID,
          orgId: 'org-1',
          title: 'Task two',
          status: 'not_started',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
      }
      return null; // unknown id → 404
    }),
  };
});

const baseMessage: ChatMessage = {
  id: 'msg-1',
  orgId: 'org-1',
  channel: 'ai',
  authorUserId: GRANTED.userId,
  body: 'hello',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const taskMessage: ChatMessage = {
  id: 'msg-task-1',
  orgId: 'org-1',
  channel: 'task',
  taskId: TASK_ONE_ID,
  authorUserId: TASK_ASSIGNEE.userId,
  body: 'task thread hello',
  createdAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../services/chatService.js', () => ({
  listChatMessagesPage: vi.fn(async (_orgId: string, opts: { before?: string; limit?: number; taskId?: string }) => {
    const page: ChatMessagePage = {
      messages: [opts.taskId ? taskMessage : baseMessage],
      hasMore: opts.before ? false : true,
    };
    return page;
  }),
  // Session 35: a taskId argument routes to the task-channel shape
  // (aiMessage always null — task threads are plain human discussion,
  // no AI auto-reply; see chatService.ts's own comment).
  // Session 7: the 5th arg (crossReferenceEnabled) is echoed back onto
  // the response as `crossReferenced` — real chatService.ts only ever
  // sets this true when it actually built and used a snapshot, but this
  // mock's whole job here is letting the route test assert on *what the
  // route decided to pass*, not on chatContextService.ts's own output.
  sendChatMessage: vi.fn(
    async (
      _orgId: string,
      _authorUserId: string,
      _body: string,
      taskId?: string,
      crossReferenceEnabled?: boolean
    ): Promise<SendChatMessageResult> => {
      if (taskId) {
        return { userMessage: { ...taskMessage, taskId }, aiMessage: null };
      }
      return {
        userMessage: baseMessage,
        aiMessage: { ...baseMessage, id: 'msg-2', authorUserId: undefined, body: 'hi there' },
        crossReferenced: crossReferenceEnabled ? true : undefined,
      };
    }
  ),
  exportChatThread: vi.fn(async () => '[2026-01-01T00:00:00.000Z] Granted: hello'),
}));

vi.mock('../services/sseHub.js', () => ({
  subscribeToChatStream: vi.fn(() => () => {}),
  broadcastChatMessage: vi.fn(),
}));

describe('Chat — PRD §7.2 08 / §8.11 routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.COOKIE_SECRET = 'test-secret';
    const { buildServer } = await import('../server.js');
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  describe('GET / (cursor pagination — Session 33/34)', () => {
    it('returns a page for a caller with chat.read', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/chat',
        headers: { cookie: `nexus_session=${READONLY_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as ChatMessagePage;
      expect(body.messages).toHaveLength(1);
      expect(body.hasMore).toBe(true);
    });

    it('passes the before cursor through and reflects hasMore=false at the end of history', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/chat?before=${baseMessage.id}`,
        headers: { cookie: `nexus_session=${READONLY_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().hasMore).toBe(false);
    });

    it('rejects a non-positive limit with 400 (PRD §13.4 pagination enforcement)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/chat?limit=0',
        headers: { cookie: `nexus_session=${READONLY_TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_query');
    });

    it('rejects a caller without chat.read', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/chat',
        headers: { cookie: `nexus_session=${UNGRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST / (send)', () => {
    it('sends a message for a caller with chat.create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
        payload: { body: 'hello' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().userMessage.id).toBe(baseMessage.id);
    });

    it('rejects a caller with only chat.read', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat',
        headers: { cookie: `nexus_session=${READONLY_TOKEN}` },
        payload: { body: 'hello' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects an empty body with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
        payload: { body: '   ' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST / — AI chat cross-referencing (Session 7, its own ai_cross_reference.read grant)', () => {
    it('passes crossReferenceEnabled=true through for a caller holding the grant, and the response reflects it', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat',
        headers: { cookie: `nexus_session=${CROSS_REF_TOKEN}` },
        payload: { body: 'what tasks are blocked right now?' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().crossReferenced).toBe(true);

      const chatServiceModule = await import('../services/chatService.js');
      const call = (chatServiceModule.sendChatMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      expect(call[4]).toBe(true); // crossReferenceEnabled
    });

    it("doesn't enable cross-referencing for a caller with chat.create but no ai_cross_reference grant", async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
        payload: { body: 'hello' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().crossReferenced).toBeUndefined();

      const chatServiceModule = await import('../services/chatService.js');
      const call = (chatServiceModule.sendChatMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      expect(call[4]).toBe(false);
    });

    it('never enables cross-referencing on a task-scoped thread, even for a caller holding the grant', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat',
        headers: { cookie: `nexus_session=${CROSS_REF_TOKEN}` },
        payload: { body: 'checking in', taskId: TASK_OTHER_ID },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().aiMessage).toBeNull();

      const chatServiceModule = await import('../services/chatService.js');
      const call = (chatServiceModule.sendChatMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      expect(call[4]).toBe(false); // never even asked for a task thread
    });
  });

  describe('Task-scoped threads (Session 35 — ?taskId= on GET/POST /, gated on task visibility, not the chat resource)', () => {
    it('lets the task assignee read the thread with no chat grant at all', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/chat?taskId=${TASK_ONE_ID}`,
        headers: { cookie: `nexus_session=${TASK_ASSIGNEE_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().messages[0].taskId).toBe(TASK_ONE_ID);
    });

    it('lets the task support user read and post to the same thread', async () => {
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/chat?taskId=${TASK_ONE_ID}`,
        headers: { cookie: `nexus_session=${TASK_SUPPORT_TOKEN}` },
      });
      expect(getRes.statusCode).toBe(200);

      const postRes = await app.inject({
        method: 'POST',
        url: '/api/v1/chat',
        headers: { cookie: `nexus_session=${TASK_SUPPORT_TOKEN}` },
        payload: { body: 'checking in', taskId: TASK_ONE_ID },
      });
      expect(postRes.statusCode).toBe(201);
      expect(postRes.json().aiMessage).toBeNull(); // no AI auto-reply on task threads
    });

    it('lets a caller with a general tasks.read grant into any task thread, uninvolved or not', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/chat?taskId=${TASK_OTHER_ID}`,
        headers: { cookie: `nexus_session=${TASKS_READER_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects someone not assigned/supporting/supervising and without tasks.read', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/chat?taskId=${TASK_ONE_ID}`,
        headers: { cookie: `nexus_session=${UNGRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("having a chat.read/create grant alone doesn't grant access to a task thread you're not on", async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` }, // chat.read + chat.create, not on TASK_ONE
        payload: { body: 'hi', taskId: TASK_ONE_ID },
      });
      expect(res.statusCode).toBe(403);
    });

    it('404s a taskId that does not exist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/chat?taskId=task-does-not-exist',
        headers: { cookie: `nexus_session=${TASK_ASSIGNEE_TOKEN}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('a leader reads any task thread via the role bypass, no explicit grant needed', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/chat?taskId=${TASK_OTHER_ID}`,
        headers: { cookie: `nexus_session=${EXPORT_TOKEN}` }, // EXPORTER is role: 'leader'
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /export (Session 34 — leader-only in practice via rbac.ts role bypass)', () => {
    it('returns a plain-text attachment for a leader', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/chat/export',
        headers: { cookie: `nexus_session=${EXPORT_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.body).toContain('Granted: hello');
    });

    it('rejects a non-leader without an explicit chat.export grant', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/chat/export',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /stream (SSE — Session 33)', () => {
    it('rejects a caller without chat.read before ever hijacking the response', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/chat/stream',
        headers: { cookie: `nexus_session=${UNGRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });

    // Session 35: ?taskId= on the stream goes through the same
    // task-visibility gate as GET/POST /, not the flat chat.read check —
    // exercised here for its pre-hijack 403/200 paths only, same
    // rationale as the plain-chat case above (sseHub.test.ts covers the
    // actual fan-out/scoping logic against fake connections).
    it('rejects a caller not on the task before ever hijacking the response', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/chat/stream?taskId=${TASK_ONE_ID}`,
        headers: { cookie: `nexus_session=${UNGRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });

    // Unlike every other case in this file, a happy-path hijacked stream
    // can't be asserted through `app.inject()` at all — `reply.hijack()`
    // takes raw control of the response and holds the connection open
    // (heartbeats, no `res.end()`), so `inject()`'s returned promise
    // never settles and the test hangs until it times out. That's what
    // this test did before this fix — five-plus sessions of a
    // known-broken `chat.test.ts` timeout (see SESSION_LOG's running
    // list) traced to this one case. Binding a real ephemeral listener
    // and using `fetch` with an `AbortController` lets us read the
    // response status/headers the instant they arrive and then walk
    // away, which is the only way to observe a hijacked response's
    // happy path without waiting on a connection that's designed to
    // never close on its own. The fan-out/scoping logic itself is still
    // covered separately in sseHub.test.ts, per this file's header note.
    it('lets the task assignee open the stream for their own task thread', async () => {
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const controller = new AbortController();
      try {
        const res = await fetch(`${address}/api/v1/chat/stream?taskId=${TASK_ONE_ID}`, {
          headers: { cookie: `nexus_session=${TASK_ASSIGNEE_TOKEN}` },
          signal: controller.signal,
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
      } finally {
        controller.abort();
      }
    });
  });
});
