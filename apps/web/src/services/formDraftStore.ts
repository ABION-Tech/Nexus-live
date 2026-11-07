// Generic per-form draft persistence (PRD §4: "Draft auto-save: per-form
// local persistence survives accidental close/reload. Port conceptually
// into the PWA offline strategy" — and PRD §15 names the target
// explicitly: "move to IndexedDB, not localStorage"). The MVP's
// `saveDraft`/`restoreDraftIfAny` pair lived in the old code.gs/index.html
// app (PRD §4's "Current State Summary"), not in this repo — there's
// nothing to literally migrate here, so this is a fresh implementation of
// the same *contract* (save on change, restore on load, clear on
// successful submit), named to match.
//
// First real caller: EodReport.tsx, closing its own comment ("no
// per-form draft persistence layer yet in this codebase, so it's
// session-only here"). Same IndexedDB shape as companyArchiveCache.ts —
// module-memoized connection, promisified requests, degrade to a no-op
// (never throw) on any failure, since a lost draft is a UX regression,
// not a correctness one, and must never block the form it's attached to.

const DB_NAME = 'nexus-form-drafts';
const DB_VERSION = 1;
const STORE = 'drafts'; // keyPath 'formId' — one row per distinct form instance

interface DraftRow {
  formId: string;
  values: unknown;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;

  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }

  dbPromise = new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'formId' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });

  return dbPromise;
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Persists `values` as the current draft for `formId` — a full replace,
 * not a merge, same reasoning as companyArchiveCache.ts's
 * `replaceCachedArchiveMetadata`: the caller always has its own current,
 * complete form state, so there's nothing to merge against. Silently
 * no-ops on any failure (unavailable IndexedDB, quota, etc.) — a failed
 * draft save must never interrupt someone mid-typing. Callers are
 * expected to debounce their own calls (see EodReport.tsx) rather than
 * this function debouncing internally, since "how often" is a per-form
 * UX choice, not a storage-layer one. */
export async function saveDraft(formId: string, values: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;

  try {
    const tx = db.transaction(STORE, 'readwrite');
    const row: DraftRow = { formId, values, savedAt: Date.now() };
    tx.objectStore(STORE).put(row);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // See doc comment above — never surfaced.
  }
}

/** Returns the saved draft for `formId`, or undefined if there isn't one
 * (or IndexedDB is unavailable) — callers treat undefined as "nothing to
 * restore", never as an error. Caller casts to its own form-values shape
 * (this store is intentionally untyped past `unknown`, the same
 * generic-by-necessity reasoning RelationshipForm.tsx's own
 * `Record<string, unknown>` values already use — a shared drafts store
 * can't know every caller's field shape). */
export async function restoreDraftIfAny(formId: string): Promise<unknown | undefined> {
  const db = await openDb();
  if (!db) return undefined;

  try {
    const tx = db.transaction(STORE, 'readonly');
    const row = await promisifyRequest(tx.objectStore(STORE).get(formId) as IDBRequest<DraftRow | undefined>);
    return row?.values;
  } catch {
    return undefined;
  }
}

/** Clears the draft for `formId` — called on successful submit, so a
 * finished form doesn't keep re-offering a stale draft next time it's
 * opened. No-ops (never throws) if there was nothing to clear or
 * IndexedDB is unavailable. */
export async function clearDraft(formId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;

  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(formId);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // Never surfaced — see saveDraft's doc comment.
  }
}
