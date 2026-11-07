// Service-level tests for the two read paths projectService.ts's
// top-of-file comment describes. db.js is mocked — this is query/
// authorization logic under test, same posture authorizationService.test.ts
// already takes, not an RLS/migration integration test.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeClient = { query: vi.fn() };

vi.mock('../db.js', () => ({
  pool: { query: vi.fn() },
  withOrgContext: vi.fn(async (_orgId: string, fn: (client: unknown) => unknown) => fn(fakeClient)),
}));

vi.mock('./activityLogService.js', () => ({
  logActivity: vi.fn(),
  logActivityCreated: vi.fn(),
  diffColumns: vi.fn(() => []),
}));

import { pool, withOrgContext } from '../db.js';
import { getProjectForMember, listProjectsForMember } from './projectService.js';

const poolQuery = pool.query as unknown as ReturnType<typeof vi.fn>;
const withOrgContextMock = withOrgContext as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  poolQuery.mockReset();
  fakeClient.query.mockReset();
  withOrgContextMock.mockClear();
});

describe('getProjectForMember — the project_memberships read path', () => {
  it('returns null (not an error) when the caller has no membership row on this project', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] }); // membership check -> nothing
    const result = await getProjectForMember('user-1', 'project-1');
    expect(result).toBeNull();
    // Never even looks up the project or opens an org context — a
    // membership-less caller shouldn't cause a second query that could
    // leak timing/existence information.
    expect(withOrgContextMock).not.toHaveBeenCalled();
  });

  it('reads the project using the PROJECT\'s own org_id, not any org_id the caller might supply', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // membership row exists
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'project-1',
            org_id: 'company-B', // the project's owning org — a cross-org collaborator's own org is irrelevant here
            title: 'Cross-org collab project',
            description: null,
            status: 'active',
            created_by_user_id: 'user-owner',
            created_at: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
      }); // project row lookup

    fakeClient.query.mockResolvedValueOnce({ rows: [] }); // tasks

    // fetchMembers hits the raw pool too (not the client) — queue its
    // response as the third overall poolQuery call.
    poolQuery.mockResolvedValueOnce({ rows: [] }); // members

    const result = await getProjectForMember('user-1', 'project-1');

    expect(withOrgContextMock).toHaveBeenCalledWith('company-B', expect.any(Function));
    expect(result?.orgId).toBe('company-B');
  });

  it('returns null when the membership row exists but the project itself is gone (orphaned membership)', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // membership exists
    poolQuery.mockResolvedValueOnce({ rows: [] }); // but no project row
    const result = await getProjectForMember('user-1', 'project-1');
    expect(result).toBeNull();
    expect(withOrgContextMock).not.toHaveBeenCalled();
  });
});

describe('listProjectsForMember', () => {
  it('returns an empty list for a user with no project_memberships rows at all', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await listProjectsForMember('user-1');
    expect(result).toEqual([]);
    expect(withOrgContextMock).not.toHaveBeenCalled();
  });

  it('groups memberships by owning org and runs one withOrgContext per org, not per project', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [
        { project_id: 'p1', org_id: 'org-A' },
        { project_id: 'p2', org_id: 'org-A' }, // same org as p1 — should NOT trigger a second withOrgContext call for org-A
        { project_id: 'p3', org_id: 'org-B' },
      ],
    });

    // Two distinct orgs -> two withOrgContext calls. Each call's client
    // returns an empty project list here (the grouping behavior is what's
    // under test, not the per-project fetch, which getProjectForMember's
    // tests above already cover).
    fakeClient.query.mockResolvedValue({ rows: [] });

    await listProjectsForMember('user-1');

    expect(withOrgContextMock).toHaveBeenCalledTimes(2);
    expect(withOrgContextMock).toHaveBeenCalledWith('org-A', expect.any(Function));
    expect(withOrgContextMock).toHaveBeenCalledWith('org-B', expect.any(Function));
  });
});
