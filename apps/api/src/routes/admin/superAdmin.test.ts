// Session 40 continuation. routes/admin/superAdmin.ts's whole reason to
// exist is "isPlatformAdmin() gates every route before anything else
// runs" (this file's own header) — so the priority case here is proving
// that gate actually fires per-route, not just on the one route someone
// remembered to test. Same mocking posture as permissions.test.ts:
// sessionService + the services this route layer calls are mocked; this
// is the route/auth-gating layer under test, not a migration/integration
// test (0019-0021 are already confirmed live, per this session's scope).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const ADMIN_TOKEN = 'admin-token';
const MEMBER_TOKEN = 'member-token';

const ADMIN_USER = { sessionId: 's1', userId: 'user-admin', orgId: 'org-1', role: 'leader', name: 'Admin', email: 'admin@abion.test' };
const MEMBER_USER = { sessionId: 's2', userId: 'user-member', orgId: 'org-1', role: 'team_member', name: 'Member', email: 'member@abion.test' };

vi.mock('../../services/sessionService.js', () => ({
  verifySession: vi.fn(async (token: string) => {
    if (token === ADMIN_TOKEN) return ADMIN_USER;
    if (token === MEMBER_TOKEN) return MEMBER_USER;
    return null;
  }),
}));

vi.mock('../../services/authorizationService.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/authorizationService.js')>('../../services/authorizationService.js');
  return {
    ...actual, // keeps OrgAccessDeniedError real
    isPlatformAdmin: vi.fn(async (userId: string) => userId === ADMIN_USER.userId),
  };
});

const fakeOrg = {
  id: 'org-new',
  name: 'New Co',
  orgType: 'company' as const,
  plan: 'free' as const,
  active: true,
  createdAt: '2026-08-30T00:00:00.000Z',
};

vi.mock('../../services/organizationService.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/organizationService.js')>('../../services/organizationService.js');
  return {
    ...actual, // keeps OrganizationError real
    createOrganization: vi.fn(async () => fakeOrg),
    updateOrganization: vi.fn(async () => fakeOrg),
    deactivateOrganization: vi.fn(async () => ({ ...fakeOrg, active: false })),
    assignCompanyToGroup: vi.fn(async () => fakeOrg),
    listCompaniesInGroup: vi.fn(async () => [fakeOrg]),
  };
});

vi.mock('../../services/auditLogService.js', () => ({
  logPlatformActionSafely: vi.fn(async () => undefined),
  searchAuditLog: vi.fn(async () => [
    { id: 'audit-1', timestamp: '2026-08-30T00:00:00.000Z', action: 'organization.create', resourceType: 'organization', result: 'success' },
  ]),
}));

vi.mock('../../services/systemMetricsService.js', () => ({
  getSystemHealth: vi.fn(async () => ({
    overall: 'ok',
    subsystems: [{ name: 'database', status: 'ok', checkedAt: '2026-08-30T00:00:00.000Z' }],
  })),
}));

const fakeReviewQueue = [
  {
    orgId: 'org-overdue',
    orgName: 'Overdue Co',
    tier: 'pro',
    billingStatus: 'pending_review',
    gracePeriodEndsAt: '2026-08-20T00:00:00.000Z',
    reviewNote: null,
    updatedAt: '2026-08-21T00:00:00.000Z',
  },
];

const fakeResolvedReview = {
  id: 'billing-9',
  orgId: 'org-overdue',
  tier: 'free',
  billingStatus: 'active',
  seatCount: 3,
  cascadesToChildren: false,
  gracePeriodEndsAt: null,
  reviewNote: 'Manually downgraded',
  updatedAt: '2026-08-22T00:00:00.000Z',
};

vi.mock('../../services/billingService.js', () => ({
  listBillingPendingReview: vi.fn(async () => fakeReviewQueue),
  resolveBillingReviewEntry: vi.fn(async (orgId: string) => (orgId === 'org-missing' ? null : fakeResolvedReview)),
}));

vi.mock('../../db.js', () => ({
  pool: { query: vi.fn() },
  withOrgContext: vi.fn(),
}));

import { pool } from '../../db.js';

const poolQuery = pool.query as unknown as ReturnType<typeof vi.fn>;

describe('routes/admin/superAdmin — Super Admin gating (ADMIN_BUILD_GUIDE.md §3)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.COOKIE_SECRET = 'test-secret';
    poolQuery.mockReset();
    const { buildServer } = await import('../../server.js');
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('401s with no session at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/super/system-health' });
    expect(res.statusCode).toBe(401);
  });

  describe('403s a non-platform-admin session on every route (no silent pass-through)', () => {
    const cases: Array<{ method: 'GET' | 'POST' | 'PATCH'; url: string }> = [
      { method: 'POST', url: '/api/v1/admin/super/organizations' },
      { method: 'PATCH', url: '/api/v1/admin/super/organizations/some-id' },
      { method: 'POST', url: '/api/v1/admin/super/organizations/some-id/deactivate' },
      { method: 'GET', url: '/api/v1/admin/super/investigate/organizations' },
      { method: 'GET', url: '/api/v1/admin/super/analytics/overview' },
      { method: 'GET', url: '/api/v1/admin/super/system-health' },
      { method: 'GET', url: '/api/v1/admin/super/audit-log' },
      { method: 'GET', url: '/api/v1/admin/super/billing/review-queue' },
      { method: 'POST', url: '/api/v1/admin/super/billing/review-queue/some-org/resolve' },
    ];

    it.each(cases)('$method $url', async ({ method, url }) => {
      const res = await app.inject({ method, url, headers: { cookie: `nexus_session=${MEMBER_TOKEN}` } });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('happy paths (one per route group) for a real platform admin', () => {
    it('orgs CRUD: POST /organizations creates and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/super/organizations',
        headers: { cookie: `nexus_session=${ADMIN_TOKEN}` },
        payload: { name: 'New Co', orgType: 'company' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().id).toBe('org-new');
    });

    it('investigate: GET /investigate/organizations returns 200 with results', async () => {
      poolQuery.mockResolvedValueOnce({ rows: [{ id: 'org-new', name: 'New Co' }] });
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/super/investigate/organizations?q=New',
        headers: { cookie: `nexus_session=${ADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().organizations).toEqual([{ id: 'org-new', name: 'New Co' }]);
    });

    it('analytics: GET /analytics/overview merges the three counts into one 200', async () => {
      // 0022_platform_analytics_counts.sql: orgRows/userRows now come
      // from nexus_bootstrap-owned functions (platform_organization_counts,
      // platform_user_count), not a plain select — field names changed
      // accordingly (org_count / platform_user_count). platform_admins
      // is untouched (no RLS on that table, still a plain count(*)).
      poolQuery
        .mockResolvedValueOnce({ rows: [{ org_type: 'company', active: true, org_count: '3' }] }) // orgRows
        .mockResolvedValueOnce({ rows: [{ platform_user_count: '10' }] }) // userRows
        .mockResolvedValueOnce({ rows: [{ count: '1' }] }); // adminRows

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/super/analytics/overview',
        headers: { cookie: `nexus_session=${ADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ totalCompanies: 3, totalUsers: 10, totalPlatformAdmins: 1 });
    });

    it('health: GET /system-health returns the report as-is', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/super/system-health',
        headers: { cookie: `nexus_session=${ADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().overall).toBe('ok');
    });

    it('audit: GET /audit-log returns the entries under { entries }', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/super/audit-log',
        headers: { cookie: `nexus_session=${ADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().entries).toHaveLength(1);
    });
  });
});
