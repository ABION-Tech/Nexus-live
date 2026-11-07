// Single seam between "a connection row in the DB" and "an access token
// good enough to call Google with right now". Every route/service that
// needs to call googleCalendarClient.ts goes through this rather than
// reading `access_token` off the row directly, so the refresh-on-expiry
// logic lives in exactly one place.
import { withOrgContext } from '../db.js';
import { refreshAccessToken } from './calendarOAuthService.js';

export interface CalendarConnectionRow {
  id: string;
  org_id: string;
  user_id: string;
  google_email: string;
  refresh_token: string;
  access_token: string | null;
  access_token_expires_at: Date | null;
  revoked_at: Date | null;
}

// Refresh a little before actual expiry, not exactly at it — avoids a
// request landing in the last few seconds of validity and racing Google's
// own clock skew.
const EXPIRY_SKEW_MS = 60_000;

export class ConnectionRevokedError extends Error {
  constructor() {
    super('This Google account connection was revoked and needs to be reconnected.');
    this.name = 'ConnectionRevokedError';
  }
}

/** Returns a currently-valid access token for the given connection,
 * refreshing (and persisting the refresh) first if the cached one has
 * expired or is about to. Throws ConnectionRevokedError — and marks the
 * row revoked — if Google rejects the refresh token itself (the user
 * revoked access on Google's side), so callers can surface "reconnect
 * needed" instead of retrying a refresh that will never succeed. */
export async function getValidAccessToken(orgId: string, connection: CalendarConnectionRow): Promise<string> {
  const expiresAt = connection.access_token_expires_at?.getTime() ?? 0;
  if (connection.access_token && expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return connection.access_token;
  }

  let refreshed;
  try {
    refreshed = await refreshAccessToken(connection.refresh_token);
  } catch (_err) {
    await withOrgContext(orgId, (client) =>
      client.query(`update calendar_connections set revoked_at = now() where id = $1`, [connection.id])
    );
    throw new ConnectionRevokedError();
  }

  await withOrgContext(orgId, (client) =>
    client.query(
      `update calendar_connections set access_token = $1, access_token_expires_at = $2 where id = $3`,
      [refreshed.accessToken, refreshed.expiresAt, connection.id]
    )
  );

  return refreshed.accessToken;
}
