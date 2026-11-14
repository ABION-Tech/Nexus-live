// Session 56 — personal API keys: the HTTP contract. Hashing, the
// org-membership check and revocation were also exercised against live
// Postgres in Session 56; these pin down who can call what.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const ME = { sessionId: 's1', userId: 'u-me', orgId: 'o1', role: 'team_member', name: 'Me', email: 'me@abion.test' };
const GOOD_KEY = 'nxk_' + 'a'.repeat(43);

vi.mock('../services/sessionService.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/sessionService.js');
  return { ...actual, verifySession: vi.fn(async (t: string) => (t === 'good-session' ? ME : null)) };
});

vi.mock('../services/personalKeyService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/personalKeyService.js')>('../services/personalKeyService.js');
  return {
    ...actual,
    listKeys: vi.fn(async () => [{ id: 'k1', name: 'Synergia', prefix: 'nxk_aaaaaaaa', scopes: ['tasks:read'], createdAt: 'x', lastUsedAt: null }]),
    createKey: vi.fn(async (_u: string, _o: string, name: unknown) => {
      if (!name) throw new actual.PersonalKeyError('bad_name', 'Give the key a name.');
      return { key: { id: 'k2', name, prefix: 'nxk_bbbbbbbb', scopes: ['tasks:read'], createdAt: 'x', lastUsedAt: null }, secret: GOOD_KEY };
    }),
    revokeKey: vi.fn(async (_u: string, id: string) => id === 'k1'),
    verifyKey: vi.fn(async (raw: string) => (raw === GOOD_KEY ? { keyId: 'k1', userId: ME.userId, orgId: ME.orgId, scopes: ['tasks:read'] } : null)),
  };
});

vi.mock('../services/taskService.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/taskService.js');
  const t = (id: string, status: string, assigned?: string, support?: string) => ({
    id, orgId: 'o1', title: `Task ${id}`, status, priority: 'high', assignedToUserId: assigned, supportUserId: support,
    createdAt: 'x', updatedAt: 'y',
  });
  return {
    ...actual,
    listTasks: vi.fn(async (org: string, q: { involvingUserId?: string }) => {
      const mine = q.involvingUserId === ME.userId;
      const tasks = !mine ? [] : org === 'o1'
        ? [t('t1', 'in_progress', ME.userId), t('t2', 'done', ME.userId), t('t3', 'not_started', 'someone', ME.userId)]
        : [t('r1', 'not_started', ME.userId)];
      return { tasks, total: tasks.length, page: 1, pageSize: 100 };
    }),
  };
});

vi.mock('../db.js', () => ({
  // Session 57: the person belongs to two companies.
  pool: {
    query: vi.fn(async (sql: string) =>
      /my_workspaces/.test(sql)
        ? { rows: [
            { org_id: 'o1', name: 'ABION Industries', org_type: 'company', parent_name: null, role: 'team_member', is_home: true, active: true },
            { org_id: 'o2', name: 'RescueTap', org_type: 'company', parent_name: null, role: 'leader', is_home: false, active: true },
          ] }
        : { rows: [] }
    ),
  },
  withOrgContext: vi.fn(async (_org: string, fn: (c: unknown) => unknown) => fn({ query: async () => ({ rows: [{ name: 'ABION Industries' }] }) })),
}));

import { createKey, revokeKey } from '../services/personalKeyService.js';
import { listTasks } from '../services/taskService.js';

describe('Session 56 — personal API keys', () => {
  let app: FastifyInstance;
  const cookie = { nexus_session: 'good-session' };

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

  it('key management needs a signed-in session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/keys' })).statusCode).toBe(401);
    // a personal key is not a session: it cannot list, create or revoke keys
    const withKey = { authorization: `Bearer ${GOOD_KEY}` };
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/keys', headers: withKey })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/me/keys', headers: withKey, payload: { name: 'x' } })).statusCode).toBe(401);
    expect(createKey).not.toHaveBeenCalled();
  });

  it('lists keys without ever returning a secret', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me/keys', cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain('secret');
  });

  it('creates a key for the signed-in person and returns the secret once', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/me/keys', cookies: cookie, payload: { name: 'Synergia' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().secret).toBe(GOOD_KEY);
    expect(createKey).toHaveBeenCalledWith(ME.userId, ME.orgId, 'Synergia');
    const bad = await app.inject({ method: 'POST', url: '/api/v1/me/keys', cookies: cookie, payload: {} });
    expect(bad.statusCode).toBe(400);
  });

  it('revokes only your own key', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/keys/k1', cookies: cookie })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/keys/someone-elses', cookies: cookie })).statusCode).toBe(404);
    expect(revokeKey).toHaveBeenCalledWith(ME.userId, 'k1');
  });

  it('the task feed needs a valid key; a session cookie is not enough', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/integrations/my-tasks' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/integrations/my-tasks', cookies: cookie })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/integrations/my-tasks', headers: { authorization: 'Bearer nxk_wrong' } })).statusCode).toBe(401);
  });

  it("returns the key owner's open tasks in every company, tagged with the company", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/integrations/my-tasks', headers: { authorization: `Bearer ${GOOD_KEY}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(listTasks).toHaveBeenCalledWith(ME.orgId, expect.objectContaining({ involvingUserId: ME.userId }));
    expect(body.organization.name).toBe('ABION Industries');
    expect(listTasks).toHaveBeenCalledWith('o2', expect.objectContaining({ involvingUserId: ME.userId }));
    expect(body.tasks.map((t: { id: string }) => t.id).sort()).toEqual(['r1', 't1', 't3']); // done task left out
    expect(body.tasks.find((t: { id: string }) => t.id === 't3').role).toBe('support');
    expect(body.tasks.find((t: { id: string }) => t.id === 'r1').organization).toEqual({ id: 'o2', name: 'RescueTap' });
    expect(body.companies.map((c: { name: string }) => c.name)).toEqual(['ABION Industries', 'RescueTap']);
    const all = await app.inject({ method: 'GET', url: '/api/v1/integrations/my-tasks?includeDone=true', headers: { authorization: `Bearer ${GOOD_KEY}` } });
    expect(all.json().tasks).toHaveLength(4);
  });

  it('a key cannot reach the rest of the API', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: { authorization: `Bearer ${GOOD_KEY}` } });
    expect(res.statusCode).toBe(401);
  });
});
