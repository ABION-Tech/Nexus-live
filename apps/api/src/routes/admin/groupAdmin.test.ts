// Session 41 continuation. Same mocking posture as superAdmin.test.ts:
// sessionService + the services this route layer calls are mocked; this
// is the route/auth-gating layer under test (isGroupAdmin's own logic is
// already covered directly in authorizationService.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const GROUP_LEADER_TOKEN = 'group-leader-token';
const COMPANY_LEADER_TOKEN = 'company-leader-token'; // leader, but not of a group — should still 403
const MEMBER_TOKEN = 'member-token'; // team_member inside a group org — should still 403

const GROUP_LEADER = { sessionId: 's1', userId: 'user-leader', orgId: 'group-A', role: 'leader', name: 'Group Leader', email: 'leader@abion.test' };
const COMPANY_LEADER = { sessionId: 's2', userId: 'user-company-leader', orgId: 'company-solo', role: 'leader', name: 'Company Leader', email: 'company@abion.test' };
const MEMBER = { sessionId: 's3', userId: 'user-member', orgId: 'group-A', role: 'team_member', name: 'Member', email: 'member@abion.test' };

vi.mock('../../services/sessionService.js', () => ({
  verifySession: vi.fn(async (token: string) => {
    if (token === GROUP_LEADER_TOKEN) return GROUP_LEADER;
    if (token === COMPANY_LEADER_TOKEN) return COMPANY_LEADER;
    if (token === MEMBER_TOKEN) return MEMBER;
    return null;
  }),
}));

vi.mock('../../services/authorizationService.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/authorizationService.js')>('../../services/authorizationService.js');
  return {
    ...actual, // keeps withAuthorizedOrgContext/OrgAccessDeniedError real
    isGroupAdmin: vi.fn(async (user: { userId: string }) => user.userId === GROUP_LEADER.userId),
  };
});

const childCompanies = [
  { id: 'company-1', name: 'Child One', orgType: 'company' as const, plan: 'free' as const, active: true, createdAt: '2026-08-30T00:00:00.000Z' },
  { id: 'company-2', name: 'Child Two', orgType: 'company' as const, plan: 'paid' as const, active: false, createdAt: '2026-08-30T00:00:00.000Z' },
];

vi.mock('../../services/organizationService.js', () => ({
  listCompaniesInGroup: vi.fn(async () => childCompanies),
}));

// Session 42 — /activity route added to close the dashboard-UI-pass gap
// (guide's Session 6 shell names an Activity tab; only Companies +
// Analytics shipped in Session 41). searchAuditLog itself already has
// its own coverage (auditLogService.test.ts); this only needs to prove
// the route passes the group's own orgId through and gates correctly.
const auditEntries = [
  { id: 'audit-1', timestamp: '2026-08-30T00:00:00.000Z', orgId: 'group-A', action: 'organization.update', resourceType: 'organization', result: 'success' as const },
];
vi.mock('../../services/auditLogService.js', () => ({
  searchAuditLog: vi.fn(async () => auditEntries),
}));

// db.js is NOT fully replaced with stub logic here — withAuthorizedOrgContext
// is left real (see the authorizationService mock above), so its
// canReadOrg() call underneath genuinely runs against these pool.query
// responses per company, the same real-primitive-reuse point this
// session's route file's own header comment makes.
const fakeClient = { query: vi.fn() };

vi.mock('../../db.js', () => ({
  pool: { query: vi.fn() },
  withOrgContext: vi.fn(async (_orgId: string, fn: (client: unknown) => unknown) => fn(fakeClient)),
}));

import { pool } from '../../db.js';

const poolQuery = pool.query as unknown as ReturnType<typeof vi.fn>;

describe('routes/admin/groupAdmin — Group Admin gating (ADMIN_BUILD_GUIDE.md §3 "Session 6")', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.COOKIE_SECRET = 'test-secret';

    fakeClient.query.mockReset();
    fakeClient.query.mockResolvedValue({ rows: [{ count: '2' }] }); // per-company org_memberships count

    poolQuery.mockReset();
    // canReadOrg's own sequence, per company, for withAuthorizedOrgContext
    // underneath the analytics route: not a platform admin, caller's own
    // org (group-A) is a group, and every child's parent_org_id is group-A.
    poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('platform_admins')) return { rows: [] };
      if (sql.includes('select org_type from search_organizations')) return { rows: [{ org_type: 'group' }] };
      if (sql.includes('select parent_org_id from search_organizations')) return { rows: [{ parent_org_id: 'group-A' }] };
      return { rows: [] };
    });

    const { buildServer } = await import('../../server.js');
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('401s with no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/group/companies' });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    { url: '/api/v1/admin/group/companies' },
    { url: '/api/v1/admin/group/analytics/overview' },
    { url: '/api/v1/admin/group/activity' },
  ])('403s a company leader (leader, but not of a group) on $url', async ({ url }) => {
    const res = await app.inject({ method: 'GET', url, headers: { cookie: `nexus_session=${COMPANY_LEADER_TOKEN}` } });
    expect(res.statusCode).toBe(403);
  });

  it.each([
    { url: '/api/v1/admin/group/companies' },
    { url: '/api/v1/admin/group/analytics/overview' },
    { url: '/api/v1/admin/group/activity' },
  ])('403s a team_member inside a group org (role alone is not enough) on $url', async ({ url }) => {
    const res = await app.inject({ method: 'GET', url, headers: { cookie: `nexus_session=${MEMBER_TOKEN}` } });
    expect(res.statusCode).toBe(403);
  });

  it('GET /companies returns this group\'s children for its own leader', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/group/companies',
      headers: { cookie: `nexus_session=${GROUP_LEADER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().companies).toHaveLength(2);
  });

  it('GET /analytics/overview merges per-company counts into one summary scoped to this group', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/group/analytics/overview',
      headers: { cookie: `nexus_session=${GROUP_LEADER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      groupOrgId: 'group-A',
      totalCompanies: 2,
      activeCompanies: 1, // only company-1 is active
      totalUsers: 4, // 2 companies x 2 (mocked per-company count) each
    });
  });

  it('GET /activity returns this group\'s own audit log entries, scoped to its own orgId', async () => {
    const { searchAuditLog } = await import('../../services/auditLogService.js');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/group/activity',
      headers: { cookie: `nexus_session=${GROUP_LEADER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toHaveLength(1);
    expect(searchAuditLog).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'group-A' }));
  });
});
