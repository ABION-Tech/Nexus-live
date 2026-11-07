// Closes next-steps item #3 (part) from the Session 9 hardening pass
// (SESSION_LOG.md's "offlineQueue.ts/formDraftStore.ts test coverage —
// Session 49's own next-step #2 — same reason [as companyArchiveCache],
// not this session's scope"). Same fake-indexeddb + fresh-module-per-test
// posture as companyArchiveCache.test.ts, for the same reason: this
// module also memoizes its own module-scope `dbPromise`.
//
// apiClient.ts is mocked out entirely rather than imported for real —
// this module statically imports `replayQueuedWrite` from apiClient.ts
// purely to wire the `window.addEventListener('online', ...)` listener
// (see this file's own header comment on the deliberate circular
// import), and every test here drives `drainQueue` directly with its
// own `send` stub instead, so the real apiClient/fetch stack is neither
// needed nor safe to invoke from a test.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('./apiClient', () => ({
  replayQueuedWrite: vi.fn(),
}));

async function importFresh() {
  vi.resetModules();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  return import('./offlineQueue');
}

function apiError(message: string): Error {
  const err = new Error(message);
  err.name = 'ApiError';
  return err;
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Every test that doesn't care about the online/offline gate should
  // behave as if the browser is online, matching most real sessions.
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('enqueueWrite / listQueuedWrites', () => {
  it('throws if IndexedDB is unavailable — a queued write must not silently vanish', async () => {
    vi.resetModules();
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = undefined;
    const { enqueueWrite } = await import('./offlineQueue');

    await expect(enqueueWrite({ method: 'POST', path: '/tasks', body: {}, kind: 'task' })).rejects.toThrow(
      'Offline storage is unavailable'
    );

    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('adds a write and returns an id that listQueuedWrites can find', async () => {
    const { enqueueWrite, listQueuedWrites } = await importFresh();

    const id = await enqueueWrite({ method: 'POST', path: '/tasks', body: { title: 'x' }, kind: 'task' });
    const all = await listQueuedWrites();

    expect(typeof id).toBe('string');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id, method: 'POST', path: '/tasks', kind: 'task' });
  });

  it('returns queued writes oldest-first regardless of insertion order in storage', async () => {
    const { enqueueWrite, listQueuedWrites } = await importFresh();
    let tick = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (tick += 1));

    await enqueueWrite({ method: 'POST', path: '/a', body: {}, kind: 'a' });
    await enqueueWrite({ method: 'POST', path: '/b', body: {}, kind: 'b' });
    await enqueueWrite({ method: 'POST', path: '/c', body: {}, kind: 'c' });

    const all = await listQueuedWrites();
    expect(all.map((w) => w.path)).toEqual(['/a', '/b', '/c']);
  });

  it('keeps oldest-first order for writes queued within the same millisecond', async () => {
    // Regression: the test above advances Date.now() on every call, which
    // hid that two writes queued in the same ms (two quick offline task
    // creates) tied on queuedAt and fell back to random-UUID key order.
    const { enqueueWrite, listQueuedWrites } = await importFresh();
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    for (const p of ['/1', '/2', '/3', '/4', '/5', '/6']) {
      await enqueueWrite({ method: 'POST', path: p, body: {}, kind: 'k' });
    }

    const all = await listQueuedWrites();
    expect(all.map((w) => w.path)).toEqual(['/1', '/2', '/3', '/4', '/5', '/6']);
  });

  it('returns an empty array, not a throw, when IndexedDB is unavailable', async () => {
    vi.resetModules();
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = undefined;
    const { listQueuedWrites } = await import('./offlineQueue');

    await expect(listQueuedWrites()).resolves.toEqual([]);

    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });
});

describe('drainQueue', () => {
  it('does nothing when the browser reports offline', async () => {
    const { enqueueWrite, drainQueue, listQueuedWrites } = await importFresh();
    await enqueueWrite({ method: 'POST', path: '/tasks', body: {}, kind: 'task' });
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

    const send = vi.fn();
    await drainQueue(send);

    expect(send).not.toHaveBeenCalled();
    await expect(listQueuedWrites()).resolves.toHaveLength(1);
  });

  it('removes and emits "synced" for a write the server accepts', async () => {
    const { enqueueWrite, drainQueue, listQueuedWrites, subscribeToQueueEvents } = await importFresh();
    const id = await enqueueWrite({ method: 'POST', path: '/tasks', body: {}, kind: 'task' });
    const events: unknown[] = [];
    const unsubscribe = subscribeToQueueEvents((e) => events.push(e));

    const send = vi.fn().mockResolvedValue({ ok: true });
    await drainQueue(send);

    expect(send).toHaveBeenCalledTimes(1);
    await expect(listQueuedWrites()).resolves.toEqual([]);
    expect(events).toEqual([
      { type: 'synced', write: expect.objectContaining({ id }) },
      { type: 'drain-complete', syncedCount: 1, rejectedCount: 0 },
    ]);
    unsubscribe();
  });

  it('removes and emits "rejected" for a write the server definitively rejects (ApiError) — does not retry it', async () => {
    const { enqueueWrite, drainQueue, listQueuedWrites, subscribeToQueueEvents } = await importFresh();
    await enqueueWrite({ method: 'POST', path: '/tasks', body: {}, kind: 'task' });
    const events: unknown[] = [];
    subscribeToQueueEvents((e) => events.push(e));

    const send = vi.fn().mockRejectedValue(apiError('validation failed'));
    await drainQueue(send);

    await expect(listQueuedWrites()).resolves.toEqual([]);
    expect(events).toEqual([
      { type: 'rejected', write: expect.anything(), message: 'validation failed' },
      { type: 'drain-complete', syncedCount: 0, rejectedCount: 1 },
    ]);
  });

  it('leaves a write queued (and does not attempt anything after it) on a transient/non-ApiError failure', async () => {
    const { enqueueWrite, drainQueue, listQueuedWrites } = await importFresh();
    let tick = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (tick += 1));
    await enqueueWrite({ method: 'POST', path: '/first', body: {}, kind: 'a' });
    await enqueueWrite({ method: 'POST', path: '/second', body: {}, kind: 'b' });

    const send = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await drainQueue(send);

    // Only the first (failing) write is attempted — order matters, since
    // replaying out of order could apply a later edit before an earlier
    // one it may depend on.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ path: '/first' }));
    const remaining = await listQueuedWrites();
    expect(remaining.map((w) => w.path)).toEqual(['/first', '/second']);
  });

  it('processes independent writes after a rejected one, but stops entirely after a transient failure', async () => {
    const { enqueueWrite, drainQueue, listQueuedWrites } = await importFresh();
    let tick = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (tick += 1));
    await enqueueWrite({ method: 'POST', path: '/rejected', body: {}, kind: 'a' });
    await enqueueWrite({ method: 'POST', path: '/synced', body: {}, kind: 'b' });
    await enqueueWrite({ method: 'POST', path: '/never-reached', body: {}, kind: 'c' });

    const send = vi
      .fn()
      .mockRejectedValueOnce(apiError('bad request'))
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new TypeError('offline'));

    await drainQueue(send);

    expect(send).toHaveBeenCalledTimes(3);
    const remaining = await listQueuedWrites();
    expect(remaining.map((w) => w.path)).toEqual(['/never-reached']);
  });

  it('does not emit drain-complete when there was nothing queued to process', async () => {
    const { drainQueue, subscribeToQueueEvents } = await importFresh();
    const events: unknown[] = [];
    subscribeToQueueEvents((e) => events.push(e));

    await drainQueue(vi.fn());

    expect(events).toEqual([]);
  });

  it('is re-entrancy guarded — a drain already in flight ignores an overlapping call', async () => {
    const { enqueueWrite, drainQueue, listQueuedWrites } = await importFresh();
    await enqueueWrite({ method: 'POST', path: '/only', body: {}, kind: 'a' });

    let releaseFirstSend!: () => void;
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    const send = vi.fn().mockImplementation(async () => {
      await firstSendGate;
      return { ok: true };
    });

    const firstDrain = drainQueue(send);
    const secondDrain = drainQueue(send); // should see `draining === true` and return immediately

    releaseFirstSend();
    await Promise.all([firstDrain, secondDrain]);

    expect(send).toHaveBeenCalledTimes(1);
    await expect(listQueuedWrites()).resolves.toEqual([]);
  });
});
