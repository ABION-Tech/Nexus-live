// Session 40 continuation. auditLogService.ts's two write paths
// (logOrgAction / logPlatformAction) plus their *Safely wrappers. Same
// db.js mocking posture as projectService.test.ts / authorizationService.
// test.ts — this is the query/mapping logic under test, not an
// integration test against a real audit_log table.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeClient = { query: vi.fn() };

vi.mock('../db.js', () => ({
  pool: { query: vi.fn() },
  withOrgContext: vi.fn(async (_orgId: string, fn: (client: unknown) => unknown) => fn(fakeClient)),
}));

import { pool, withOrgContext } from '../db.js';
import {
  logOrgAction,
  logOrgActionSafely,
  logPlatformAction,
  logPlatformActionSafely,
} from './auditLogService.js';

const poolQuery = pool.query as unknown as ReturnType<typeof vi.fn>;
const withOrgContextMock = withOrgContext as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  poolQuery.mockReset();
  fakeClient.query.mockReset();
  withOrgContextMock.mockClear();
});

const baseRow = {
  id: 'audit-1',
  timestamp: new Date('2026-08-30T00:00:00.000Z'),
  user_id: null,
  org_id: null,
  action: 'organization.create',
  resource_type: 'organization',
  resource_id: null,
  ip_address: null,
  user_agent: null,
  session_id: null,
  result: 'success' as const,
  previous_value: null,
  new_value: null,
  metadata: null,
};

describe('logOrgAction', () => {
  it('writes through withOrgContext and maps the returned row, defaulting nulls to undefined', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [{ ...baseRow, org_id: 'org-1' }] });

    const entry = await logOrgAction('org-1', {
      action: 'organization.create',
      resourceType: 'organization',
      result: 'success',
    });

    expect(withOrgContextMock).toHaveBeenCalledWith('org-1', expect.any(Function));
    const [sql, params] = fakeClient.query.mock.calls[0]!;
    expect(sql).toContain('insert into audit_log');
    expect(params[0]).toBeNull(); // userId not supplied -> null, not undefined, in the query
    expect(entry.userId).toBeUndefined(); // ...but undefined in the mapped result
    expect(entry.orgId).toBe('org-1');
    expect(entry.timestamp).toBe('2026-08-30T00:00:00.000Z');
  });
});

describe('logPlatformAction', () => {
  it('routes through insert_platform_audit_log on the raw pool (no withOrgContext) and maps org_id null to undefined', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ ...baseRow, user_id: 'user-1', action: 'organization.plan_change' }] });

    const entry = await logPlatformAction({
      userId: 'user-1',
      action: 'organization.plan_change',
      resourceType: 'organization',
      result: 'success',
    });

    expect(withOrgContextMock).not.toHaveBeenCalled();
    const [sql] = poolQuery.mock.calls[0]!;
    expect(sql).toContain('insert_platform_audit_log');
    expect(entry.orgId).toBeUndefined();
    expect(entry.userId).toBe('user-1');
  });
});

describe('logOrgActionSafely', () => {
  it('never throws when the underlying write fails', async () => {
    fakeClient.query.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(
      logOrgActionSafely('org-1', { action: 'x', resourceType: 'y', result: 'error' })
    ).resolves.toBeUndefined();
  });
});

describe('logPlatformActionSafely', () => {
  it('never throws when the underlying write fails', async () => {
    poolQuery.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(
      logPlatformActionSafely({ action: 'x', resourceType: 'y', result: 'error' })
    ).resolves.toBeUndefined();
  });
});
