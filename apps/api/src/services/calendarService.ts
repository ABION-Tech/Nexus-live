import { withOrgContext } from '../db.js';
import { listCalendars, insertEvent, updateEvent as googleUpdateEvent, deleteEvent as googleDeleteEvent } from './googleCalendarClient.js';
import { getValidAccessToken } from './calendarTokenService.js';
import { incrementalSync, stopSubscriptionChannel } from './calendarSyncService.js';
import { revokeToken } from './calendarOAuthService.js';
import type {
  CalendarConnection,
  CalendarEvent,
  CalendarEventInput,
  CalendarSubscription,
  GoogleCalendarListEntry,
} from '@nexus/shared';

function firstOrThrow<T>(row: T | undefined, message: string): T {
  if (!row) throw new Error(message);
  return row;
}

interface ConnectionRow {
  id: string;
  org_id: string;
  user_id: string;
  google_email: string;
  refresh_token: string;
  access_token: string | null;
  access_token_expires_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}

function toConnection(row: ConnectionRow): CalendarConnection {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    googleEmail: row.google_email,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString(),
  };
}

/** Leaders (or anyone with a `calendar.read` grant) see every
 * connection in the org, for management/visibility; everyone else sees
 * only their own — same "own record unless a flat grant says
 * otherwise" shape as tasks.ts's OWN_UPDATE_FIELDS caller. */
export async function listConnections(orgId: string, userId: string, canSeeAll: boolean): Promise<CalendarConnection[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<ConnectionRow>(
      canSeeAll
        ? `select * from calendar_connections where org_id = $1 and revoked_at is null order by created_at`
        : `select * from calendar_connections where org_id = $1 and user_id = $2 and revoked_at is null order by created_at`,
      canSeeAll ? [orgId] : [orgId, userId]
    );
    return rows.map(toConnection);
  });
}

export async function getConnectionForUser(orgId: string, connectionId: string, userId: string, canSeeAll: boolean): Promise<ConnectionRow | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<ConnectionRow>(
      `select * from calendar_connections where id = $1 and org_id = $2 and revoked_at is null`,
      [connectionId, orgId]
    );
    const row = rows[0];
    if (!row) return null;
    if (!canSeeAll && row.user_id !== userId) return null;
    return row;
  });
}

export async function upsertConnection(
  orgId: string,
  userId: string,
  identity: { email: string; sub: string; refreshToken: string; accessToken: string; accessTokenExpiresAt: Date; scopes: string }
): Promise<CalendarConnection> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<ConnectionRow>(
      `insert into calendar_connections (org_id, user_id, google_email, google_sub, refresh_token, access_token, access_token_expires_at, scopes)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (org_id, user_id, google_sub) do update set
         google_email = excluded.google_email, refresh_token = excluded.refresh_token,
         access_token = excluded.access_token, access_token_expires_at = excluded.access_token_expires_at,
         scopes = excluded.scopes, revoked_at = null
       returning *`,
      [orgId, userId, identity.email, identity.sub, identity.refreshToken, identity.accessToken, identity.accessTokenExpiresAt, identity.scopes]
    );
    return toConnection(firstOrThrow(rows[0], 'Failed to upsert calendar connection.'));
  });
}

export async function listAvailableCalendars(orgId: string, connection: ConnectionRow): Promise<GoogleCalendarListEntry[]> {
  const accessToken = await getValidAccessToken(orgId, connection);
  const calendars = await listCalendars(accessToken);
  return calendars.map((c) => ({ id: c.id, summary: c.summary, primary: c.primary, accessRole: c.accessRole }));
}

/** Disconnects a Google account entirely: stops every active
 * subscription's webhook channel, revokes the token with Google
 * (best-effort), then marks the connection (and its subscriptions)
 * revoked. Subscriptions are marked inactive rather than deleted so
 * their local calendar_events mirror + history survives — reconnecting
 * later re-adds a subscription, it doesn't need to rediscover it was
 * ever synced before. */
export async function disconnectConnection(orgId: string, connection: ConnectionRow): Promise<void> {
  const subs = await withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ id: string; connection_id: string; channel_id: string | null; resource_id: string | null }>(
      `select id, connection_id, channel_id, resource_id from calendar_subscriptions where connection_id = $1 and is_active`,
      [connection.id]
    );
    return rows;
  });

  for (const sub of subs) {
    await stopSubscriptionChannel(orgId, sub);
  }

  await withOrgContext(orgId, (client) =>
    client.query(`update calendar_subscriptions set is_active = false, revoked_at = now() where connection_id = $1`, [connection.id])
  );
  await withOrgContext(orgId, (client) =>
    client.query(`update calendar_connections set revoked_at = now() where id = $1`, [connection.id])
  );

  await revokeToken(connection.refresh_token);
}

interface SubscriptionRow {
  id: string;
  org_id: string;
  connection_id: string;
  google_calendar_id: string;
  calendar_name: string;
  added_by_user_id: string | null;
  is_active: boolean;
  last_synced_at: Date | null;
  last_sync_error: string | null;
  created_at: Date;
  connection_email: string;
  channel_id: string | null;
  resource_id: string | null;
}

function toSubscription(row: SubscriptionRow): CalendarSubscription {
  return {
    id: row.id,
    orgId: row.org_id,
    connectionId: row.connection_id,
    connectionEmail: row.connection_email,
    googleCalendarId: row.google_calendar_id,
    calendarName: row.calendar_name,
    isActive: row.is_active,
    lastSyncedAt: row.last_synced_at?.toISOString(),
    lastSyncError: row.last_sync_error ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listSubscriptions(orgId: string, userId: string, canSeeAll: boolean): Promise<CalendarSubscription[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<SubscriptionRow>(
      `select s.*, c.google_email as connection_email
         from calendar_subscriptions s
         join calendar_connections c on c.id = s.connection_id
        where s.org_id = $1 and s.is_active
          and (${canSeeAll ? 'true' : 'c.user_id = $2'})
        order by s.created_at`,
      canSeeAll ? [orgId] : [orgId, userId]
    );
    return rows.map(toSubscription);
  });
}

export async function createSubscription(
  orgId: string,
  connection: ConnectionRow,
  googleCalendarId: string,
  calendarName: string,
  addedByUserId: string
): Promise<CalendarSubscription> {
  const row = await withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<SubscriptionRow>(
      `insert into calendar_subscriptions (org_id, connection_id, google_calendar_id, calendar_name, added_by_user_id)
       values ($1,$2,$3,$4,$5)
       returning *, (select google_email from calendar_connections where id = $2) as connection_email`,
      [orgId, connection.id, googleCalendarId, calendarName, addedByUserId]
    );
    if (!rows[0]) throw new Error('Failed to create calendar subscription.');
    return rows[0];
  });

  // Initial full sync runs synchronously so the caller sees real data
  // (or a real error) immediately rather than an empty calendar that
  // silently fills in later — same "no hollow placeholder" standard
  // this integration was scoped to in the first place.
  await incrementalSync(orgId, row.id);

  return toSubscription(row);
}

export async function getSubscription(orgId: string, id: string): Promise<SubscriptionRow | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<SubscriptionRow>(
      `select s.*, c.google_email as connection_email
         from calendar_subscriptions s join calendar_connections c on c.id = s.connection_id
        where s.id = $1 and s.org_id = $2 and s.is_active`,
      [id, orgId]
    );
    return rows[0] ?? null;
  });
}

export async function removeSubscription(orgId: string, sub: SubscriptionRow): Promise<void> {
  await stopSubscriptionChannel(orgId, sub);
  await withOrgContext(orgId, (client) =>
    client.query(`update calendar_subscriptions set is_active = false, revoked_at = now() where id = $1`, [sub.id])
  );
}

interface EventRow {
  id: string;
  org_id: string;
  subscription_id: string;
  google_event_id: string;
  title: string | null;
  description: string | null;
  location: string | null;
  all_day: boolean;
  start_at: Date | null;
  end_at: Date | null;
  start_date: string | null;
  end_date: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  html_link: string | null;
  attendees: { email: string; displayName?: string; responseStatus?: string }[] | null;
  created_by_user_id: string | null;
  calendar_name: string;
}

function toEvent(row: EventRow): CalendarEvent {
  return {
    id: row.id,
    orgId: row.org_id,
    subscriptionId: row.subscription_id,
    calendarName: row.calendar_name,
    googleEventId: row.google_event_id,
    title: row.title ?? '(untitled event)',
    description: row.description ?? undefined,
    location: row.location ?? undefined,
    allDay: row.all_day,
    startAt: row.start_at?.toISOString(),
    endAt: row.end_at?.toISOString(),
    startDate: row.start_date ?? undefined,
    endDate: row.end_date ?? undefined,
    status: row.status,
    htmlLink: row.html_link ?? undefined,
    attendees: row.attendees ?? undefined,
    createdByNexus: row.created_by_user_id !== null,
  };
}

/** Lists the merged agenda across every synced calendar the caller can
 * see, in [from, to). Scoping mirrors subscriptions: a flat
 * `calendar.read` grant (or leader) sees the whole org's synced
 * calendars; otherwise only calendars synced under the caller's own
 * connections. */
export async function listEventsInRange(
  orgId: string,
  userId: string,
  canSeeAll: boolean,
  from: string,
  to: string
): Promise<CalendarEvent[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<EventRow>(
      `select e.*, s.calendar_name
         from calendar_events e
         join calendar_subscriptions s on s.id = e.subscription_id
         join calendar_connections c on c.id = s.connection_id
        where e.org_id = $1
          and s.is_active
          and e.status <> 'cancelled'
          and coalesce(e.start_at, e.start_date::timestamptz) < $3
          and coalesce(e.end_at, (e.end_date::timestamptz + interval '1 day')) >= $2
          and (${canSeeAll ? 'true' : 'c.user_id = $4'})
        order by coalesce(e.start_at, e.start_date::timestamptz)`,
      canSeeAll ? [orgId, from, to] : [orgId, from, to, userId]
    );
    return rows.map(toEvent);
  });
}

function toGoogleDateTime(startAt?: string, startDate?: string): { date?: string; dateTime?: string } {
  return startDate ? { date: startDate } : { dateTime: startAt };
}

/** Write-back create: inserts on Google first (Google is the source of
 * truth an event's own id comes from), then mirrors the response
 * locally — same "call the provider, then store what it actually
 * returned" shape as googleOAuthService's identity flow, so the local
 * row never drifts from what Google actually accepted. */
export async function createEvent(orgId: string, sub: SubscriptionRow, userId: string, input: CalendarEventInput): Promise<CalendarEvent> {
  const connection = await withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<ConnectionRow>(`select * from calendar_connections where id = $1`, [sub.connection_id]);
    return firstOrThrow(rows[0], 'Calendar connection not found.');
  });
  const accessToken = await getValidAccessToken(orgId, connection);

  const googleEvent = await insertEvent(accessToken, sub.google_calendar_id, {
    summary: input.title,
    description: input.description,
    location: input.location,
    start: toGoogleDateTime(input.startAt, input.startDate),
    end: toGoogleDateTime(input.endAt, input.endDate),
    attendees: input.attendeeEmails?.map((email) => ({ email })),
  });

  const row = await withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<EventRow>(
      `insert into calendar_events
         (org_id, subscription_id, google_event_id, title, description, location, all_day,
          start_at, end_at, start_date, end_date, status, html_link, attendees, google_updated_at, created_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       returning *, (select calendar_name from calendar_subscriptions where id = $2) as calendar_name`,
      [
        orgId, sub.id, googleEvent.id, googleEvent.summary ?? input.title, googleEvent.description ?? null,
        googleEvent.location ?? null, input.allDay,
        input.allDay ? null : googleEvent.start?.dateTime ?? null,
        input.allDay ? null : googleEvent.end?.dateTime ?? null,
        input.allDay ? googleEvent.start?.date ?? null : null,
        input.allDay ? googleEvent.end?.date ?? null : null,
        googleEvent.status, googleEvent.htmlLink ?? null,
        googleEvent.attendees ? JSON.stringify(googleEvent.attendees) : null,
        googleEvent.updated ?? null, userId,
      ]
    );
    return firstOrThrow(rows[0], 'Failed to create calendar event.');
  });

  return toEvent(row);
}

export async function getEventForWriteBack(orgId: string, eventId: string): Promise<{ event: EventRow; subscription: SubscriptionRow } | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<EventRow & { sub_id: string; connection_id: string; google_calendar_id: string; calendar_name: string }>(
      `select e.*, s.id as sub_id, s.connection_id, s.google_calendar_id, s.calendar_name
         from calendar_events e join calendar_subscriptions s on s.id = e.subscription_id
        where e.id = $1 and e.org_id = $2 and s.is_active`,
      [eventId, orgId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      event: row,
      subscription: {
        id: row.sub_id,
        org_id: orgId,
        connection_id: row.connection_id,
        google_calendar_id: row.google_calendar_id,
        calendar_name: row.calendar_name,
        added_by_user_id: null,
        is_active: true,
        last_synced_at: null,
        last_sync_error: null,
        created_at: new Date(),
        connection_email: '',
        channel_id: null,
        resource_id: null,
      },
    };
  });
}

export async function updateEvent(orgId: string, found: { event: EventRow; subscription: SubscriptionRow }, input: Partial<CalendarEventInput>): Promise<CalendarEvent> {
  const { event, subscription } = found;
  const connection = await withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<ConnectionRow>(`select * from calendar_connections where id = $1`, [subscription.connection_id]);
    return firstOrThrow(rows[0], 'Calendar connection not found.');
  });
  const accessToken = await getValidAccessToken(orgId, connection);

  const allDay = input.allDay ?? event.all_day;
  const googleEvent = await googleUpdateEvent(accessToken, subscription.google_calendar_id, event.google_event_id, {
    summary: input.title ?? event.title ?? '',
    description: input.description ?? event.description ?? undefined,
    location: input.location ?? event.location ?? undefined,
    start: toGoogleDateTime(
      input.startAt ?? event.start_at?.toISOString(),
      input.startDate ?? event.start_date ?? undefined
    ),
    end: toGoogleDateTime(input.endAt ?? event.end_at?.toISOString(), input.endDate ?? event.end_date ?? undefined),
    attendees: input.attendeeEmails?.map((email) => ({ email })) ?? event.attendees?.map((a) => ({ email: a.email })),
  });

  const row = await withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<EventRow>(
      `update calendar_events set
         title = $1, description = $2, location = $3, all_day = $4,
         start_at = $5, end_at = $6, start_date = $7, end_date = $8,
         status = $9, attendees = $10, google_updated_at = $11, synced_at = now()
       where id = $12
       returning *, (select calendar_name from calendar_subscriptions where id = subscription_id)`,
      [
        googleEvent.summary ?? event.title, googleEvent.description ?? null, googleEvent.location ?? null, allDay,
        allDay ? null : googleEvent.start?.dateTime ?? null, allDay ? null : googleEvent.end?.dateTime ?? null,
        allDay ? googleEvent.start?.date ?? null : null, allDay ? googleEvent.end?.date ?? null : null,
        googleEvent.status, googleEvent.attendees ? JSON.stringify(googleEvent.attendees) : null,
        googleEvent.updated ?? null, event.id,
      ]
    );
    return firstOrThrow(rows[0], 'Failed to update calendar event.');
  });

  return toEvent(row);
}

export async function deleteEvent(orgId: string, found: { event: EventRow; subscription: SubscriptionRow }): Promise<void> {
  const { event, subscription } = found;
  const connection = await withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<ConnectionRow>(`select * from calendar_connections where id = $1`, [subscription.connection_id]);
    return firstOrThrow(rows[0], 'Calendar connection not found.');
  });
  const accessToken = await getValidAccessToken(orgId, connection);

  await googleDeleteEvent(accessToken, subscription.google_calendar_id, event.google_event_id);
  await withOrgContext(orgId, (client) => client.query(`delete from calendar_events where id = $1`, [event.id]));
}
