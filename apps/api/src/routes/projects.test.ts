// ADMIN_BUILD_GUIDE.md §2 route tests. Same strategy as permissions.test.ts:
// mock sessionService, rbac's hasPermission, and projectService entirely
// — this is the route/permission-fallback layer under test, not a
// migration/integration test (that's projectService.test.ts, which mocks
// db.js instead and exercises the actual query logic).
//
// The scenario this file exists to prove, closing the gap Session 37's
// SESSION_LOG entry flagged explicitly ("Guest sees only their
// project(s)" couldn't be tested until project_memberships existed):
// a caller with NO 'projects' permission grant still reaches their
// project(s) through this route, via the membership fallback — and a
// caller with neither a grant nor a membership row sees nothing, not an
// error that would hint at what exists.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ProjectWithTasks } from '@nexus/shared';

const LEADER_TOKEN = 'leader-token'; // blanket projects.* grant (role === 'leader')
const GUEST_TOKEN = 'guest-token'; // no grant, has a project_memberships row on PROJECT_A
const OUTSIDER_TOKEN = 'outsider-token'; // no grant, no membership anywhere

const LEADER = { sessionId: 's1', userId: 'user-leader', orgId: 'org-1', role: 'leader', name: 'Leader', email: 'leader@abion.test' };
const GUEST = { sessionId: 's2', userId: 'user-guest', orgId: 'org-1', role: 'guest', name: 'Guest', email: 'guest@abion.test' };
const OUTSIDER = { sessionId: 's3', userId: 'user-outsider', orgId: 'org-1', role: 'guest', name: 'Outsider', email: 'outsider@abion.test' };

vi.mock('../services/sessionService.js', () => ({
  verifySession: vi.fn(async (token: string) => {
    if (token === LEADER_TOKEN) return LEADER;
    if (token === GUEST_TOKEN) return GUEST;
    if (token === OUTSIDER_TOKEN) return OUTSIDER;
    return null;
  }),
}));

vi.mock('../plugins/rbac.js', async () => {
  const actual = await vi.importActual<typeof import('../plugins/rbac.js')>('../plugins/rbac.js');
  return {
    ...actual,
    // Only LEADER carries a blanket grant — matches 0016's "most
    // restrictive default" design for `guest`: no row, no bypass.
    hasPermission: vi.fn(async (user: { userId: string }) => user.userId === LEADER.userId),
  };
});

const PROJECT_A: ProjectWithTasks = {
  id: 'project-a',
  orgId: 'org-1',
  title: 'Q4 Partner Outreach',
  status: 'active',
  createdByUserId: LEADER.userId,
  createdAt: '2026-01-01T00:00:00.000Z',
  tasks: [],
  members: [],
  taskCount: 0,
  doneTaskCount: 0,
};

vi.mock('../services/projectService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/projectService.js')>('../services/projectService.js');
  return {
    ...actual,
    listProjectsWithTasks: vi.fn(async () => [PROJECT_A]),
    getProjectWithTasks: vi.fn(async (_orgId: string, id: string) => (id === PROJECT_A.id ? PROJECT_A : null)),
    // GUEST is on PROJECT_A via project_memberships; OUTSIDER is on nothing.
    listProjectsForMember: vi.fn(async (userId: string) => (userId === GUEST.userId ? [PROJECT_A] : [])),
    getProjectForMember: vi.fn(async (userId: string, id: string) =>
      userId === GUEST.userId && id === PROJECT_A.id ? PROJECT_A : null
    ),
    createProject: vi.fn(async (_orgId: string, input: { title: string }) => ({ ...PROJECT_A, title: input.title })),
  };
});

describe('Projects — ADMIN_BUILD_GUIDE.md §2 routes', () => {
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

  describe('GET / (list)', () => {
    it('401s with no session', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects' });
      expect(res.statusCode).toBe(401);
    });

    it('a caller with a blanket grant gets the full org list', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { cookie: `nexus_session=${LEADER_TOKEN}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json().projects).toEqual([PROJECT_A]);
    });

    it('a guest with no grant but a membership row falls back to their own project(s)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { cookie: `nexus_session=${GUEST_TOKEN}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json().projects).toEqual([PROJECT_A]);
    });

    it('a caller with neither a grant nor a membership row sees an empty list, not an error', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { cookie: `nexus_session=${OUTSIDER_TOKEN}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json().projects).toEqual([]);
    });
  });

  describe('GET /:id (detail)', () => {
    it('a guest on the project reaches it via the membership fallback', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${PROJECT_A.id}`,
        headers: { cookie: `nexus_session=${GUEST_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(PROJECT_A);
    });

    it('the guest sees only their project(s), nothing else — a different id 404s, not 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/some-other-project',
        headers: { cookie: `nexus_session=${GUEST_TOKEN}` },
      });
      // 404, not 403: this route deliberately doesn't distinguish
      // "doesn't exist" from "exists but you're not on it" — see the
      // route's own comment on why.
      expect(res.statusCode).toBe(404);
    });

    it('an outsider with no grant and no membership anywhere gets 404, never the project', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${PROJECT_A.id}`,
        headers: { cookie: `nexus_session=${OUTSIDER_TOKEN}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST / (create)', () => {
    it('403s for a caller without projects.create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: { cookie: `nexus_session=${GUEST_TOKEN}` },
        payload: { title: 'New project' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('400s with no title', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: { cookie: `nexus_session=${LEADER_TOKEN}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('201s for a caller with projects.create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: { cookie: `nexus_session=${LEADER_TOKEN}` },
        payload: { title: 'New project' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().title).toBe('New project');
    });
  });
});
