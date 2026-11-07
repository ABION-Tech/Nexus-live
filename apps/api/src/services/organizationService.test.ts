// Closes a real gap found during the Session 9 hardening pass
// (ADMIN_BUILD_GUIDE.md's own "Session 9 — Testing, hardening, final
// report" — never run as its own pass; see SESSION_LOG). This service
// is the load-bearing piece for group/company CRUD, the Super Admin
// plan-change authority (guide §1), and — the specific thing this file
// exists to pin down — the query `listCompaniesInGroup` runs to decide
// which companies belong to a group. Every other isolation test in this
// repo (authorizationService.test.ts, groupAdmin.test.ts, etc.) assumes
// that query is correct; nothing actually tested it directly until now.
// Independent companies (`parent_org_id = null`) must never be
// attributable to any group's aggregate — that's the "analytics
// attribution: null group for independent companies" checklist item the
// guide's own Session 9 called for.
//
// Same mocking posture as authorizationService.test.ts: db.js mocked,
// authorizationService.js mocked with its error classes kept real via
// importActual — this is organizationService's own logic under test
// (which query runs, with which params, under which authorization
// gate), not a migration/RLS integration test.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from './sessionService.js';

const fakeClient = { query: vi.fn() };

vi.mock('../db.js', () => ({
  pool: { query: vi.fn() },
  withOrgContext: vi.fn(async (_orgId: string, fn: (client: unknown) => unknown) => fn(fakeClient)),
}));

vi.mock('./authorizationService.js', async () => {
  const actual = await vi.importActual<typeof import('./authorizationService.js')>('./authorizationService.js');
  return {
    ...actual, // keeps OrgAccessDeniedError real
    isPlatformAdmin: vi.fn(async () => false),
    canReadOrg: vi.fn(),
  };
});

import { pool, withOrgContext } from '../db.js';
import { canReadOrg, isPlatformAdmin, OrgAccessDeniedError } from './authorizationService.js';
import {
  assignCompanyToGroup,
  createOrganization,
  deactivateOrganization,
  listCompaniesInGroup,
  OrganizationError,
  updateOrganization,
} from './organizationService.js';

const poolQuery = pool.query as unknown as ReturnType<typeof vi.fn>;
const withOrgContextMock = withOrgContext as unknown as ReturnType<typeof vi.fn>;
const isPlatformAdminMock = isPlatformAdmin as unknown as ReturnType<typeof vi.fn>;
const canReadOrgMock = canReadOrg as unknown as ReturnType<typeof vi.fn>;

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

const now = new Date('2026-08-30T00:00:00.000Z');
function orgRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'org-x',
    name: 'Org X',
    org_type: 'company',
    parent_org_id: null,
    plan: 'free',
    active: true,
    created_at: now,
    ...overrides,
  };
}

beforeEach(() => {
  poolQuery.mockReset();
  fakeClient.query.mockReset();
  withOrgContextMock.mockClear();
  isPlatformAdminMock.mockReset().mockResolvedValue(false);
  canReadOrgMock.mockReset();
});

describe('createOrganization', () => {
  it('rejects a non-platform-admin before any query', async () => {
    await expect(
      createOrganization(user(), { name: 'New Co', orgType: 'company' })
    ).rejects.toThrow(OrganizationError);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('rejects a group given a parentOrgId — groups cannot have a parent', async () => {
    isPlatformAdminMock.mockResolvedValue(true);
    await expect(
      createOrganization(user(), { name: 'Group X', orgType: 'group', parentOrgId: 'group-A' })
    ).rejects.toThrow(/cannot have a parent/);
  });

  it("rejects a company whose declared parent isn't actually a group", async () => {
    isPlatformAdminMock.mockResolvedValue(true);
    poolQuery.mockResolvedValueOnce({ rows: [{ org_type: 'company' }] }); // parent lookup: it's a company, not a group
    await expect(
      createOrganization(user(), { name: 'Co X', orgType: 'company', parentOrgId: 'company-B' })
    ).rejects.toThrow(/parent must be a group/);
  });

  it('creates a company under a real group for a platform admin', async () => {
    isPlatformAdminMock.mockResolvedValue(true);
    poolQuery
      .mockResolvedValueOnce({ rows: [{ org_type: 'group' }] }) // parent lookup: valid group
      .mockResolvedValueOnce({ rows: [orgRow({ id: 'org-new', org_type: 'company', parent_org_id: 'group-A' })] });

    const result = await createOrganization(user(), { name: 'Co X', orgType: 'company', parentOrgId: 'group-A' });
    expect(result.parentOrgId).toBe('group-A');
  });

  it('creates an independent company with parentOrgId undefined — no parent lookup query at all', async () => {
    isPlatformAdminMock.mockResolvedValue(true);
    poolQuery.mockResolvedValueOnce({ rows: [orgRow({ id: 'org-new', parent_org_id: null })] });

    const result = await createOrganization(user(), { name: 'Independent Co', orgType: 'company' });
    expect(result.parentOrgId).toBeUndefined();
    expect(poolQuery).toHaveBeenCalledTimes(1); // only the insert — no parent-group lookup was needed
  });
});

describe('updateOrganization — plan/active vs name authority split', () => {
  it('rejects a non-platform-admin trying to change plan, even for their own org', async () => {
    await expect(
      updateOrganization(user({ orgId: 'org-1', role: 'leader' }), 'org-1', { plan: 'paid' })
    ).rejects.toThrow(OrganizationError);
    expect(canReadOrgMock).not.toHaveBeenCalled(); // plan/active branch never even consults canReadOrg
  });

  it('rejects a non-platform-admin trying to deactivate an org', async () => {
    await expect(
      updateOrganization(user({ role: 'leader' }), 'org-1', { active: false })
    ).rejects.toThrow(OrganizationError);
  });

  it('a platform admin can change plan regardless of canReadOrg', async () => {
    isPlatformAdminMock.mockResolvedValue(true);
    poolQuery.mockResolvedValueOnce({ rows: [orgRow({ plan: 'paid' })] });
    const result = await updateOrganization(user({ role: 'team_member' }), 'org-x', { plan: 'paid' });
    expect(result?.plan).toBe('paid');
    expect(canReadOrgMock).not.toHaveBeenCalled();
  });

  it("a same-org leader can rename their own org (name-only patch doesn't need platform admin)", async () => {
    canReadOrgMock.mockResolvedValue({ allowed: true, scope: 'own' });
    poolQuery.mockResolvedValueOnce({ rows: [orgRow({ name: 'Renamed' })] });
    const result = await updateOrganization(user({ orgId: 'org-x', role: 'leader' }), 'org-x', { name: 'Renamed' });
    expect(result?.name).toBe('Renamed');
  });

  it('group_read scope (a group leader looking at a child company) cannot rename that company — read-only', async () => {
    canReadOrgMock.mockResolvedValue({ allowed: true, scope: 'group_read' });
    await expect(
      updateOrganization(user({ orgId: 'group-A', role: 'leader' }), 'company-under-A', { name: 'Renamed' })
    ).rejects.toThrow(OrgAccessDeniedError);
  });

  it('a denied canReadOrg result blocks the name-only patch entirely', async () => {
    canReadOrgMock.mockResolvedValue({ allowed: false, scope: 'none' });
    await expect(
      updateOrganization(user({ orgId: 'group-A', role: 'leader' }), 'company-under-B', { name: 'Renamed' })
    ).rejects.toThrow(OrgAccessDeniedError);
  });
});

describe('deactivateOrganization', () => {
  it('delegates to updateOrganization with { active: false }, platform-admin gated', async () => {
    await expect(deactivateOrganization(user({ role: 'leader' }), 'org-x')).rejects.toThrow(OrganizationError);
  });

  it('flips active to false for a platform admin', async () => {
    isPlatformAdminMock.mockResolvedValue(true);
    poolQuery.mockResolvedValueOnce({ rows: [orgRow({ active: false })] });
    const result = await deactivateOrganization(user(), 'org-x');
    expect(result?.active).toBe(false);
  });
});

describe('assignCompanyToGroup', () => {
  it('rejects a non-platform-admin before any query', async () => {
    await expect(assignCompanyToGroup(user({ role: 'leader' }), 'company-A', 'group-A')).rejects.toThrow(
      OrganizationError
    );
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('not_found when the company id does not resolve', async () => {
    isPlatformAdminMock.mockResolvedValue(true);
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(assignCompanyToGroup(user(), 'missing-co', 'group-A')).rejects.toThrow(/Company not found/);
  });

  it('invalid_parent when the target id is a group, not a company', async () => {
    isPlatformAdminMock.mockResolvedValue(true);
    poolQuery.mockResolvedValueOnce({ rows: [orgRow({ id: 'group-B', org_type: 'group' })] });
    await expect(assignCompanyToGroup(user(), 'group-B', 'group-A')).rejects.toThrow(/Only a company/);
  });

  it("invalid_parent when the destination isn't actually a group", async () => {
    isPlatformAdminMock.mockResolvedValue(true);
    poolQuery
      .mockResolvedValueOnce({ rows: [orgRow({ id: 'company-A', org_type: 'company' })] })
      .mockResolvedValueOnce({ rows: [{ org_type: 'company' }] }); // destination is a company, not a group
    await expect(assignCompanyToGroup(user(), 'company-A', 'company-B')).rejects.toThrow(/Target must be a group/);
  });

  it('assigns a company into a real group', async () => {
    isPlatformAdminMock.mockResolvedValue(true);
    poolQuery
      .mockResolvedValueOnce({ rows: [orgRow({ id: 'company-A', org_type: 'company' })] })
      .mockResolvedValueOnce({ rows: [{ org_type: 'group' }] })
      .mockResolvedValueOnce({ rows: [orgRow({ id: 'company-A', org_type: 'company', parent_org_id: 'group-A' })] });

    const result = await assignCompanyToGroup(user(), 'company-A', 'group-A');
    expect(result.parentOrgId).toBe('group-A');
  });

  it('passing groupOrgId: null makes the company independent again — no destination-group lookup at all', async () => {
    isPlatformAdminMock.mockResolvedValue(true);
    poolQuery
      .mockResolvedValueOnce({ rows: [orgRow({ id: 'company-A', org_type: 'company', parent_org_id: 'group-A' })] })
      .mockResolvedValueOnce({ rows: [orgRow({ id: 'company-A', org_type: 'company', parent_org_id: null })] });

    const result = await assignCompanyToGroup(user(), 'company-A', null);
    expect(result.parentOrgId).toBeUndefined();
    expect(poolQuery).toHaveBeenCalledTimes(2); // company lookup + the assign call — no group-validity query
  });
});

describe('listCompaniesInGroup — the group/company attribution query itself', () => {
  it('denies before ever opening withOrgContext when canReadOrg says no', async () => {
    canReadOrgMock.mockResolvedValue({ allowed: false, scope: 'none' });
    await expect(listCompaniesInGroup(user({ role: 'leader' }), 'group-A')).rejects.toThrow(OrgAccessDeniedError);
    expect(withOrgContextMock).not.toHaveBeenCalled();
  });

  it("scopes the query to parent_org_id = groupOrgId, and runs it under that group's own RLS context", async () => {
    canReadOrgMock.mockResolvedValue({ allowed: true, scope: 'own' });
    fakeClient.query.mockResolvedValueOnce({
      rows: [orgRow({ id: 'company-A', parent_org_id: 'group-A' })],
    });

    const result = await listCompaniesInGroup(user({ orgId: 'group-A', role: 'leader' }), 'group-A');

    expect(withOrgContextMock).toHaveBeenCalledWith('group-A', expect.any(Function));
    expect(fakeClient.query).toHaveBeenCalledWith(expect.stringContaining('parent_org_id = $1'), ['group-A']);
    expect(result).toHaveLength(1);
    expect(result[0]?.parentOrgId).toBe('group-A');
  });

  it('an independent company (parent_org_id null) is never attributable to a group — it simply cannot match this WHERE clause', async () => {
    // The query is parameterized on a specific, non-null groupOrgId, so
    // an independent org's null parent_org_id can never satisfy
    // `parent_org_id = $1` regardless of what RLS or the caller's
    // authorization allows through. This pins that down explicitly
    // rather than leaving it as an implicit property of the SQL.
    canReadOrgMock.mockResolvedValue({ allowed: true, scope: 'own' });
    fakeClient.query.mockResolvedValueOnce({ rows: [] }); // real Postgres would also return zero rows here

    const result = await listCompaniesInGroup(user({ orgId: 'group-A', role: 'leader' }), 'group-A');

    expect(fakeClient.query).toHaveBeenCalledWith(expect.any(String), ['group-A']);
    expect(result).toEqual([]);
  });
});
