// Covers the actual sync logic in calendarSyncService.ts, not a
// Postgres integration test (no DB needed — db.js is mocked with an
// in-memory fake that understands just the handful of statements this
// file issues, same "mock the DB-touching half, keep the logic under
// test real" strategy as routes/network.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoogleEvent } from '../services/googleCalendarClient.js';

const SUB_ID = 'sub-1';
const ORG_ID = 'org-1';
const CONNECTION_ID = 'conn-1';

// In-memory state the fake DB client reads/writes — enough to exercise
// incrementalSync's real branching (has a sync_token or not, does the
// upsert land, does a cancelled event get removed) without a real
// Postgres instance.
let subscriptionRow: { id: string; org_id: string; connection_id: string; google_calendar_id: string; sync_token: string | null };
let storedEvents: Map<string, GoogleEvent>;

function makeFakeClient() {
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('select id, org_id, connection_id, google_calendar_id, sync_token')) {
        return { rows: [subscriptionRow] };
      }
      if (sql.includes('select id, org_id, user_id, google_email, refresh_token')) {
        return {
          rows: [
            {
              id: CONNECTION_ID,
              org_id: ORG_ID,
              user_id: 'user-1',
              google_email: 'leader@abion.test',
              refresh_token: 'rt',
              access_token: 'at',
              access_token_expires_at: new Date(Date.now() + 3600_000),
              revoked_at: null,
            },
          ],
        };
      }
      if (sql.startsWith('insert into calendar_events')) {
        const googleEventId = params[2] as string;
        storedEvents.set(googleEventId, { id: googleEventId, status: 'confirmed', summary: params[3] as string } as GoogleEvent);
        return { rows: [] };
      }
      if (sql.startsWith('delete from calendar_events')) {
        const googleEventId = params[1] as string;
        storedEvents.delete(googleEventId);
        return { rows: [] };
      }
      if (sql.startsWith('update calendar_subscriptions set sync_token')) {
        const [nextSyncToken] = params as [string | null, string];
        if (nextSyncToken) subscriptionRow.sync_token = nextSyncToken;
        return { rows: [] };
      }
      if (sql.startsWith('update calendar_subscriptions set sync_token = null')) {
        subscriptionRow.sync_token = null;
        return { rows: [] };
      }
      if (sql.startsWith('update calendar_subscriptions set last_sync_error')) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

vi.mock('../db.js', () => ({
  pool: { query: vi.fn(async () => ({ rows: [] })) },
  withOrgContext: vi.fn(async (_orgId: string, fn: (client: unknown) => unknown) => fn(makeFakeClient())),
}));

vi.mock('../services/calendarTokenService.js', () => ({
  getValidAccessToken: vi.fn(async () => 'fake-access-token'),
}));

const listEventsMock = vi.fn();
vi.mock('../services/googleCalendarClient.js', async () => {
  const actual = await vi.importActual<typeof import('../services/googleCalendarClient.js')>('../services/googleCalendarClient.js');
  return {
    ...actual, // keep the real SyncTokenInvalidError class so `instanceof` checks in the code under test still work
    listEvents: listEventsMock,
    watchCalendar: vi.fn(async () => ({ resourceId: 'res-1', expiration: String(Date.now() + 86_400_000) })),
  };
});

describe('calendarSyncService.incrementalSync', () => {
  beforeEach(() => {
    subscriptionRow = { id: SUB_ID, org_id: ORG_ID, connection_id: CONNECTION_ID, google_calendar_id: 'primary', sync_token: null };
    storedEvents = new Map();
    listEventsMock.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('does a full sync (timeMin, no syncToken) for a brand-new subscription and upserts a confirmed event', async () => {
    listEventsMock.mockResolvedValueOnce({
      events: [{ id: 'evt-1', status: 'confirmed', summary: 'Standup' } as GoogleEvent],
      nextSyncToken: 'token-abc',
    });

    const { incrementalSync } = await import('../services/calendarSyncService.js');
    await incrementalSync(ORG_ID, SUB_ID);

    expect(listEventsMock).toHaveBeenCalledWith(
      'fake-access-token',
      'primary',
      expect.objectContaining({ syncToken: undefined, timeMin: expect.any(String) })
    );
    expect(storedEvents.has('evt-1')).toBe(true);
    expect(subscriptionRow.sync_token).toBe('token-abc');
  });

  it('removes a locally-mirrored event when Google reports it cancelled', async () => {
    subscriptionRow.sync_token = 'existing-token';
    storedEvents.set('evt-2', { id: 'evt-2', status: 'confirmed', summary: 'Old meeting' } as GoogleEvent);

    listEventsMock.mockResolvedValueOnce({
      events: [{ id: 'evt-2', status: 'cancelled' } as GoogleEvent],
      nextSyncToken: 'token-def',
    });

    const { incrementalSync } = await import('../services/calendarSyncService.js');
    await incrementalSync(ORG_ID, SUB_ID);

    expect(listEventsMock).toHaveBeenCalledWith(
      'fake-access-token',
      'primary',
      expect.objectContaining({ syncToken: 'existing-token' })
    );
    expect(storedEvents.has('evt-2')).toBe(false);
  });

  it('clears the sync token and retries as a full sync on a 410 (SyncTokenInvalidError)', async () => {
    subscriptionRow.sync_token = 'stale-token';
    const { SyncTokenInvalidError } = await import('../services/googleCalendarClient.js');

    listEventsMock
      .mockRejectedValueOnce(new SyncTokenInvalidError())
      .mockResolvedValueOnce({ events: [{ id: 'evt-3', status: 'confirmed', summary: 'Recovered' } as GoogleEvent], nextSyncToken: 'token-fresh' });

    const { incrementalSync } = await import('../services/calendarSyncService.js');
    await incrementalSync(ORG_ID, SUB_ID);

    expect(listEventsMock).toHaveBeenCalledTimes(2);
    // First call still carried the (now-invalid) stored token...
    expect(listEventsMock.mock.calls[0]?.[2]).toMatchObject({ syncToken: 'stale-token' });
    // ...and the retry fell back to a full sync (no syncToken, timeMin set instead).
    expect(listEventsMock.mock.calls[1]?.[2]).toMatchObject({ syncToken: undefined });
    expect(storedEvents.has('evt-3')).toBe(true);
    expect(subscriptionRow.sync_token).toBe('token-fresh');
  });
});

describe('calendarSyncService.verifyChannelToken', () => {
  it('accepts a token signed for the given subscription id and rejects any other value', async () => {
    // Re-import fresh so this describe block's module-level state (env
    // var read at import time isn't relevant here, but isolating avoids
    // any cross-test mock bleed) is independent of the sync tests above.
    const { verifyChannelToken } = await import('../services/calendarSyncService.js');
    const crypto = await import('node:crypto');
    const secret = process.env.CALENDAR_WEBHOOK_TOKEN_SECRET || 'dev-only-insecure-secret';
    const validToken = crypto.createHmac('sha256', secret).update(SUB_ID).digest('hex');

    expect(verifyChannelToken(SUB_ID, validToken)).toBe(true);
    expect(verifyChannelToken(SUB_ID, 'not-the-right-token')).toBe(false);
    expect(verifyChannelToken('some-other-subscription', validToken)).toBe(false);
  });
});
