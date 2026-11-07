// Closes next-steps item #3 (part) from the Session 9 hardening pass —
// the last of the three files SESSION_LOG.md's next-steps #3 named
// (companyArchiveCache.ts, offlineQueue.ts, formDraftStore.ts). Same
// fake-indexeddb + fresh-module-per-test posture as the other two, for
// the same module-scope `dbPromise` memoization reason.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

async function importFresh() {
  vi.resetModules();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  return import('./formDraftStore');
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('saveDraft / restoreDraftIfAny', () => {
  it('returns undefined when there is no draft for a formId yet', async () => {
    const { restoreDraftIfAny } = await importFresh();

    await expect(restoreDraftIfAny('eod-report')).resolves.toBeUndefined();
  });

  it('round-trips arbitrary draft values for a formId', async () => {
    const { saveDraft, restoreDraftIfAny } = await importFresh();
    const values = { notes: 'in progress', taskIds: ['t1', 't2'], flagged: true };

    await saveDraft('eod-report', values);

    await expect(restoreDraftIfAny('eod-report')).resolves.toEqual(values);
  });

  it('a later save fully replaces the prior draft rather than merging into it', async () => {
    const { saveDraft, restoreDraftIfAny } = await importFresh();

    await saveDraft('eod-report', { notes: 'first', extra: 'field' });
    await saveDraft('eod-report', { notes: 'second' });

    await expect(restoreDraftIfAny('eod-report')).resolves.toEqual({ notes: 'second' });
  });

  it('keeps drafts for different formIds isolated from each other', async () => {
    const { saveDraft, restoreDraftIfAny } = await importFresh();

    await saveDraft('eod-report', { notes: 'eod draft' });
    await saveDraft('leave-request', { reason: 'leave draft' });

    await expect(restoreDraftIfAny('eod-report')).resolves.toEqual({ notes: 'eod draft' });
    await expect(restoreDraftIfAny('leave-request')).resolves.toEqual({ reason: 'leave draft' });
  });
});

describe('clearDraft', () => {
  it('removes a saved draft so a later restore sees nothing', async () => {
    const { saveDraft, restoreDraftIfAny, clearDraft } = await importFresh();

    await saveDraft('eod-report', { notes: 'draft' });
    await clearDraft('eod-report');

    await expect(restoreDraftIfAny('eod-report')).resolves.toBeUndefined();
  });

  it('clearing an unknown formId is a no-op, not a throw', async () => {
    const { clearDraft } = await importFresh();

    await expect(clearDraft('never-saved')).resolves.toBeUndefined();
  });

  it('clearing one formId does not affect another', async () => {
    const { saveDraft, restoreDraftIfAny, clearDraft } = await importFresh();

    await saveDraft('eod-report', { notes: 'eod draft' });
    await saveDraft('leave-request', { reason: 'leave draft' });
    await clearDraft('eod-report');

    await expect(restoreDraftIfAny('eod-report')).resolves.toBeUndefined();
    await expect(restoreDraftIfAny('leave-request')).resolves.toEqual({ reason: 'leave draft' });
  });
});

describe('graceful degrade when IndexedDB is unavailable', () => {
  it('saveDraft/restoreDraftIfAny/clearDraft all no-op instead of throwing', async () => {
    vi.resetModules();
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = undefined;
    const { saveDraft, restoreDraftIfAny, clearDraft } = await import('./formDraftStore');

    await expect(saveDraft('eod-report', { notes: 'x' })).resolves.toBeUndefined();
    await expect(restoreDraftIfAny('eod-report')).resolves.toBeUndefined();
    await expect(clearDraft('eod-report')).resolves.toBeUndefined();

    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });
});
