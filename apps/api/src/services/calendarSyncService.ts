// The actual sync engine behind CalendarService. Three jobs live here,
// deliberately kept together because they all revolve around the same
// state machine (a subscription's sync_token / channel_id):
//  1. incrementalSync — pull changes from Google, mirror them locally.
//  2. webhook channel lifecycle — register/stop Google push notifications
//     so incrementalSync can be triggered in near-real-time instead of
//     only on a polling cadence.
//  3. the reconciliation sweep — Google does not guarantee webhook
//     delivery, so a periodic full pass over every active subscription is
//     the safety net, not an optional extra.
import crypto from 'node:crypto';
import { pool, withOrgContext } from '../db.js';
import {
  listEvents,
  watchCalendar,
  stopChannel,
  SyncTokenInvalidError,
  type GoogleEvent,
} from './googleCalendarClient.js';
import { getValidAccessToken, ConnectionRevokedError, type CalendarConnectionRow } from './calendarTokenService.js';

interface SubscriptionSyncRow {
  id: string;
  org_id: string;
  connection_id: string;
  google_calendar_id: string;
  sync_token: string | null;
}

function eventDateFields(event: GoogleEvent): {
  allDay: boolean;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  endDate: string | null;
} {
  const allDay = Boolean(event.start?.date);
  return {
    allDay,
    startAt: allDay ? null : event.start?.dateTime ?? null,
    endAt: allDay ? null : event.end?.dateTime ?? null,
    startDate: allDay ? event.start?.date ?? null : null,
    endDate: allDay ? event.end?.date ?? null : null,
  };
}

async function upsertMirroredEvent(orgId: string, subscriptionId: string, event: GoogleEvent): Promise<void> {
  const { allDay, startAt, endAt, startDate, endDate } = eventDateFields(event);
  await withOrgContext(orgId, (client) =>
    client.query(
      `insert into calendar_events
         (org_id, subscription_id, google_event_id, title, description, location, all_day,
          start_at, end_at, start_date, end_date, status, html_link, attendees, google_updated_at, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
       on conflict (subscription_id, google_event_id) do update set
         title = excluded.title, description = excluded.description, location = excluded.location,
         all_day = excluded.all_day, start_at = excluded.start_at, end_at = excluded.end_at,
         start_date = excluded.start_date, end_date = excluded.end_date, status = excluded.status,
         html_link = excluded.html_link, attendees = excluded.attendees,
         google_updated_at = excluded.google_updated_at, synced_at = now()`,
      [
        orgId, subscriptionId, event.id, event.summary ?? null, event.description ?? null, event.location ?? null, allDay,
        startAt, endAt, startDate, endDate, event.status, event.htmlLink ?? null,
        event.attendees ? JSON.stringify(event.attendees) : null, event.updated ?? null,
      ]
    )
  );
}

async function removeMirroredEvent(orgId: string, subscriptionId: string, googleEventId: string): Promise<void> {
  await withOrgContext(orgId, (client) =>
    client.query(`delete from calendar_events where subscription_id = $1 and google_event_id = $2`, [subscriptionId, googleEventId])
  );
}

async function loadSubscription(orgId: string, subscriptionId: string): Promise<SubscriptionSyncRow> {
  const row = await withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<SubscriptionSyncRow>(
      `select id, org_id, connection_id, google_calendar_id, sync_token
         from calendar_subscriptions where id = $1 and org_id = $2 and is_active`,
      [subscriptionId, orgId]
    );
    return rows[0];
  });
  if (!row) throw new Error(`Calendar subscription ${subscriptionId} not found or inactive.`);
  return row;
}

async function loadConnection(orgId: string, connectionId: string): Promise<CalendarConnectionRow> {
  const row = await withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<CalendarConnectionRow>(
      `select id, org_id, user_id, google_email, refresh_token, access_token, access_token_expires_at, revoked_at
         from calendar_connections where id = $1`,
      [connectionId]
    );
    return rows[0];
  });
  if (!row) throw new Error(`Calendar connection ${connectionId} not found.`);
  return row;
}

async function fetchPage(accessToken: string, calendarId: string, syncToken: string | null) {
  return listEvents(accessToken, calendarId, {
    syncToken: syncToken ?? undefined,
    // Only relevant on a full sync (no syncToken) — bound how far back we
    // mirror so a years-old calendar doesn't get pulled in wholesale on
    // first connect. 90 days matches task_trends' own self-prune window
    // (PRD §12) as a "recent operational history" convention, not a hard
    // Google requirement.
    timeMin: syncToken ? undefined : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
  });
}

/** Pulls whatever changed since the subscription's stored sync_token
 * (or, for a brand-new subscription, everything from the last 90 days)
 * and mirrors it into `calendar_events`. On a 410 (SyncTokenInvalidError
 * — Google's signal that the token expired or the calendar was reset)
 * this clears the stored token and retries once as a full sync; any
 * other failure is recorded on the subscription row via
 * `last_sync_error` and rethrown, so a caller driving several
 * subscriptions (the reconciliation sweep) can catch-and-continue rather
 * than one bad calendar aborting the whole pass. */
export async function incrementalSync(orgId: string, subscriptionId: string): Promise<{ eventCount: number }> {
  const subscription = await loadSubscription(orgId, subscriptionId);
  const connection = await loadConnection(orgId, subscription.connection_id);

  try {
    const accessToken = await getValidAccessToken(orgId, connection);

    let result;
    try {
      result = await fetchPage(accessToken, subscription.google_calendar_id, subscription.sync_token);
    } catch (err) {
      if (!(err instanceof SyncTokenInvalidError)) throw err;
      // Persist the invalidation before retrying — if the retry itself
      // throws, the next attempt still knows not to reuse the dead token.
      await withOrgContext(orgId, (client) =>
        client.query(`update calendar_subscriptions set sync_token = null where id = $1`, [subscription.id])
      );
      result = await fetchPage(accessToken, subscription.google_calendar_id, null);
    }

    for (const event of result.events) {
      if (event.status === 'cancelled') {
        await removeMirroredEvent(orgId, subscription.id, event.id);
      } else {
        await upsertMirroredEvent(orgId, subscription.id, event);
      }
    }

    await withOrgContext(orgId, (client) =>
      client.query(
        `update calendar_subscriptions set sync_token = $1, last_synced_at = now(), last_sync_error = null where id = $2`,
        [result.nextSyncToken ?? subscription.sync_token, subscription.id]
      )
    );

    await maybeRegisterChannel(orgId, subscription.id);

    return { eventCount: result.events.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withOrgContext(orgId, (client) =>
      client.query(`update calendar_subscriptions set last_sync_error = $1 where id = $2`, [message, subscription.id])
    ).catch(() => {
      // Don't let a failure to *record* the failure mask the original error.
    });
    if (err instanceof ConnectionRevokedError) throw err;
    throw err;
  }
}

// ---------------------------------------------------------------------
// Webhook channel lifecycle
// ---------------------------------------------------------------------

/** Registers a Google push-notification channel for a subscription that
 * doesn't have one yet. No-op unless CALENDAR_WEBHOOK_BASE_URL is set —
 * that variable is only meaningful once the API has a public HTTPS
 * origin, so local dev (and this file's own tests) simply never
 * registers a channel and relies on the reconciliation sweep / manual
 * "sync now" instead. Channels also expire (Google's max is ~30 days for
 * calendar resources) — this same function is safe to call repeatedly;
 * it only acts when channel_id is still unset, so a scheduled
 * "resubscribe channels expiring soon" job (not built yet — flagged as a
 * follow-up, not part of this file's contract) would first clear
 * channel_id on rows nearing channel_expires_at, then rely on this. */
async function maybeRegisterChannel(orgId: string, subscriptionId: string): Promise<void> {
  const baseUrl = process.env.CALENDAR_WEBHOOK_BASE_URL;
  if (!baseUrl) return;

  const existing = await withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ channel_id: string | null; connection_id: string; google_calendar_id: string }>(
      `select channel_id, connection_id, google_calendar_id from calendar_subscriptions where id = $1`,
      [subscriptionId]
    );
    return rows[0];
  });
  if (!existing || existing.channel_id) return;

  const connection = await loadConnection(orgId, existing.connection_id);
  const accessToken = await getValidAccessToken(orgId, connection);

  const channelId = crypto.randomUUID();
  const token = signChannelToken(subscriptionId);
  const address = `${baseUrl.replace(/\/$/, '')}/api/v1/calendar/webhook`;

  const watch = await watchCalendar(accessToken, existing.google_calendar_id, channelId, address, token);

  await withOrgContext(orgId, (client) =>
    client.query(
      `update calendar_subscriptions set channel_id = $1, resource_id = $2, channel_expires_at = to_timestamp($3::bigint / 1000.0) where id = $4`,
      [channelId, watch.resourceId, watch.expiration, subscriptionId]
    )
  );
}

interface SubscriptionChannelRef {
  id: string;
  connection_id: string;
  channel_id: string | null;
  resource_id: string | null;
}

/** Stops a subscription's webhook channel, if it has one. Called both
 * when a single subscription is removed (calendarService.removeSubscription)
 * and, in a loop, when an entire connection is disconnected
 * (calendarService.disconnectConnection). Swallows "channel already
 * gone" failures — Google 404s on a stop for an already-expired channel,
 * and by the time this runs the caller is already committed to tearing
 * the subscription down regardless. */
export async function stopSubscriptionChannel(orgId: string, sub: SubscriptionChannelRef): Promise<void> {
  if (!sub.channel_id || !sub.resource_id) return;

  try {
    const connection = await loadConnection(orgId, sub.connection_id);
    const accessToken = await getValidAccessToken(orgId, connection);
    await stopChannel(accessToken, sub.channel_id, sub.resource_id);
  } catch {
    // Best-effort — see doc comment above.
  }

  await withOrgContext(orgId, (client) =>
    client.query(`update calendar_subscriptions set channel_id = null, resource_id = null, channel_expires_at = null where id = $1`, [sub.id])
  ).catch(() => {});
}

// ---------------------------------------------------------------------
// Channel token signing/verification
// ---------------------------------------------------------------------

function webhookSecret(): string {
  // Same "usable default in dev, required-looking in prod" shape as
  // COOKIE_SECRET — Fastify's cookie plugin already enforces a real
  // secret in production (server.ts); this one isn't wired through a
  // plugin, so the fallback exists purely so local dev / tests don't
  // need CALENDAR_WEBHOOK_TOKEN_SECRET set. Set a real value in .env for
  // any deployment that actually registers channels.
  return process.env.CALENDAR_WEBHOOK_TOKEN_SECRET || 'dev-only-insecure-secret';
}

function signChannelToken(subscriptionId: string): string {
  return crypto.createHmac('sha256', webhookSecret()).update(subscriptionId).digest('hex');
}

/** Verifies that an incoming webhook's `X-Goog-Channel-Token` header
 * matches the token this subscription's channel was registered with.
 * Google echoes back exactly what we set as `token` in watchCalendar's
 * request — this is what stops an attacker who guesses/enumerates a
 * channel_id from triggering a sync for a subscription they don't own;
 * the token is never transmitted anywhere else a request could observe
 * it (no query string, no session). */
export function verifyChannelToken(subscriptionId: string, token: string): boolean {
  const expected = signChannelToken(subscriptionId);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(token, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// ---------------------------------------------------------------------
// Cross-org lookups — resolve identity before org context exists
// (0012_calendar.sql's find_subscription_by_channel_id /
// list_active_subscriptions_for_sync), same shape as sessionService's
// use of find_user_by_email. Both go through the raw `pool`, never
// withOrgContext — there is no org to scope to yet, that's the entire
// point of these two calls.
// ---------------------------------------------------------------------

export interface ResolvedChannelSubscription {
  id: string;
  orgId: string;
  connectionId: string;
  googleCalendarId: string;
}

/** Used by routes/calendarWebhook.ts to turn Google's `X-Goog-Channel-Id`
 * header into an org_id + subscription_id. Returns null for an unknown
 * or since-deactivated channel — the route treats that as "ack and
 * ignore" (Google retries webhooks; a stale channel we no longer care
 * about is not an error worth surfacing). */
export async function resolveSubscriptionByChannelId(channelId: string): Promise<ResolvedChannelSubscription | null> {
  const { rows } = await pool.query<{ id: string; org_id: string; connection_id: string; google_calendar_id: string }>(
    `select * from find_subscription_by_channel_id($1)`,
    [channelId]
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, orgId: row.org_id, connectionId: row.connection_id, googleCalendarId: row.google_calendar_id };
}

export interface ReconciliationResult {
  subscriptionId: string;
  orgId: string;
  ok: boolean;
  error?: string;
}

/** The reconciliation safety-net sweep (routes/calendarMaintenance.ts,
 * shared-secret cron/n8n trigger — PRD §10.6's automation shape, not a
 * publicly reachable endpoint). Google does not guarantee webhook
 * delivery, so this exists to catch anything a missed notification would
 * have caught; it's also simply the only sync mechanism at all for
 * subscriptions where CALENDAR_WEBHOOK_BASE_URL was unset when they were
 * created. Continues past individual subscription failures — one org's
 * revoked connection must not stop every other org's sync. */
export async function reconcileAllSubscriptions(): Promise<ReconciliationResult[]> {
  const { rows } = await pool.query<{ id: string; org_id: string }>(`select * from list_active_subscriptions_for_sync()`);

  const results: ReconciliationResult[] = [];
  for (const row of rows) {
    try {
      await incrementalSync(row.org_id, row.id);
      results.push({ subscriptionId: row.id, orgId: row.org_id, ok: true });
    } catch (err) {
      results.push({ subscriptionId: row.id, orgId: row.org_id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

// ---------------------------------------------------------------------
// Channel renewal sweep
// ---------------------------------------------------------------------

export interface ChannelRenewalResult {
  subscriptionId: string;
  orgId: string;
  ok: boolean;
  error?: string;
}

/** Renews Google push-notification channels that are within 48 hours of
 * expiry. Called by routes/calendarMaintenance.ts's /renew-channels
 * endpoint on a scheduler-driven cadence (n8n or cron — daily is fine,
 * since channels live ~30 days and we sweep 48 hours ahead).
 *
 * Protocol per subscription:
 *  1. NULL out channel_id/resource_id/channel_expires_at so the row
 *     looks "unregistered" to maybeRegisterChannel's guard.
 *  2. Call maybeRegisterChannel — it re-registers a fresh channel and
 *     writes the new channel_id/resource_id/channel_expires_at back.
 *
 * The two-step approach (clear then re-register) avoids having to call
 * Google's channels.stop first: the old channel will expire on its own,
 * and the new channel_id is unique (0036's partial unique index enforces
 * this) so there is no collision. stopSubscriptionChannel is NOT called
 * here — that function is for deliberate teardown (removeSubscription /
 * disconnectConnection), not for renewal; calling it here would trigger
 * a Google API round-trip for a channel we're about to replace anyway.
 *
 * Continues past individual failures — same rationale as
 * reconcileAllSubscriptions. */
export async function renewExpiringChannels(): Promise<ChannelRenewalResult[]> {
  const { rows } = await pool.query<{ id: string; org_id: string; connection_id: string }>(
    `select * from list_expiring_channel_subscriptions()`
  );

  const results: ChannelRenewalResult[] = [];
  for (const row of rows) {
    try {
      // Step 1 — clear the stale channel registration so
      // maybeRegisterChannel's "already has one, bail" guard doesn't fire.
      await withOrgContext(row.org_id, (client) =>
        client.query(
          `update calendar_subscriptions
              set channel_id = null, resource_id = null, channel_expires_at = null
            where id = $1`,
          [row.id]
        )
      );

      // Step 2 — re-register a fresh channel (no-op if
      // CALENDAR_WEBHOOK_BASE_URL is unset, same as the initial
      // registration path — the reconciliation sweep continues to
      // cover those subscriptions).
      await maybeRegisterChannel(row.org_id, row.id);

      results.push({ subscriptionId: row.id, orgId: row.org_id, ok: true });
    } catch (err) {
      results.push({
        subscriptionId: row.id,
        orgId: row.org_id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
