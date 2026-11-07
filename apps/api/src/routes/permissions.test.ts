// PRD §13.3 permissions route tests. Same strategy as automation.test.ts/
// files.test.ts: mock sessionService, rbac's hasPermission, and
// permissionService entirely — this is the route/RBAC/validation layer,
// not a migration/integration test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Permission } from '@nexus/shared';

const GRANTED_TOKEN = 'granted-token'; // full permissions.* access
const READONLY_TOKEN = 'readonly-token'; // read only
const UNGRANTED_TOKEN = 'ungranted-token'; // no permissions.* grants at all

const GRANTED = { sessionId: 's1', userId: 'user-granted', orgId: 'org-1', role: 'member', name: 'Granted', email: 'granted@abion.test' };
const READONLY = { sessionId: 's2', userId: 'user-readonly', orgId: 'org-1', role: 'member', name: 'ReadOnly', email: 'readonly@abion.test' };
const UNGRANTED = { sessionId: 's3', userId: 'user-ungranted', orgId: 'org-1', role: 'member', name: 'Ungranted', email: 'ungranted@abion.test' };

vi.mock('../services/sessionService.js', () => ({
  verifySession: vi.fn(async (token: string) => {
    if (token === GRANTED_TOKEN) return GRANTED;
    if (token === READONLY_TOKEN) return READONLY;
    if (token === UNGRANTED_TOKEN) return UNGRANTED;
    return null;
  }),
}));

vi.mock('../plugins/rbac.js', async () => {
  const actual = await vi.importActual<typeof import('../plugins/rbac.js')>('../plugins/rbac.js');
  return {
    ...actual,
    hasPermission: vi.fn(async (user: { userId: string }, resource: string, action: string) => {
      if (resource !== 'permissions') return false;
      if (user.userId === GRANTED.userId) return true; // read + create + delete
      if (user.userId === READONLY.userId) return action === 'read';
      return false;
    }),
  };
});

const basePermission: Permission = {
  id: 'perm-1',
  userId: 'user-target',
  orgId: 'org-1',
  resource: 'tasks',
  action: 'read',
  grantedByUserId: GRANTED.userId,
  grantedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../services/permissionService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/permissionService.js')>('../services/permissionService.js');
  return {
    ...actual, // keeps UserNotInOrgError real
    listPermissionsForUser: vi.fn(async (_orgId: string, userId: string) =>
      userId === 'user-target' ? [basePermission] : []
    ),
    grantPermission: vi.fn(async (_orgId: string, _grantedBy: string, targetUserId: string, resource: string, action: string) => {
      if (targetUserId === 'user-not-in-org') throw new actual.UserNotInOrgError(targetUserId);
      return { ...basePermission, userId: targetUserId, resource, action, grantedAt: '2026-01-02T00:00:00.000Z' };
    }),
    revokePermission: vi.fn(async (_orgId: string, id: string) => id === basePermission.id),
  };
});

describe('Permissions — PRD §13.3 routes', () => {
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

  describe('GET /?userId= (list grants)', () => {
    it('401s with no session', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/permissions?userId=user-target' });
      expect(res.statusCode).toBe(401);
    });

    it('403s without permissions.read', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/permissions?userId=user-target',
        headers: { cookie: `nexus_session=${UNGRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('400s with no userId query param', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/permissions', headers: { cookie: `nexus_session=${GRANTED_TOKEN}` } });
      expect(res.statusCode).toBe(400);
    });

    it('200s with the grants for that user, for a caller with read', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/permissions?userId=user-target',
        headers: { cookie: `nexus_session=${READONLY_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ permissions: [basePermission] });
    });

    it('200s with an empty array for a user with no grants', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/permissions?userId=user-other',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
      });
      expect(res.json()).toEqual({ permissions: [] });
    });
  });

  describe('POST / (grant)', () => {
    it('403s without permissions.create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/permissions',
        headers: { cookie: `nexus_session=${READONLY_TOKEN}` },
        payload: { userId: 'user-target', resource: 'tasks', action: 'read' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('400s on a resource/action pair this app does not gate', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/permissions',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
        payload: { userId: 'user-target', resource: 'not_a_real_resource', action: 'read' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('404s when the target user has no org_memberships row', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/permissions',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
        payload: { userId: 'user-not-in-org', resource: 'tasks', action: 'read' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('201s with the created grant', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/permissions',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
        payload: { userId: 'user-target', resource: 'tasks', action: 'read' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().resource).toBe('tasks');
    });

    // Session 7 — ai_cross_reference is its own resource in
    // PERMISSION_RESOURCE_ACTIONS (@nexus/shared), read-only, so it
    // needs to actually be grantable through this same generic route —
    // no special-cased endpoint for it, same as every other resource.
    it('201s a grant of ai_cross_reference.read (Session 7)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/permissions',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
        payload: { userId: 'user-target', resource: 'ai_cross_reference', action: 'read' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().resource).toBe('ai_cross_reference');
    });

    it('400s ai_cross_reference with an action other than read (only read is defined for it)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/permissions',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
        payload: { userId: 'user-target', resource: 'ai_cross_reference', action: 'create' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /:id (revoke)', () => {
    it('403s without permissions.delete', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/permissions/${basePermission.id}`,
        headers: { cookie: `nexus_session=${READONLY_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('204s on a real grant', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/permissions/${basePermission.id}`,
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(204);
    });

    it('404s on an id that does not exist', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/permissions/does-not-exist',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
