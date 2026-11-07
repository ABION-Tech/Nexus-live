// Session 41 continuation (ADMIN_BUILD_GUIDE.md §3 "Session 6", Company
// Admin backend half). Same mocking posture as groupAdmin.test.ts and
// superAdmin.test.ts: sessionService + the services this route layer calls
// are mocked; this is the route/auth-gating layer under test.
//
// Key cases:
//   - 401 with no session
//   - 403 for non-company leaders (group leaders, team members)
//   - 200 + correct response shape for the company leader on each route
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const COMPANY_LEADER_TOKEN = 'company-leader-token';
const GROUP_LEADER_TOKEN = 'group-leader-token'; // leader, but of a group — should 403
const MEMBER_TOKEN = 'member-token';             // team_member — should 403

const COMPANY_LEADER = {
  sessionId: 's1',
  userId: 'user-company-leader',
  orgId: 'company-A',
  role: 'leader',
  name: 'Company Leader',
  email: 'leader@abion.test',
};
const GROUP_LEADER = {
  sessionId: 's2',
  userId: 'user-group-leader',
  orgId: 'group-X',
  role: 'leader',
  name: 'Group Leader',
  email: 'glead@abion.test',
};
const MEMBER = {
  sessionId: 's3',
  userId: 'user-member',
  orgId: 'company-A',
  role: 'team_member',
  name: 'Member',
  email: 'member@abion.test',
};

vi.mock('../../services/sessionService.js', () => ({
  verifySession: vi.fn(async (token: string) => {
    if (token === COMPANY_LEADER_TOKEN) return COMPANY_LEADER;
    if (token === GROUP_LEADER_TOKEN) return GROUP_LEADER;
    if (token === MEMBER_TOKEN) return MEMBER;
    return null;
  }),
}));

vi.mock('../../services/authorizationService.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/authorizationService.js')>(
    '../../services/authorizationService.js'
  );
  return {
    ...actual, // keeps OrgAccessDeniedError real
    isCompanyAdmin: vi.fn(async (user: { userId: string }) => user.userId === COMPANY_LEADER.userId),
  };
});

// ---- Service mocks -------------------------------------------------------

const fakeTrends = [
  { date: '2026-08-01', openTasks: 5, doneToday: 2, overdue: 1, atRisk: 0 },
];
const fakeBlocked = [
  { id: 't1', orgId: 'company-A', title: 'Blocked task', status: 'blocked' as const },
];
const fakeDeadlines = [
  { id: 't2', orgId: 'company-A', title: 'Due soon', status: 'in_progress' as const },
  { id: 't3', orgId: 'company-A', title: 'Overdue', status: 'not_started' as const },
];

vi.mock('../../services/analyticsService.js', () => ({
  getTaskTrends: vi.fn(async () => fakeTrends),
  getBlockedTasks: vi.fn(async () => fakeBlocked),
  getUpcomingDeadlines: vi.fn(async () => fakeDeadlines),
}));

const fakeControls = [
  { key: 'ai_goals_enabled', enabled: true },
  { key: 'ai_eod_enabled', enabled: false },
];

vi.mock('../../services/automationService.js', () => ({
  listAutomationControls: vi.fn(async () => fakeControls),
}));

const fakeAuditEntries = [
  {
    id: 'audit-1',
    timestamp: '2026-08-30T00:00:00.000Z',
    userId: COMPANY_LEADER.userId,
    orgId: 'company-A',
    action: 'goal.create',
    resourceType: 'goal',
    result: 'success' as const,
  },
];

vi.mock('../../services/auditLogService.js', () => ({
  searchAuditLog: vi.fn(async () => fakeAuditEntries),
}));

// ---- DB mock for the /overview route's direct withOrgContext queries ----
// withOrgContext is mocked to immediately call fn() with a fakeClient,
// avoiding any real Postgres connection. The fakeClient returns fixture
// rows that match exactly what the overview handler expects.
const fakeClient = { query: vi.fn() };

vi.mock('../../db.js', () => ({
  pool: { query: vi.fn() },
  withOrgContext: vi.fn(async (_orgId: string, fn: (client: unknown) => unknown) => fn(fakeClient)),
}));

// ---- Test suite ----------------------------------------------------------

describe('routes/admin/companyAdmin — Company Admin gating (ADMIN_BUILD_GUIDE.md §3 "Session 6")', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.COOKIE_SECRET = 'test-secret';

    fakeClient.query.mockReset();
    // Overview calls six queries in sequence via Promise.all; return
    // fixture rows in the order the handler issues them:
    //   1. org_memberships count      → 3 people
    //   2. tasks by status            → open=4 (2 not_started + 2 in_progress), blocked=1, done=3
    //   3. goals count                → 2 active
    //   4. knowledge_entries count    → 5
    //   5. storage usage sum (0023, getOrgStorageUsage's own withOrgContext call) → 12,345 bytes used
    //   6. storage quota select (0023, getOrgStorageQuota's own withOrgContext call) → no per-org
    //      override set, so the handler should fall back to the env default
    fakeClient.query
      .mockResolvedValueOnce({ rows: [{ count: '3' }] })                         // people
      .mockResolvedValueOnce({                                                    // tasks
        rows: [
          { status: 'not_started', count: '2' },
          { status: 'in_progress', count: '2' },
          { status: 'blocked', count: '1' },
          { status: 'done', count: '3' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })                         // goals
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })                         // knowledge
      .mockResolvedValueOnce({ rows: [{ total: '12345' }] })                     // storage usage
      .mockResolvedValueOnce({ rows: [{ storage_quota_bytes: null }] });         // storage quota (unset → env default)

    const { buildServer } = await import('../../server.js');
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  // ---- Auth gating -------------------------------------------------------

  it('401s with no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/company/overview' });
    expect(res.statusCode).toBe(401);
  });

  const ALL_ROUTES = [
    '/api/v1/admin/company/overview',
    '/api/v1/admin/company/analytics/overview',
    '/api/v1/admin/company/automation',
    '/api/v1/admin/company/activity',
  ];

  it.each(ALL_ROUTES.map((url) => ({ url })))(
    '403s a group leader (leader, but not of a company) on $url',
    async ({ url }) => {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: `nexus_session=${GROUP_LEADER_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    }
  );

  it.each(ALL_ROUTES.map((url) => ({ url })))(
    '403s a team_member on $url',
    async ({ url }) => {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: `nexus_session=${MEMBER_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    }
  );

  // ---- Success paths -------------------------------------------------------

  it('GET /overview returns aggregate counts for the company', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/company/overview',
      headers: { cookie: `nexus_session=${COMPANY_LEADER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      orgId: 'company-A',
      totalPeople: 3,
      openTasks: 4,    // not_started(2) + in_progress(2)
      blockedTasks: 1,
      doneTasks: 3,
      activeGoals: 2,
      knowledgeEntries: 5,
      storageUsedBytes: 12345,
      storageQuotaBytes: 500 * 1024 * 1024, // no per-org override in the fixture → STORAGE_DEFAULT_ORG_QUOTA_BYTES's own unset-env fallback
    });
    expect(res.json().generatedAt).toBeTruthy();
  });

  it('GET /analytics/overview returns trends + failsafe counts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/company/analytics/overview',
      headers: { cookie: `nexus_session=${COMPANY_LEADER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      trends: fakeTrends,
      blockedCount: 1,          // fakeBlocked.length
      upcomingDeadlineCount: 2, // fakeDeadlines.length
    });
  });

  it('GET /automation returns automation controls', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/company/automation',
      headers: { cookie: `nexus_session=${COMPANY_LEADER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().controls).toHaveLength(2);
  });

  it('GET /activity returns org-scoped audit entries', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/company/activity',
      headers: { cookie: `nexus_session=${COMPANY_LEADER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toHaveLength(1);
    expect(res.json().entries[0].orgId).toBe('company-A');
  });
});
