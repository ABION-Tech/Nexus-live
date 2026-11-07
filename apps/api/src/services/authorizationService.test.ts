// ADMIN_BUILD_GUIDE.md §1 (repo Session 37): "Isolation tests, passing,
// before anything else builds on this." Covers the four scenarios the
// guide calls out by name for this session — the fifth ("Guest sees
// only their project(s)") can't be exercised yet since project_memberships
// doesn't exist until the Projects session; what's tested here instead
// is the interim guarantee that makes that later test meaningful: a
// guest has zero permissions by default, the same as any other role
// with no explicit grant.
//
// db.js is mocked throughout — this is authorization *logic* under
// test (which query gets asked, and what it does with the answer), not
// a migration/RLS integration test. RLS itself (0016's widened
// organizations policy) is exercised for real the same way Session 27's
// "real Postgres verification pass" covered earlier migrations —
// tracked as a follow-up in this session's SESSION_LOG entry, not
// duplicated here.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../services/sessionService.js';

const fakeClient = { query: vi.fn() };

vi.mock('../db.js', () => ({
  pool: { query: vi.fn() },
  withOrgContext: vi.fn(async (_orgId: string, fn: (client: unknown) => unknown) => fn(fakeClient)),
}));

import { pool, withOrgContext } from '../db.js';
import {
  canReadOrg,
  hasPermission,
  isGroupAdmin,
  isPlatformAdmin,
  OrgAccessDeniedError,
  withAuthorizedOrgContext,
} from './authorizationService.js';

const poolQuery = pool.query as unknown as ReturnType<typeof vi.fn>;
const withOrgContextMock = withOrgContext as unknown as ReturnType<typeof vi.fn>;

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    sessionId: 's1',
    userId: 'user-1',
    orgId: 'org-1',
    role: 'team_member',
    name: 'Test User',
    email: 'test@abion.test',
    ...overrides,
  };
}

beforeEach(() => {
  poolQuery.mockReset();
  fakeClient.query.mockReset();
  withOrgContextMock.mockClear();
});

describe('isPlatformAdmin', () => {
  it('true when a platform_admins row exists', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect(await isPlatformAdmin('user-1')).toBe(true);
  });

  it('false otherwise', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await isPlatformAdmin('user-1')).toBe(false);
  });
});

describe('isGroupAdmin — Session 41 gate for Group Admin routes', () => {
  it('false for a non-leader, without even querying organizations', async () => {
    const result = await isGroupAdmin(user({ role: 'team_member', orgId: 'org-1' }));
    expect(result).toBe(false);
    expect(withOrgContextMock).not.toHaveBeenCalled();
  });

  it('true for a leader whose own current org is a group', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [{ org_type: 'group' }] });
    const result = await isGroupAdmin(user({ role: 'leader', orgId: 'group-A' }));
    expect(result).toBe(true);
    expect(withOrgContextMock).toHaveBeenCalledWith('group-A', expect.any(Function));
  });

  it('false for a leader whose own current org is a company, not a group', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [{ org_type: 'company' }] });
    const result = await isGroupAdmin(user({ role: 'leader', orgId: 'company-A' }));
    expect(result).toBe(false);
  });
});

describe('hasPermission', () => {
  it('leader bypasses the permissions lookup entirely', async () => {
    const granted = await hasPermission(user({ role: 'leader' }), 'tasks', 'read');
    expect(granted).toBe(true);
    expect(withOrgContextMock).not.toHaveBeenCalled();
  });

  it('guest has no permission without an explicit grant row (most restrictive default)', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [] });
    const granted = await hasPermission(user({ role: 'guest' }), 'projects', 'read');
    expect(granted).toBe(false);
  });

  it('guest with an explicit grant is honored — restriction is "no default", not "no path"', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    const granted = await hasPermission(user({ role: 'guest' }), 'projects', 'read');
    expect(granted).toBe(true);
  });
});

describe('canReadOrg — group leader read-scope rule', () => {
  it('always allows a user to read their own current org', async () => {
    const result = await canReadOrg(user({ orgId: 'org-1' }), 'org-1');
    expect(result).toEqual({ allowed: true, scope: 'own' });
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('platform admin can read any org', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // isPlatformAdmin
    const result = await canReadOrg(user({ orgId: 'org-1', role: 'team_member' }), 'org-99');
    expect(result).toEqual({ allowed: true, scope: 'platform_admin' });
  });

  it('leader of a group reads a company whose parent_org_id is that group', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] }) // isPlatformAdmin -> false
      .mockResolvedValueOnce({ rows: [{ org_type: 'group' }] }) // current org's type
      .mockResolvedValueOnce({ rows: [{ parent_org_id: 'group-A' }] }); // target company's parent

    const result = await canReadOrg(user({ orgId: 'group-A', role: 'leader' }), 'company-under-A');
    expect(result).toEqual({ allowed: true, scope: 'group_read' });
  });

  it('group A leader is blocked from group B (not a parent/child relationship)', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ org_type: 'group' }] })
      .mockResolvedValueOnce({ rows: [{ parent_org_id: null }] }); // group-B has no parent — it's a group, not A's child

    const result = await canReadOrg(user({ orgId: 'group-A', role: 'leader' }), 'group-B');
    expect(result).toEqual({ allowed: false, scope: 'none' });
  });

  it('group A leader is blocked from an independent company (parent_org_id null)', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ org_type: 'group' }] })
      .mockResolvedValueOnce({ rows: [{ parent_org_id: null }] });

    const result = await canReadOrg(user({ orgId: 'group-A', role: 'leader' }), 'independent-co');
    expect(result).toEqual({ allowed: false, scope: 'none' });
  });

  it('group A leader is blocked from a sibling company under a different group', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ org_type: 'group' }] })
      .mockResolvedValueOnce({ rows: [{ parent_org_id: 'group-B' }] }); // belongs to B, not A

    const result = await canReadOrg(user({ orgId: 'group-A', role: 'leader' }), 'company-under-B');
    expect(result).toEqual({ allowed: false, scope: 'none' });
  });

  it('company admin (leader of a company, not a group) is blocked cross-company', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] }) // isPlatformAdmin -> false
      .mockResolvedValueOnce({ rows: [{ org_type: 'company' }] }); // current org is a company, not a group

    const result = await canReadOrg(user({ orgId: 'company-A', role: 'leader' }), 'company-B');
    expect(result).toEqual({ allowed: false, scope: 'none' });
  });

  it('a non-leader (team_member/intern/guest) never gets group-read scope, even inside a group org', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] }); // isPlatformAdmin -> false
    const result = await canReadOrg(user({ orgId: 'group-A', role: 'team_member' }), 'company-under-A');
    expect(result).toEqual({ allowed: false, scope: 'none' });
  });
});

describe('withAuthorizedOrgContext', () => {
  it('runs the callback inside withOrgContext(targetOrgId) when access is allowed', async () => {
    const result = await withAuthorizedOrgContext(user({ orgId: 'org-1' }), 'org-1', async () => 'ok');
    expect(result).toBe('ok');
    expect(withOrgContextMock).toHaveBeenCalledWith('org-1', expect.any(Function));
  });

  it('throws OrgAccessDeniedError and never calls withOrgContext when access is denied', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] }) // isPlatformAdmin -> false
      .mockResolvedValueOnce({ rows: [{ org_type: 'company' }] }); // not a group -> denied

    await expect(
      withAuthorizedOrgContext(user({ orgId: 'company-A', role: 'leader' }), 'company-B', async () => 'unreachable')
    ).rejects.toThrow(OrgAccessDeniedError);
    expect(withOrgContextMock).not.toHaveBeenCalled();
  });
});
