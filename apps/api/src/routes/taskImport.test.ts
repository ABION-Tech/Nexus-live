// Session 59 — POST /integrations/tasks/import: key + scope + membership.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const READ_ONLY = 'nxk_' + 'r'.repeat(43);
const IMPORTER = 'nxk_' + 'i'.repeat(43);

vi.mock('../services/personalKeyService.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/personalKeyService.js');
  return {
    ...actual,
    verifyKey: vi.fn(async (raw: string) =>
      raw === READ_ONLY ? { keyId: 'k1', userId: 'u1', orgId: 'o1', scopes: ['tasks:read'] } : raw === IMPORTER ? { keyId: 'k2', userId: 'u1', orgId: 'o1', scopes: ['tasks:read', 'tasks:import'] } : null
    ),
  };
});
vi.mock('../services/taskImportService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/taskImportService.js')>('../services/taskImportService.js');
  return {
    ...actual,
    findMyCompany: vi.fn(async (_u: string, name: string) => {
      if (name !== 'RescueTap') throw new actual.TaskImportError('not_member', 'nope');
      return { orgId: 'o2', name: 'RescueTap' };
    }),
    importTasks: vi.fn(async (_u: string, _o: string, tasks: { externalRef: string }[]) => tasks.map((t, i) => ({ externalRef: t.externalRef, id: `t${i}`, outcome: 'created' }))),
  };
});

import { importTasks } from '../services/taskImportService.js';

describe('Session 59 — task import', () => {
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
  const post = (key: string | null, payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/v1/integrations/tasks/import', headers: key ? { authorization: `Bearer ${key}` } : {}, payload: payload as object });

  it('needs a key with the import scope', async () => {
    expect((await post(null, { company: 'RescueTap', tasks: [{ externalRef: 'a', title: 'x' }] })).statusCode).toBe(401);
    expect((await post(READ_ONLY, { company: 'RescueTap', tasks: [{ externalRef: 'a', title: 'x' }] })).statusCode).toBe(403);
    expect(importTasks).not.toHaveBeenCalled();
  });

  it('imports only into a company you belong to', async () => {
    const no = await post(IMPORTER, { company: 'Someone Else Ltd', tasks: [{ externalRef: 'a', title: 'x' }] });
    expect(no.statusCode).toBe(403);
    const ok = await post(IMPORTER, { company: 'RescueTap', tasks: [{ externalRef: 'a', title: 'x' }, { externalRef: 'b', title: 'y' }] });
    expect(ok.statusCode).toBe(200);
    expect(importTasks).toHaveBeenCalledWith('u1', 'o2', expect.any(Array));
    expect(ok.json().results.map((r: { externalRef: string }) => r.externalRef)).toEqual(['a', 'b']);
  });

  it('rejects an empty or oversized batch', async () => {
    expect((await post(IMPORTER, { company: 'RescueTap', tasks: [] })).statusCode).toBe(400);
    expect((await post(IMPORTER, { company: 'RescueTap', tasks: Array.from({ length: 201 }, (_, i) => ({ externalRef: `${i}`, title: 't' })) })).statusCode).toBe(400);
  });
});
