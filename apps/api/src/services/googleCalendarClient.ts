// Thin REST wrapper around Google Calendar v3 — plain fetch, deliberately
// not the `googleapis` package (that pulls in a large dependency tree for
// a handful of endpoints we actually call: calendarList.list, events.list
// with sync tokens, events.insert/update/delete, events.watch/stop). Same
// "no new heavy dependency" call as webPushProvider.ts's plain web-push
// use. Every function here takes an already-valid access token — token
// refresh lives entirely in calendarTokenService.ts, this file doesn't
// know a refresh token exists.
const BASE = 'https://www.googleapis.com/calendar/v3';

async function googleFetch<T>(url: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (res.status === 410) {
    // Google's documented signal that a stored sync token is no longer
    // valid (expired, or the calendar was reset) — the caller must
    // discard it and do a full resync. Distinguishing this from every
    // other error is the entire reason this isn't just `if (!res.ok) throw`.
    throw new SyncTokenInvalidError();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GoogleCalendarApiError(res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class SyncTokenInvalidError extends Error {
  constructor() {
    super('Google reported the stored sync token as invalid (410) — a full resync is required.');
    this.name = 'SyncTokenInvalidError';
  }
}

export class GoogleCalendarApiError extends Error {
  constructor(public status: number, body: string) {
    super(`Google Calendar API error ${status}: ${body.slice(0, 300)}`);
    this.name = 'GoogleCalendarApiError';
  }
}

export interface GoogleCalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: string;
}

export async function listCalendars(accessToken: string): Promise<GoogleCalendarListEntry[]> {
  const entries: GoogleCalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${BASE}/users/me/calendarList`);
    url.searchParams.set('minAccessRole', 'reader');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = await googleFetch<{ items: GoogleCalendarListEntry[]; nextPageToken?: string }>(url.toString(), accessToken);
    entries.push(...page.items);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return entries;
}

export interface GoogleEventDateTime {
  date?: string; // all-day
  dateTime?: string; // timed, RFC3339
}

export interface GoogleEvent {
  id: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  htmlLink?: string;
  attendees?: { email: string; displayName?: string; responseStatus?: string }[];
  updated?: string;
}

export interface ListEventsOptions {
  syncToken?: string;
  timeMin?: string;
  singleEvents?: boolean; // expand recurring events into instances — always true for our use, exposed for clarity at call sites
}

export interface ListEventsResult {
  events: GoogleEvent[];
  nextSyncToken?: string;
}

/** Lists events for one calendar. Two mutually exclusive modes, matching
 * calendarSyncService.ts's incrementalSync: pass `syncToken` for an
 * incremental sync (Google returns only what changed since that token,
 * including status:'cancelled' entries for removals), or `timeMin` for a
 * full/initial sync (a fresh subscription has no token yet, and a 410
 * forces falling back to this branch). Google forbids combining syncToken
 * with most other filters, including timeMin — the caller must choose
 * one, this function doesn't validate that for you. Pages are collected
 * internally so callers see one flat list + the final nextSyncToken from
 * the last page, matching how Google's own docs describe pagination
 * interacting with sync tokens (only the last page carries the token that
 * covers everything seen). */
export async function listEvents(accessToken: string, calendarId: string, options: ListEventsOptions): Promise<ListEventsResult> {
  const events: GoogleEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  do {
    const url = new URL(`${BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set('singleEvents', String(options.singleEvents ?? true));
    url.searchParams.set('showDeleted', 'true'); // required to see status:'cancelled' entries on incremental syncs
    url.searchParams.set('maxResults', '250');
    if (options.syncToken) {
      url.searchParams.set('syncToken', options.syncToken);
    } else if (options.timeMin) {
      url.searchParams.set('timeMin', options.timeMin);
      url.searchParams.set('orderBy', 'startTime');
    }
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const page = await googleFetch<{ items: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string }>(url.toString(), accessToken);
    events.push(...page.items);
    pageToken = page.nextPageToken;
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
  } while (pageToken);

  return { events, nextSyncToken };
}

export interface InsertEventInput {
  summary: string;
  description?: string;
  location?: string;
  start: GoogleEventDateTime;
  end: GoogleEventDateTime;
  attendees?: { email: string }[];
}

export async function insertEvent(accessToken: string, calendarId: string, input: InsertEventInput): Promise<GoogleEvent> {
  return googleFetch<GoogleEvent>(`${BASE}/calendars/${encodeURIComponent(calendarId)}/events`, accessToken, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateEvent(accessToken: string, calendarId: string, eventId: string, input: InsertEventInput): Promise<GoogleEvent> {
  // PATCH (not PUT) — partial update, matches calendarService.ts's
  // updateEvent already merging existing-row values into `input` for any
  // field the caller didn't send, before this is called.
  return googleFetch<GoogleEvent>(`${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, accessToken, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
  await googleFetch<void>(`${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, accessToken, {
    method: 'DELETE',
  });
}

export interface WatchResult {
  resourceId: string;
  expiration: string; // Google returns this as a string of epoch millis
}

/** Registers a push-notification channel for a calendar (events.watch).
 * `channelId` is ours (a fresh uuid per subscription attempt —
 * calendarSyncService.ts generates it); `address` is our public webhook
 * URL. Google requires `address` to be HTTPS and publicly reachable —
 * in local dev this call is skipped entirely (see calendarSyncService.ts),
 * not stubbed here, so this function never has to know about that
 * distinction. */
export async function watchCalendar(
  accessToken: string,
  calendarId: string,
  channelId: string,
  address: string,
  token: string
): Promise<WatchResult> {
  return googleFetch<WatchResult>(`${BASE}/calendars/${encodeURIComponent(calendarId)}/events/watch`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ id: channelId, type: 'web_hook', address, token }),
  });
}

/** Stops a previously-registered channel. Google's channels.stop is not
 * calendar-scoped — channelId + resourceId alone identify it. Safe to
 * call on a channel that's already expired/gone; Google 404s and the
 * caller (stopSubscriptionChannel) treats that as success, not an error. */
export async function stopChannel(accessToken: string, channelId: string, resourceId: string): Promise<void> {
  await googleFetch<void>(`${BASE}/channels/stop`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ id: channelId, resourceId }),
  });
}
