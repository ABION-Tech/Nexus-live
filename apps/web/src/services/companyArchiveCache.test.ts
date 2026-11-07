// Closes next-steps item #3 (part) from the Session 9 hardening pass
// (SESSION_LOG.md: "companyArchiveCache.ts test coverage — still open,
// unchanged from prior sessions' notes (still no fake-indexeddb
// precedent in this codebase)"). This is the first fake-indexeddb usage
// in the repo — added as a devDependency for this pass specifically.
//
// Each test gets a fresh in-memory IndexedDB (`new IDBFactory()`
// assigned to `globalThis.indexedDB`) *and* a fresh import of the module
// under test (`vi.resetModules()`), because the module memoizes its own
// `dbPromise` at module-scope — reusing either the database or the
// module import across tests would leak state between cases the way a
// real browser tab never would (a real tab has exactly one IndexedDB per
// origin per test run; here every test needs to look like a clean tab).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { FileRecord } from '@nexus/shared';

async function importFresh() {
  vi.resetModules();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  return import('./companyArchiveCache');
}

function fileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: 'file-1',
    orgId: 'org-1',
    resourceType: 'company_archive',
    resourceId: 'org-1',
    originalFilename: 'doc.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    uploadedByUserId: 'user-1',
    uploadedAt: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('metadata cache', () => {
  it('returns an empty array when nothing has been cached yet', async () => {
    const { getCachedArchiveMetadata } = await importFresh();

    await expect(getCachedArchiveMetadata()).resolves.toEqual([]);
  });

  it('round-trips a replaced set and returns it newest-first', async () => {
    const { replaceCachedArchiveMetadata, getCachedArchiveMetadata } = await importFresh();

    const older = fileRecord({ id: 'a', createdAt: '2026-08-01T00:00:00.000Z' });
    const newer = fileRecord({ id: 'b', createdAt: '2026-08-15T00:00:00.000Z' });

    await replaceCachedArchiveMetadata([older, newer]);
    const result = await getCachedArchiveMetadata();

    expect(result.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('is a full replace, not a merge — a prior entry not present in the new set is gone', async () => {
    const { replaceCachedArchiveMetadata, getCachedArchiveMetadata } = await importFresh();

    await replaceCachedArchiveMetadata([fileRecord({ id: 'stale', createdAt: '2026-08-01T00:00:00.000Z' })]);
    await replaceCachedArchiveMetadata([fileRecord({ id: 'fresh', createdAt: '2026-08-20T00:00:00.000Z' })]);

    const result = await getCachedArchiveMetadata();
    expect(result.map((r) => r.id)).toEqual(['fresh']);
  });

  it('replacing with an empty list clears the cache', async () => {
    const { replaceCachedArchiveMetadata, getCachedArchiveMetadata } = await importFresh();

    await replaceCachedArchiveMetadata([fileRecord()]);
    await replaceCachedArchiveMetadata([]);

    await expect(getCachedArchiveMetadata()).resolves.toEqual([]);
  });
});

describe('blob cache', () => {
  it('returns undefined for a file that was never cached', async () => {
    const { getCachedBlob } = await importFresh();

    await expect(getCachedBlob('nope')).resolves.toBeUndefined();
  });

  it('round-trips a cached blob and its mime type', async () => {
    // Note: mimeType is stored as its own plain string field alongside
    // the blob (see CachedBlobRow), so it round-trips through structured
    // clone with full fidelity independent of the blob payload itself.
    // jsdom's Blob implementation doesn't support `.text()`/`.arrayBuffer()`
    // and fake-indexeddb's structured-clone of Blob is correspondingly
    // lossy in this test environment (a real browser's IndexedDB does not
    // have this limitation) — so presence/absence and mimeType are what
    // this suite asserts on, not byte-for-byte blob content.
    const { cacheBlob, getCachedBlob } = await importFresh();
    const blob = new Blob(['hello'], { type: 'text/plain' });

    await cacheBlob('file-1', blob, 'text/plain');
    const result = await getCachedBlob('file-1');

    expect(result).toBeDefined();
    expect(result!.mimeType).toBe('text/plain');
  });

  it('overwrites a prior cache entry for the same fileId (mimeType reflects the latest write)', async () => {
    const { cacheBlob, getCachedBlob } = await importFresh();

    await cacheBlob('file-1', new Blob(['v1']), 'text/plain');
    await cacheBlob('file-1', new Blob(['v2']), 'application/pdf');

    const result = await getCachedBlob('file-1');
    expect(result!.mimeType).toBe('application/pdf');
  });

  it('evicts the oldest entries first once the cache exceeds MAX_CACHED_BLOBS (25)', async () => {
    const { cacheBlob, getCachedBlob } = await importFresh();

    // Date.now() is mocked to a strictly increasing sequence so insertion
    // order is unambiguous — a tight real-time loop could tie at
    // millisecond resolution and make the "oldest first" claim flaky.
    let tick = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (tick += 1));

    for (let i = 0; i < 27; i++) {
      await cacheBlob(`file-${i}`, new Blob([`v${i}`]), 'text/plain');
    }

    // 27 inserted, cap is 25 -> the two oldest (file-0, file-1) evicted.
    await expect(getCachedBlob('file-0')).resolves.toBeUndefined();
    await expect(getCachedBlob('file-1')).resolves.toBeUndefined();
    // The rest, including the most recently inserted, survive.
    await expect(getCachedBlob('file-2')).resolves.toBeDefined();
    await expect(getCachedBlob('file-26')).resolves.toBeDefined();
  });
});

describe('graceful degrade when IndexedDB is unavailable', () => {
  it('every read/write no-ops instead of throwing', async () => {
    vi.resetModules();
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = undefined;

    const { getCachedArchiveMetadata, replaceCachedArchiveMetadata, getCachedBlob, cacheBlob } = await import(
      './companyArchiveCache'
    );

    await expect(getCachedArchiveMetadata()).resolves.toEqual([]);
    await expect(replaceCachedArchiveMetadata([fileRecord()])).resolves.toBeUndefined();
    await expect(getCachedBlob('any')).resolves.toBeUndefined();
    await expect(cacheBlob('any', new Blob(['x']), 'text/plain')).resolves.toBeUndefined();

    // Restore for any later test file sharing this process.
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });
});
