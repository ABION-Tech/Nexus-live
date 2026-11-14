// Session 58 — GET /overview (real Dashboard + sidebar counts) and
// GET /eod/history (Activity Log): who sees what.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const LEADER = { sessionId: 's1', userId: 'u-lead', orgId: 'o1', role: 'leader', name: 'Lead', email: 'l@x.test' };
const MEMBER = { sessionId: 's2', userId: 'u-mem', orgId: 'o1', role: 'team_member', name: 'Mem', email: 'm@x.test' };

vi.mock('../services/sessionService.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/sessionService.js');
  return { ...actual, verifySession: vi.fn(async (t: string) => (t === 'lead' ? LEADER : t === 'mem' ? MEMBER : null)) };
});
vi.mock('../plugins/rbac.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../plugins/rbac.js');
  return { ...actual, hasPermission: vi.fn(async (u: { role: string }) => u.role === 'leader') };
});
vi.mock('../services/overviewService.js', () => ({
  getOverview: vi.fn(async () => ({ today: '2026-11-14', counts: { activeTasks: 27 }, recentTasks: [] })),
}));
vi.mock('../services/eodService.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/eodService.js');
  return { ...actual, listEodLogsInRange: vi.fn(async () => []) };
});

import { getOverview } from '../services/overviewService.js';
import { listEodLogsInRange } from '../services/eodService.js';

describe('Session 58 — overview and EOD history', () => {
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

  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/overview' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/eod/history' })).statusCode).toBe(401);
  });

  it('a leader gets company-wide counts with missing EODs', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/overview?recent=20', cookies: { nexus_session: 'lead' } });
    expect(res.statusCode).toBe(200);
    expect(getOverview).toHaveBeenCalledWith('o1', { scopeUserId: undefined, includeEod: true, recent: 20 });
  });

  it("a member's counts cover only their own work", async () => {
    await app.inject({ method: 'GET', url: '/api/v1/overview', cookies: { nexus_session: 'mem' } });
    expect(getOverview).toHaveBeenCalledWith('o1', { scopeUserId: 'u-mem', includeEod: false, recent: 10 });
  });

  it('EOD history: leaders can pick anyone, members only ever get their own', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/eod/history?from=2026-11-01&to=2026-11-14&userId=u-x', cookies: { nexus_session: 'lead' } });
    expect(listEodLogsInRange).toHaveBeenLastCalledWith('o1', '2026-11-01', '2026-11-14', 'u-x');
    await app.inject({ method: 'GET', url: '/api/v1/eod/history?from=2026-11-01&to=2026-11-14&userId=u-x', cookies: { nexus_session: 'mem' } });
    expect(listEodLogsInRange).toHaveBeenLastCalledWith('o1', '2026-11-01', '2026-11-14', 'u-mem');
    expect((await app.inject({ method: 'GET', url: '/api/v1/eod/history?from=nope', cookies: { nexus_session: 'lead' } })).statusCode).toBe(400);
  });
});
