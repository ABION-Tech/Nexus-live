// Company Docs offline/instant-paint cache (0023, ADMIN_BUILD_GUIDE.md
// Session 8) — CompanyDocs.tsx's own two load-bearing calls:
//   1. Metadata cache: paint the file list from local storage before the
//      network GET /files?resourceType=company_archive&... resolves, so
//      a returning user sees the list instantly instead of a spinner.
//   2. Blob cache: instant re-open of a previously-opened previewable
//      file (image/PDF/plain-text) without re-fetching the presigned URL
//      or the bytes.
//
// IndexedDB, not localStorage — PRD §15's own instruction for this class
// of thing ("move to IndexedDB, not localStorage") applies here even
// though this isn't the offline *write* queue PRD §15 is describing;
// the reasoning is the same either way: localStorage is synchronous,
// string-only, and far too small for cached file blobs, IndexedDB is
// none of those things.
//
// No existing IndexedDB precedent elsewhere in this codebase to mirror
// (checked — nothing under apps/web/src/services matches `*Cache*` or
// `*idb*` before this file), so this is a small purpose-built wrapper
// rather than a shared "offlineStore" abstraction — per this codebase's
// own "abstract repeated things, not hypothetical future things" rule
// (PRD §6.2), a shared cache abstraction is worth extracting once a
// second caller shows up, not before.

import type { FileRecord } from '@nexus/shared';

const DB_NAME = 'nexus-company-archive-cache';
const DB_VERSION = 1;
const METADATA_STORE = 'metadata'; // keyPath 'id' — one row per FileRecord
const BLOB_STORE = 'blobs'; // keyPath 'fileId' — one row per previewed file's bytes

// Blob cache is a bounded LRU-by-insertion-order cache, not an unbounded
// store — a company archive can accumulate large PDFs, and nothing here
// should let repeated previewing quietly grow into a multi-hundred-MB
// browser storage footprint. 25 is a deliberately simple v1 cap, not
// derived from any PRD number — the same "deliberately simple v1
// default" posture fileService.ts's own MAX_UPLOAD_BYTES/
// DEFAULT_ORG_QUOTA_BYTES take.
const MAX_CACHED_BLOBS = 25;

interface CachedBlobRow {
  fileId: string;
  blob: Blob;
  mimeType: string;
  cachedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** Opens (creating on first use) the shared connection. Memoized on the
 * module — every caller in a given tab shares one open connection rather
 * than re-opening per call. Resolves to null, never rejects, when
 * IndexedDB isn't available at all (very old browsers, some locked-down
 * embedded webviews, or a non-browser test environment) — every
 * exported function below treats a null db as "cache unavailable" and
 * degrades to its no-op/empty behavior rather than throwing, since none
 * of this cache is load-bearing for correctness, only for paint speed. */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;

  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.resolve(null as unknown as IDBDatabase);
    return dbPromise;
  }

  dbPromise = new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(METADATA_STORE)) {
        db.createObjectStore(METADATA_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE, { keyPath: 'fileId' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    // Any open failure (private-browsing quota lockouts on some
    // browsers, corrupted DB, etc.) degrades to "no cache" rather than
    // surfacing an error the caller has no good way to act on.
    req.onerror = () => resolve(null as unknown as IDBDatabase);
  });

  return dbPromise;
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- Metadata cache --------------------------------------------------

/** Returns the last-cached file list, newest first — empty array (never
 * throws) if nothing is cached yet or IndexedDB is unavailable. Callers
 * treat an empty array as "nothing to paint from cache", not an error. */
export async function getCachedArchiveMetadata(): Promise<FileRecord[]> {
  const db = await openDb();
  if (!db) return [];

  try {
    const tx = db.transaction(METADATA_STORE, 'readonly');
    const rows = await promisifyRequest(tx.objectStore(METADATA_STORE).getAll() as IDBRequest<FileRecord[]>);
    return rows.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch {
    return [];
  }
}

/** Replaces the entire cached metadata set with `files` — a full
 * replace, not a merge, since the caller always has the authoritative
 * current list (a fresh GET result, or the current in-memory state
 * after an upload/archive) and a stale row lingering from a prior
 * session (e.g. a file archived elsewhere) should not survive. Silently
 * no-ops if IndexedDB is unavailable — this cache is never the source
 * of truth, so a failed write here must never surface to the caller as
 * an error. */
export async function replaceCachedArchiveMetadata(files: FileRecord[]): Promise<void> {
  const db = await openDb();
  if (!db) return;

  try {
    const tx = db.transaction(METADATA_STORE, 'readwrite');
    const store = tx.objectStore(METADATA_STORE);
    store.clear();
    for (const file of files) store.put(file);
    // IDBTransaction only ever fires 'complete' / 'error' / 'abort' — it
    // has no 'success' event. A prior version of this function also
    // awaited `promisifyRequest(tx as unknown as IDBRequest<undefined>)`
    // first, which set `tx.onsuccess`/`tx.onerror`; since 'success' never
    // fires on a transaction, that promise never settled and this
    // function hung forever on every call (caught by this session's own
    // test suite — see companyArchiveCache.test.ts). Removed; the
    // completion promise below is the only wait this function needs,
    // matching the pattern already used correctly by cacheBlob below.
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // Cache write failure is never surfaced — see doc comment above.
  }
}

// ---- Blob cache --------------------------------------------------------

/** Returns the cached blob + mime type for a previously-opened
 * previewable file, or undefined if nothing is cached (or IndexedDB is
 * unavailable) — CompanyDocs.tsx falls back to a real fetch either way. */
export async function getCachedBlob(fileId: string): Promise<{ blob: Blob; mimeType: string } | undefined> {
  const db = await openDb();
  if (!db) return undefined;

  try {
    const tx = db.transaction(BLOB_STORE, 'readonly');
    const row = await promisifyRequest(tx.objectStore(BLOB_STORE).get(fileId) as IDBRequest<CachedBlobRow | undefined>);
    if (!row) return undefined;
    return { blob: row.blob, mimeType: row.mimeType };
  } catch {
    return undefined;
  }
}

/** Stores a fetched blob for instant re-open next time, evicting the
 * oldest cached entries first if this would push the cache over
 * MAX_CACHED_BLOBS — see the cap's own doc comment above. Silently
 * no-ops on any failure (unavailable IndexedDB, storage quota exceeded
 * by the browser itself, etc.): a failed cache write should never block
 * or error out the preview the caller is already showing from the blob
 * it just fetched. */
export async function cacheBlob(fileId: string, blob: Blob, mimeType: string): Promise<void> {
  const db = await openDb();
  if (!db) return;

  try {
    const tx = db.transaction(BLOB_STORE, 'readwrite');
    const store = tx.objectStore(BLOB_STORE);
    const row: CachedBlobRow = { fileId, blob, mimeType, cachedAt: Date.now() };
    store.put(row);

    const allRows = await promisifyRequest(store.getAll() as IDBRequest<CachedBlobRow[]>);
    if (allRows.length > MAX_CACHED_BLOBS) {
      const oldestFirst = allRows.slice().sort((a, b) => a.cachedAt - b.cachedAt);
      const toEvict = oldestFirst.slice(0, allRows.length - MAX_CACHED_BLOBS);
      for (const evict of toEvict) store.delete(evict.fileId);
    }

    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // Cache write failure is never surfaced — see doc comment above.
  }
}
