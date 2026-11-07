// PRD §10.5 CalendarService — frontend side. Thin wrappers around
// apiClient mirroring the shape of taskService.ts / goalService.ts:
// one function per route, all types from @nexus/shared, no business
// logic here. The one exception: startCalendarOAuth() is a full-page
// navigation (window.location.href), not a fetch — the backend /oauth/start
// route sets an httpOnly CSRF cookie and immediately 302s to Google, so
// there's no JSON response to parse. Adjust the import path for apiClient
// if your project resolves it differently (e.g. '../../lib/apiClient').
import { apiClient } from './apiClient';
import type {
  CalendarConnection,
  CalendarSubscription,
  GoogleCalendarListEntry,
  CalendarEvent,
  CalendarEventInput,
} from '@nexus/shared';

// ── OAuth connect flow ────────────────────────────────────────────────
// Full-page nav — the server sets a state cookie, redirects to Google,
// and on success redirects back to /work/calendar (see routes/calendar.ts).
export function startCalendarOAuth(): void {
  window.location.href = '/api/v1/calendar/oauth/start';
}

// ── Connections ───────────────────────────────────────────────────────
export async function listConnections(): Promise<CalendarConnection[]> {
  const { connections } = await apiClient.get<{ connections: CalendarConnection[] }>(
    '/calendar/connections',
  );
  return connections;
}

// Returns the Google-side list of calendars the connection has access to.
// Used to populate the calendar picker before creating a subscription.
export async function listAvailableCalendars(
  connectionId: string,
): Promise<GoogleCalendarListEntry[]> {
  const { calendars } = await apiClient.get<{ calendars: GoogleCalendarListEntry[] }>(
    `/calendar/connections/${connectionId}/calendars`,
  );
  return calendars;
}

// Routes fixed to return 200 { ok: true } so apiClient.delete's
// unconditional res.json() doesn't throw on an empty body.
export async function disconnectConnection(connectionId: string): Promise<void> {
  await apiClient.delete<{ ok: true }>(`/calendar/connections/${connectionId}`);
}

// ── Subscriptions (which synced calendars) ────────────────────────────
export async function listSubscriptions(): Promise<CalendarSubscription[]> {
  const { subscriptions } = await apiClient.get<{ subscriptions: CalendarSubscription[] }>(
    '/calendar/subscriptions',
  );
  return subscriptions;
}

export async function createSubscription(
  connectionId: string,
  googleCalendarId: string,
  calendarName: string,
): Promise<CalendarSubscription> {
  return apiClient.post<CalendarSubscription>('/calendar/subscriptions', {
    connectionId,
    googleCalendarId,
    calendarName,
  });
}

export async function removeSubscription(subscriptionId: string): Promise<void> {
  await apiClient.delete<{ ok: true }>(`/calendar/subscriptions/${subscriptionId}`);
}

// ── Events (merged agenda + write-back) ───────────────────────────────
export async function listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
  const { events } = await apiClient.get<{ events: CalendarEvent[] }>(
    `/calendar/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
  );
  return events;
}

export async function createEvent(
  subscriptionId: string,
  input: CalendarEventInput,
): Promise<CalendarEvent> {
  return apiClient.post<CalendarEvent>('/calendar/events', { subscriptionId, ...input });
}

export async function updateEvent(
  eventId: string,
  input: Partial<CalendarEventInput>,
): Promise<CalendarEvent> {
  return apiClient.patch<CalendarEvent>(`/calendar/events/${eventId}`, input);
}

export async function deleteEvent(eventId: string): Promise<void> {
  await apiClient.delete<{ ok: true }>(`/calendar/events/${eventId}`);
}
