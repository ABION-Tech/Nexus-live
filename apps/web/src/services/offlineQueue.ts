// Generic offline write queue (PRD §15 Phase J: "Offline write queue:
// edits/submissions made offline sync when connectivity returns").
//
// Same IndexedDB posture as companyArchiveCache.ts (module-memoized
// connection, promisified requests, degrade-to-no-op if IndexedDB is
// unavailable) with one important difference: that cache is allowed to
// silently no-op on failure because it's never load-bearing. This queue
// IS load-bearing — a write a user believes they made must not be lost
// silently — so failures here are surfaced to the caller (apiClient.ts's
// `postQueueable`) rather than swallowed, and a queued item is only ever
// removed once it has actually synced or been definitively rejected by
// the server (see `drainQueue` below), never just because a DB read
// failed transiently.
//
// Scope for this pass: apiClient.ts's `postQueueable` is the only
// producer, and it's wired into exactly two callers so far —
// taskService.ts's createTask and eodService.ts's submitEodLog (the two
// single-call-site writes confirmed clean to wire this session). Every
// other mutation in this codebase still fails normally when offline.
// That's a deliberate v1 scope cut, not an oversight: PRD §15 describes
// the capability, not "every write everywhere" as a day-one requirement,
// and wiring a write path into this queue means its caller must also
// handle the "it didn't happen yet, it's queued" UI case (see
// QueuedOfflineError below) — worth doing per-caller, not blanket.

const DB_NAME = 'nexus-offline-queue';
const DB_VERSION = 1;
const STORE = 'writes'; // keyPath 'id' — one row per queued mutation, oldest-first by insertion order

export interface QueuedWrite {
  id: string;
  method: 'POST' | 'PATCH' | 'PUT';
  path: string; // apiClient-relative path, e.g. '/tasks'
  body: unknown;
  // Human label for whatever UI wants to list/describe pending writes
  // later (e.g. a future "pending sync" indicator) — not used by the
  // drain logic itself.
  kind: string;
  queuedAt: number;
}

type QueueListener = (event: DrainEvent) => void;

export type DrainEvent =
  | { type: 'synced'; write: QueuedWrite }
  | { type: 'rejected'; write: QueuedWrite; message: string }
  | { type: 'drain-complete'; syncedCount: number; rejectedCount: number };

const listeners = new Set<QueueListener>();

/** Subscribe to drain results (a write synced, was rejected outright by
 * the server, or a drain pass finished) — App.tsx uses this to surface
 * toasts without offlineQueue.ts needing to know React exists. Returns
 * an unsubscribe function. */
export function subscribeToQueueEvents(listener: QueueListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: DrainEvent): void {
  for (const listener of listeners) listener(event);
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
        db.createObjectStore(STORE, { keyPath: 'id' });
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

// `queuedAt` is the only ordering key (listQueuedWrites sorts on it; the
// store's own key is a random UUID). Plain Date.now() let two writes
// queued in the same millisecond (two quick offline task creates) tie,
// and the tie fell back to UUID order, i.e. random replay order, which
// breaks drainQueue's oldest-first guarantee. Strictly increasing within
// a tab fixes that; across tabs/reloads the wall clock has moved on, so
// an earlier session's rows still sort first.
let lastQueuedAt = 0;
function nextQueuedAt(): number {
  lastQueuedAt = Math.max(Date.now(), lastQueuedAt + 1);
  return lastQueuedAt;
}

/** Adds a write to the queue and returns its id. Throws (does not
 * degrade to a silent no-op) if IndexedDB is unavailable or the write
 * fails — unlike companyArchiveCache.ts, a caller here needs to know
 * whether the user's edit actually has somewhere to land, since the
 * alternative is telling them it's "saved" when it isn't queued
 * anywhere. */
export async function enqueueWrite(write: Omit<QueuedWrite, 'id' | 'queuedAt'>): Promise<string> {
  const db = await openDb();
  if (!db) throw new Error('Offline storage is unavailable in this browser.');

  const entry: QueuedWrite = { ...write, id: crypto.randomUUID(), queuedAt: nextQueuedAt() };
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(entry);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return entry.id;
}

export async function listQueuedWrites(): Promise<QueuedWrite[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    const tx = db.transaction(STORE, 'readonly');
    const rows = await promisifyRequest(tx.objectStore(STORE).getAll() as IDBRequest<QueuedWrite[]>);
    return rows.slice().sort((a, b) => a.queuedAt - b.queuedAt);
  } catch {
    return [];
  }
}

async function removeQueuedWrite(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(id);
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

let draining = false;

/** Replays every queued write against the real API, oldest first, via
 * the caller-supplied `send` function (apiClient.ts's raw `request`,
 * passed in rather than imported directly to avoid a circular
 * import between apiClient.ts and this module — apiClient is the one
 * that imports offlineQueue, not the other way round).
 *
 * A write that succeeds is removed and emits `synced`. A write that
 * fails with a real server response (apiClient's ApiError — validation
 * failure, the record it referenced no longer existing, a permission
 * change since it was queued, etc.) is also removed, but emits
 * `rejected` instead: retrying a definitively-rejected write forever
 * would just fail the same way every time connectivity returns, and
 * silently discarding it without telling anyone would hide a lost
 * edit. A write that fails with anything else (still offline, a
 * transient network error) is left in the queue and stops the drain
 * for this pass — every write after it in queue order is left alone
 * too, since replaying out of order could apply a later edit before an
 * earlier one it may depend on. */
export async function drainQueue(send: (write: QueuedWrite) => Promise<unknown>): Promise<void> {
  if (draining) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  draining = true;

  let syncedCount = 0;
  let rejectedCount = 0;

  try {
    const pending = await listQueuedWrites();
    for (const write of pending) {
      try {
        await send(write);
        await removeQueuedWrite(write.id);
        syncedCount += 1;
        emit({ type: 'synced', write });
      } catch (err) {
        const isServerRejection = err instanceof Error && err.name === 'ApiError';
        if (isServerRejection) {
          await removeQueuedWrite(write.id);
          rejectedCount += 1;
          emit({ type: 'rejected', write, message: err.message });
          continue; // a rejected write doesn't block later independent writes the way a connectivity failure does
        }
        break; // still offline / transient failure — stop here, leave this and everything after it queued
      }
    }
  } finally {
    draining = false;
    if (syncedCount > 0 || rejectedCount > 0) emit({ type: 'drain-complete', syncedCount, rejectedCount });
  }
}

// Fire a drain pass whenever the browser regains connectivity. This is
// the whole sync trigger for v1 — no Background Sync API registration
// (patchy browser support, and needs its own service-worker message
// plumbing to hand the queue over), just the standard `online` event,
// which fires reliably enough for a foreground tab. A drain is also
// attempted once from App.tsx on authenticated mount, to catch writes
// queued in a previous tab session where connectivity was already back
// by the time this tab loaded.
//
// Statically imported despite apiClient.ts also statically importing
// `enqueueWrite` from this file — a genuine circular ES module import,
// but a safe one: both sides only touch the other's export from inside
// a function body (this listener callback; apiClient.ts's
// `postQueueable`/`replay`), never at module-top-level evaluation time,
// so there's no "used before initialized" ordering hazard either
// direction. Confirmed via `npm run build -w apps/web` — Vite/esbuild
// bundles this without incident; a dynamic `import()` here was tried
// first specifically to sidestep the cycle, but Vite's own build output
// pointed out it bought nothing (apiClient.ts is already pulled into
// the same chunk by every other static importer), so it was simplified
// back to a plain import.
import { replayQueuedWrite } from './apiClient';

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void drainQueue(replayQueuedWrite);
  });
}
