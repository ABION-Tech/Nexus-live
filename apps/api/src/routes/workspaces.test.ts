// Session 57 — one person, many companies: the HTTP contract. The
// isolation itself (RLS per company, membership check on switch, Join /
// Decline, cross-company task view) was also exercised end to end against
// live Postgres with two real companies in Session 57.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const ABION = '11111111-1111-4111-8111-111111111111';
const RESCUETAP = '22222222-2222-4222-8222-222222222222';
const STRANGER = '99999999-9999-4999-8999-999999999999';
const INVITE = '55555555-5555-4555-8555-555555555555';

const ME = { sessionId: 's1', userId: 'u-me', orgId: ABION, role: 'leader', name: 'Me', email: 'me@abion.test' };
const IMPERSONATED = { ...ME, sessionId: 's2', impersonatedBy: { impersonationId: 'i1', actorUserId: 'u-admin', actorName: 'Admin', mode: 'read_only', startedAt: 'x' } };

vi.mock('../services/sessionService.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/sessionService.js');
  return {
    ...actual,
    verifySession: vi.fn(async (t: string) => (t === 'me' ? ME : t === 'impersonating' ? IMPERSONATED : null)),
  };
});

vi.mock('../services/auditLogService.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/auditLogService.js');
  return { ...actual, logOrgActionSafely: vi.fn(async () => undefined) };
});

vi.mock('../services/workspaceService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/workspaceService.js')>('../services/workspaceService.js');
  const ws = (orgId: string, name: string, role: string, isHome: boolean, isCurrent: boolean) => ({ orgId, name, orgType: 'company', role, isHome, isCurrent });
  return {
    ...actual,
    listWorkspaces: vi.fn(async () => [ws(ABION, 'ABION Industries', 'leader', true, true), ws(RESCUETAP, 'RescueTap Ltd', 'team_member', false, false)]),
    listInvitations: vi.fn(async () => [{ id: INVITE, orgId: STRANGER, orgName: 'LAICOS Farms', role: 'leader', createdAt: 'x', expiresAt: 'y' }]),
    switchWorkspace: vi.fn(async ({ orgId }: { orgId: string }) => {
      if (orgId !== ABION && orgId !== RESCUETAP) throw new actual.WorkspaceError('not_member', "You aren't a member of that company.");
      return ws(orgId, 'RescueTap Ltd', 'team_member', false, true);
    }),
    setHomeWorkspace: vi.fn(async (_u: string, orgId: string) => {
      if (orgId === STRANGER) throw new actual.WorkspaceError('not_member', "You aren't a member of that company.");
    }),
    acceptInvitation: vi.fn(async (_u: string, id: string) => {
      if (id !== INVITE) throw new actual.WorkspaceError('not_found', 'That invitation is no longer open.');
      return ws(STRANGER, 'LAICOS Farms', 'leader', false, false);
    }),
    declineInvitation: vi.fn(async () => undefined),
    listMyWorkAcrossCompanies: vi.fn(async () => ({ companies: [], tasks: [] })),
  };
});

import {
  acceptInvitation,
  declineInvitation,
  listMyWorkAcrossCompanies,
  setHomeWorkspace,
  switchWorkspace,
} from '../services/workspaceService.js';

describe('Session 57 — one person, many companies', () => {
  let app: FastifyInstance;
  const me = { nexus_session: 'me' };
  const imp = { nexus_session: 'impersonating' };

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

  it('every route needs a signed-in session', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/me/workspaces'],
      ['POST', '/api/v1/me/workspaces/switch'],
      ['POST', '/api/v1/me/workspaces/home'],
      ['POST', `/api/v1/me/invitations/${INVITE}/accept`],
      ['POST', `/api/v1/me/invitations/${INVITE}/decline`],
      ['GET', '/api/v1/me/work'],
    ] as const) {
      expect((await app.inject({ method, url, payload: method === 'POST' ? {} : undefined })).statusCode, url).toBe(401);
    }
  });

  it('lists my companies and open invitations', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me/workspaces', cookies: me });
    expect(res.statusCode).toBe(200);
    expect(res.json().workspaces).toHaveLength(2);
    expect(res.json().invitations[0].orgName).toBe('LAICOS Farms');
  });

  it('switches only into a company I belong to, using my own session', async () => {
    const ok = await app.inject({ method: 'POST', url: '/api/v1/me/workspaces/switch', cookies: me, payload: { orgId: RESCUETAP } });
    expect(ok.statusCode).toBe(200);
    expect(switchWorkspace).toHaveBeenCalledWith({ sessionId: 's1', userId: 'u-me', orgId: RESCUETAP });

    const no = await app.inject({ method: 'POST', url: '/api/v1/me/workspaces/switch', cookies: me, payload: { orgId: STRANGER } });
    expect(no.statusCode).toBe(403);
    expect(no.json().error).toBe('not_member');

    const bad = await app.inject({ method: 'POST', url: '/api/v1/me/workspaces/switch', cookies: me, payload: { orgId: "x' or 1=1" } });
    expect(bad.statusCode).toBe(400);
  });

  it('sets the sign-in company only to one I belong to', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/me/workspaces/home', cookies: me, payload: { orgId: RESCUETAP } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/me/workspaces/home', cookies: me, payload: { orgId: STRANGER } })).statusCode).toBe(403);
    expect(setHomeWorkspace).toHaveBeenCalledWith('u-me', RESCUETAP);
  });

  it('join and decline act on my own invitations only', async () => {
    const join = await app.inject({ method: 'POST', url: `/api/v1/me/invitations/${INVITE}/accept`, cookies: me, payload: {} });
    expect(join.statusCode).toBe(200);
    expect(acceptInvitation).toHaveBeenCalledWith('u-me', INVITE);

    const gone = await app.inject({ method: 'POST', url: `/api/v1/me/invitations/${STRANGER}/accept`, cookies: me, payload: {} });
    expect(gone.statusCode).toBe(404);

    expect((await app.inject({ method: 'POST', url: `/api/v1/me/invitations/${INVITE}/decline`, cookies: me, payload: {} })).statusCode).toBe(200);
    expect(declineInvitation).toHaveBeenCalledWith('u-me', INVITE);
  });

  it("an admin viewing as someone can't make that person's choices", async () => {
    for (const url of ['/api/v1/me/workspaces/switch', '/api/v1/me/workspaces/home', `/api/v1/me/invitations/${INVITE}/accept`, `/api/v1/me/invitations/${INVITE}/decline`]) {
      const res = await app.inject({ method: 'POST', url, cookies: imp, payload: { orgId: RESCUETAP } });
      expect(res.statusCode, url).toBe(403);
    }
    expect(switchWorkspace).not.toHaveBeenCalled();
    expect(acceptInvitation).not.toHaveBeenCalled();
    expect(declineInvitation).not.toHaveBeenCalled();
  });

  it('my work across companies is mine, optionally narrowed to one company', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/v1/me/work?orgId=${RESCUETAP}&includeDone=true`, cookies: me })).statusCode).toBe(200);
    expect(listMyWorkAcrossCompanies).toHaveBeenCalledWith('u-me', { orgId: RESCUETAP, includeDone: true });
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/work?orgId=nope', cookies: me })).statusCode).toBe(400);
  });
});
