// Session 53 — route behaviour for role assignment, org invites and
// Super Admin management. Services are mocked; the guards that need a
// real database (last leader, last Super Admin, RLS) were exercised
// against live Postgres in Session 53 and are covered here only as
// "the route maps the service's error to the right status".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const LEADER = { sessionId: 's1', userId: 'u-leader', orgId: 'org-1', role: 'leader', name: 'Lead', email: 'lead@abion.test' };
const MEMBER = { sessionId: 's2', userId: 'u-member', orgId: 'org-1', role: 'team_member', name: 'Mem', email: 'mem@abion.test' };
const ADMIN = { sessionId: 's3', userId: 'u-admin', orgId: 'org-1', role: 'leader', name: 'Admin', email: 'admin@abion.test' };
const TOKENS: Record<string, typeof LEADER> = { leader: LEADER, member: MEMBER, admin: ADMIN };

vi.mock('../services/sessionService.js', () => ({
  verifySession: vi.fn(async (token: string) => TOKENS[token] ?? null),
}));

vi.mock('../services/authorizationService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/authorizationService.js')>('../services/authorizationService.js');
  return { ...actual, isPlatformAdmin: vi.fn(async (id: string) => id === ADMIN.userId) };
});

// requirePermission('users','create') calls hasPermission inside
// authorizationService (not mockable from outside), which a leader passes
// by role and anyone else passes via a `permissions` row. The db mock
// below answers that lookup with a row, i.e. the member holds an explicit
// users:create grant, so the leader-invite guard is what's under test.
const invite = {
  id: 'inv-1',
  orgId: 'org-1',
  email: 'new@abion.test',
  role: 'team_member',
  invitedBy: 'u-leader',
  createdAt: '2026-11-08T00:00:00.000Z',
  expiresAt: '2026-11-22T00:00:00.000Z',
  grantPlatformAdmin: false,
};

vi.mock('../services/inviteService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/inviteService.js')>('../services/inviteService.js');
  return {
    ...actual,
    createInvite: vi.fn(async (p: { orgId: string; email: string; role: string }) => ({ ...invite, ...p })),
    revokeInvite: vi.fn(async () => undefined),
    listPendingInvites: vi.fn(async () => [invite]),
  };
});

vi.mock('../services/teamAdminService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/teamAdminService.js')>('../services/teamAdminService.js');
  return {
    ...actual,
    changeMemberRole: vi.fn(async (p: { userId: string; role: string }) => {
      if (p.userId === 'u-last') throw new actual.TeamAdminError('last_leader', 'only leader');
      if (!actual.MEMBER_ROLES.includes(p.role as never)) throw new actual.TeamAdminError('invalid', 'bad role');
      return { userId: p.userId, role: p.role, previousRole: 'team_member' };
    }),
    listPlatformAdmins: vi.fn(async () => [{ userId: 'u-admin', name: 'Admin', email: 'admin@abion.test', grantedAt: '2026-11-01' }]),
    addPlatformAdmin: vi.fn(async (p: { email: string; homeOrgId?: string }) => {
      if (p.email === 'existing@abion.test') return { status: 'granted', admin: { userId: 'u-x', name: 'X', email: p.email, grantedAt: 'now' } };
      if (!p.homeOrgId) throw new actual.TeamAdminError('invalid', 'needs org');
      return { status: 'invited', invite: { ...invite, email: p.email, grantPlatformAdmin: true } };
    }),
    removePlatformAdmin: vi.fn(async (p: { actorUserId: string; userId: string }) => {
      if (p.actorUserId === p.userId) throw new actual.TeamAdminError('self', 'self');
    }),
  };
});

vi.mock('../services/peopleService.js', () => ({
  listOrgPeople: vi.fn(async () => [
    { id: 'u-leader', name: 'Lead', email: 'lead@abion.test', role: 'leader' },
    { id: 'u-guest', name: 'Guest', email: 'g@abion.test', role: 'guest' },
  ]),
}));

vi.mock('../services/billingService.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/billingService.js');
  return {
    ...actual,
    checkSeatLimit: vi.fn(async () => undefined),
    getBillingSummary: vi.fn(async () => ({ orgId: 'org-9', tier: 'free', billingStatus: 'active', seatLimit: 5 })),
    setOrgBillingTierManually: vi.fn(async (p: { orgId: string; tier: string }) => ({ orgId: p.orgId, tier: p.tier, billingStatus: 'active', seatLimit: null })),
  };
});

vi.mock('../services/emailService.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/emailService.js');
  return { ...actual, sendInviteEmail: vi.fn(async () => undefined), getUserDisplayName: vi.fn(async () => 'Lead') };
});

vi.mock('../services/auditLogService.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/auditLogService.js');
  return { ...actual, logPlatformActionSafely: vi.fn(async () => undefined) };
});

vi.mock('../db.js', () => ({
  pool: { query: vi.fn(async () => ({ rows: [] })) },
  withOrgContext: vi.fn(async (_orgId: string, fn: (c: unknown) => unknown) => fn({ query: vi.fn(async () => ({ rows: [{ granted: 1 }] })) })),
}));

import { changeMemberRole, addPlatformAdmin } from '../services/teamAdminService.js';
import { createInvite } from '../services/inviteService.js';
import { setOrgBillingTierManually } from '../services/billingService.js';

const as = (who: string) => ({ cookie: `nexus_session=${who}` });

describe('Session 53 — roles, invites, Super Admins', () => {
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

  describe('PATCH /people/:userId/role', () => {
    const url = '/api/v1/people/u-member/role';

    it('401s without a session', async () => {
      expect((await app.inject({ method: 'PATCH', url, payload: { role: 'leader' } })).statusCode).toBe(401);
    });

    it('403s a non-leader, even one who could be granted other user permissions', async () => {
      const res = await app.inject({ method: 'PATCH', url, headers: as('member'), payload: { role: 'leader' } });
      expect(res.statusCode).toBe(403);
      expect(changeMemberRole).not.toHaveBeenCalled();
    });

    it('lets a leader change a role, scoped to their own org', async () => {
      const res = await app.inject({ method: 'PATCH', url, headers: as('leader'), payload: { role: 'intern' } });
      expect(res.statusCode).toBe(200);
      expect(changeMemberRole).toHaveBeenCalledWith({ orgId: 'org-1', userId: 'u-member', role: 'intern' });
    });

    it('400s an unknown role and 409s demoting the last leader', async () => {
      expect((await app.inject({ method: 'PATCH', url, headers: as('leader'), payload: { role: 'owner' } })).statusCode).toBe(400);
      const res = await app.inject({ method: 'PATCH', url: '/api/v1/people/u-last/role', headers: as('leader'), payload: { role: 'intern' } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('last_leader');
    });
  });

  describe('/invites', () => {
    it('GET lists pending invites for a leader', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/invites', headers: as('leader') });
      expect(res.statusCode).toBe(200);
      expect(res.json().invites).toHaveLength(1);
    });

    it('a non-leader with users:create cannot invite a leader (privilege escalation guard)', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/invites', headers: as('member'), payload: { email: 'x@abion.test', role: 'leader' } });
      expect(res.statusCode).toBe(403);
      expect(createInvite).not.toHaveBeenCalled();
    });

    it('a non-leader with users:create can still invite a team member', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/invites', headers: as('member'), payload: { email: 'x@abion.test', role: 'team_member' } });
      expect(res.statusCode).toBe(201);
    });
  });

  describe('Super Admin org people', () => {
    it("lists another org's members (guests left out) and pending invites", async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/super/organizations/org-9/members', headers: as('admin') });
      expect(res.statusCode).toBe(200);
      expect(res.json().people.map((p: { id: string }) => p.id)).toEqual(['u-leader']);
      expect(res.json().invites).toHaveLength(1);
    });

    it("invites into the target org, not the Super Admin's own", async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/super/organizations/org-9/invites',
        headers: as('admin'),
        payload: { email: 'ceo@newco.test', role: 'leader' },
      });
      expect(res.statusCode).toBe(201);
      expect(createInvite).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-9', email: 'ceo@newco.test', role: 'leader', invitedBy: 'u-admin' }));
    });

    it('400s a bad email or role', async () => {
      expect((await app.inject({ method: 'POST', url: '/api/v1/admin/super/organizations/org-9/invites', headers: as('admin'), payload: { email: 'nope', role: 'leader' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/v1/admin/super/organizations/org-9/invites', headers: as('admin'), payload: { email: 'a@b.co', role: 'guest' } })).statusCode).toBe(400);
    });

    it("changes a member's role in the target org", async () => {
      const res = await app.inject({ method: 'PATCH', url: '/api/v1/admin/super/organizations/org-9/members/u-member/role', headers: as('admin'), payload: { role: 'leader' } });
      expect(res.statusCode).toBe(200);
      expect(changeMemberRole).toHaveBeenCalledWith({ orgId: 'org-9', userId: 'u-member', role: 'leader' });
    });
  });

  describe('Super Admin sets a plan by hand', () => {
    it('400s an unknown tier and never writes', async () => {
      const res = await app.inject({ method: 'PATCH', url: '/api/v1/admin/super/organizations/org-9/billing', headers: as('admin'), payload: { tier: 'enterprise' } });
      expect(res.statusCode).toBe(400);
      expect(setOrgBillingTierManually).not.toHaveBeenCalled();
    });

    it('sets the tier on the target org', async () => {
      const res = await app.inject({ method: 'PATCH', url: '/api/v1/admin/super/organizations/org-9/billing', headers: as('admin'), payload: { tier: 'pro' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().tier).toBe('pro');
      expect(setOrgBillingTierManually).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-9', tier: 'pro', actorUserId: 'u-admin' }));
    });

    it('403s a non-Super Admin leader', async () => {
      expect((await app.inject({ method: 'PATCH', url: '/api/v1/admin/super/organizations/org-9/billing', headers: as('leader'), payload: { tier: 'pro' } })).statusCode).toBe(403);
    });
  });

  describe('Super Admins', () => {
    it('lists them', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/super/platform-admins', headers: as('admin') });
      expect(res.statusCode).toBe(200);
      expect(res.json().admins).toHaveLength(1);
    });

    it('grants an existing account (200) and invites a new one into a chosen org (201)', async () => {
      const a = await app.inject({ method: 'POST', url: '/api/v1/admin/super/platform-admins', headers: as('admin'), payload: { email: 'existing@abion.test' } });
      expect(a.statusCode).toBe(200);
      expect(a.json().status).toBe('granted');
      const b = await app.inject({ method: 'POST', url: '/api/v1/admin/super/platform-admins', headers: as('admin'), payload: { email: 'new@abion.test', homeOrgId: 'org-1' } });
      expect(b.statusCode).toBe(201);
      expect(b.json().status).toBe('invited');
      expect(addPlatformAdmin).toHaveBeenLastCalledWith(expect.objectContaining({ email: 'new@abion.test', homeOrgId: 'org-1', actorUserId: 'u-admin' }));
    });

    it('400s a new address with no org chosen, and 403s removing yourself', async () => {
      expect((await app.inject({ method: 'POST', url: '/api/v1/admin/super/platform-admins', headers: as('admin'), payload: { email: 'new@abion.test' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/super/platform-admins/u-admin', headers: as('admin') })).statusCode).toBe(403);
    });

    it('204s removing someone else', async () => {
      expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/super/platform-admins/u-other', headers: as('admin') })).statusCode).toBe(204);
    });
  });
});
