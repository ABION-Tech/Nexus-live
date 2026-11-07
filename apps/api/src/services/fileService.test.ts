// Service-level tests for fileService.ts's 0023 (Company docs/archive)
// additions: org-wide storage quota enforcement in requestFileUpload, and
// getOrgStorageUsage's own query. db.js is mocked — this is query/limit
// logic under test, same posture projectService.test.ts already takes,
// not an RLS/migration integration test. objectStorageProvider is mocked
// too since a presign is a pure local crypto call this test has no
// reason to exercise for real.
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

vi.mock('../integrations/objectStorageProvider.js', () => ({
  objectStorageProvider: {
    getUploadUrl: vi.fn(async (key: string) => `https://bucket.example.test/${key}`),
    getDownloadUrl: vi.fn(async (key: string) => `https://bucket.example.test/${key}`),
  },
}));

import { withOrgContext } from '../db.js';
import {
  getOrgStorageUsage,
  requestFileUpload,
  StorageQuotaExceededError,
  FileTooLargeError,
} from './fileService.js';

const withOrgContextMock = withOrgContext as unknown as ReturnType<typeof vi.fn>;

const baseInput = {
  resourceType: 'company_archive',
  resourceId: 'org-1',
  filename: 'handbook.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
};

const DEFAULT_ORG_QUOTA_BYTES = 500 * 1024 * 1024; // mirrors fileService.ts's own default — module-level env
                                                     // reads happen once at import time, so tests below drive
                                                     // scenarios via the mocked query rows, not by mutating
                                                     // process.env after the module is already loaded.
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // mirrors fileService.ts's own default, same reasoning

beforeEach(() => {
  fakeClient.query.mockReset();
  withOrgContextMock.mockClear();
});

describe('getOrgStorageUsage', () => {
  it('sums size_bytes across every uploaded file in the org, not just company_archive', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [{ total: '4096' }] });
    const usage = await getOrgStorageUsage('org-1');
    expect(usage).toBe(4096);
    // Not scoped to a resource_type in the query itself — an eod_logs
    // proof still costs bucket storage and should count toward the org
    // total the same as a company_archive doc.
    expect(fakeClient.query.mock.calls[0]![0]).not.toMatch(/resource_type/);
  });

  it('returns 0 for an org with no uploaded files (coalesce, not null)', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    expect(await getOrgStorageUsage('org-1')).toBe(0);
  });
});

describe('requestFileUpload — 0023 quota enforcement', () => {
  it('allows an upload that fits within the default org quota', async () => {
    fakeClient.query
      .mockResolvedValueOnce({ rows: [{ total: '0' }] }) // getOrgStorageUsage
      .mockResolvedValueOnce({ rows: [{ storage_quota_bytes: null }] }) // getOrgStorageQuota — no override
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'file-1',
            org_id: 'org-1',
            resource_type: 'company_archive',
            resource_id: 'org-1',
            storage_key: 'org-1/company_archive/org-1/file-1-handbook.pdf',
            original_filename: 'handbook.pdf',
            mime_type: 'application/pdf',
            size_bytes: '1024',
            uploaded_by_user_id: 'user-1',
            uploaded_at: null,
            created_at: new Date('2026-01-01T00:00:00.000Z'),
            archived_at: null,
            category: null,
          },
        ],
      }); // insert

    const result = await requestFileUpload('org-1', baseInput, 'user-1');
    expect(result.file.id).toBe('file-1');
    // The generated storage key includes a fresh crypto.randomUUID(), not
    // the mocked row's id — assert on the parts that ARE deterministic
    // (org/resourceType/resourceId prefix + original filename suffix).
    expect(result.uploadUrl).toContain('org-1/company_archive/org-1/');
    expect(result.uploadUrl).toContain('handbook.pdf');
  });

  it('rejects an upload that would push the org over its quota', async () => {
    const almostFull = DEFAULT_ORG_QUOTA_BYTES - 500; // 500 bytes of headroom left
    fakeClient.query
      .mockResolvedValueOnce({ rows: [{ total: String(almostFull) }] }) // usage
      .mockResolvedValueOnce({ rows: [{ storage_quota_bytes: null }] }); // quota = env default

    // baseInput is 1024 bytes — more than the 500 bytes of headroom left,
    // so this should reject before ever reaching the insert/presign step.
    await expect(requestFileUpload('org-1', baseInput, 'user-1')).rejects.toThrow(StorageQuotaExceededError);
    // Exactly two queries (usage, quota) — no insert attempted once the
    // quota check fails.
    expect(fakeClient.query).toHaveBeenCalledTimes(2);
  });

  it('honors a per-org storage_quota_bytes override over the env default', async () => {
    fakeClient.query
      .mockResolvedValueOnce({ rows: [{ total: '500' }] })
      .mockResolvedValueOnce({ rows: [{ storage_quota_bytes: '1000' }] }); // a much tighter override than the default

    // 500 + 1024 > 1000 → the override, not the (much larger) env
    // default, should govern.
    await expect(requestFileUpload('org-1', baseInput, 'user-1')).rejects.toThrow(StorageQuotaExceededError);
  });

  it('still enforces the existing per-file cap before ever checking the org quota', async () => {
    await expect(
      requestFileUpload('org-1', { ...baseInput, sizeBytes: DEFAULT_MAX_UPLOAD_BYTES + 1 }, 'user-1')
    ).rejects.toThrow(FileTooLargeError);
    // Per-file check throws synchronously up front — no usage/quota
    // queries should even run for a file that's already too large on
    // its own.
    expect(fakeClient.query).not.toHaveBeenCalled();
  });

  it('persists category only for company_archive uploads, passing it through to the insert', async () => {
    fakeClient.query
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [{ storage_quota_bytes: null }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'file-2',
            org_id: 'org-1',
            resource_type: 'company_archive',
            resource_id: 'org-1',
            storage_key: 'org-1/company_archive/org-1/file-2-policy.pdf',
            original_filename: 'policy.pdf',
            mime_type: 'application/pdf',
            size_bytes: '1024',
            uploaded_by_user_id: 'user-1',
            uploaded_at: null,
            created_at: new Date('2026-01-01T00:00:00.000Z'),
            archived_at: null,
            category: 'policy',
          },
        ],
      });

    const result = await requestFileUpload('org-1', { ...baseInput, category: 'policy' }, 'user-1');
    expect(result.file.category).toBe('policy');
    // category is the last bind param on the insert — confirm it was
    // actually threaded through rather than silently dropped.
    const insertCall = fakeClient.query.mock.calls[2]!;
    expect(insertCall[1]).toContain('policy');
  });
});
