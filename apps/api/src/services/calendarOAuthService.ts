// Calendar-specific Google OAuth — deliberately a separate flow from
// googleOAuthService.ts (login). Login uses `access_type: 'online'` and
// only the openid/email/profile scopes, because it only ever needs to
// verify identity once per session. Calendar sync needs a long-lived
// `refresh_token` (access_type: 'offline') so incrementalSync and the
// reconciliation sweep can call the Calendar API hours or days after the
// user last had a browser open — a fundamentally different grant, not
// just "the same login with more scopes", so it gets its own client,
// its own redirect URI, and its own consent screen (PRD §10.5 / SESSION_LOG:
// "extra Google OAuth scopes on top of login, per-user token storage").
import { OAuth2Client } from 'google-auth-library';

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '';
const REDIRECT_URI = process.env.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI ?? 'http://localhost:3001/api/v1/calendar/oauth/callback';

// Same Google Cloud OAuth client (CLIENT_ID/SECRET) as login — Google
// doesn't require a separate client per scope set, only a distinct
// redirect URI to disambiguate which flow a callback belongs to.
const client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const CALENDAR_SCOPES = [
  'openid',
  'email',
  // Full read/write on the user's calendars and events — calendarList
  // (for the "pick which calendar to sync" step) and events.* (for
  // write-back create/update/delete) both need this; the narrower
  // `calendar.events`-only scope has no calendarList access.
  'https://www.googleapis.com/auth/calendar',
];

export function buildCalendarConsentUrl(state: string): string {
  return client.generateAuthUrl({
    access_type: 'offline', // required to receive a refresh_token
    scope: CALENDAR_SCOPES,
    state,
    // Google only issues a refresh_token on the *first* consent for a
    // given user+client+scope combination unless prompt=consent forces
    // the consent screen every time — without this, a user who
    // reconnects after a revoke would silently get no refresh_token back
    // and upsertConnection would clobber a working one with null.
    prompt: 'consent',
    include_granted_scopes: true,
  });
}

export interface CalendarOAuthIdentity {
  email: string;
  sub: string;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  scopes: string;
}

/** Exchanges an authorization code for tokens and verifies the id_token,
 * same verification discipline as googleOAuthService.verifyAuthCode.
 * Throws (never returns a partial/unverified identity) if Google didn't
 * return a refresh_token — the one failure mode `prompt: 'consent'`
 * above exists to prevent, but still checked explicitly since silently
 * proceeding with refreshToken: undefined would surface as a confusing
 * runtime error much later, inside calendarTokenService instead of here. */
export async function exchangeCalendarAuthCode(code: string): Promise<CalendarOAuthIdentity> {
  const { tokens } = await client.getToken(code);

  if (!tokens.id_token) throw new Error('Google token response had no id_token.');
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token. This usually means the user has an existing grant and prompt=consent was not honored — reconnect and approve the consent screen again.'
    );
  }
  if (!tokens.access_token || !tokens.expiry_date) {
    throw new Error('Google token response was missing an access_token or expiry.');
  }

  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload?.email || !payload.email_verified) {
    throw new Error('Google identity missing a verified email.');
  }

  return {
    email: payload.email,
    sub: payload.sub,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: new Date(tokens.expiry_date),
    scopes: tokens.scope ?? CALENDAR_SCOPES.join(' '),
  };
}

export interface RefreshedAccessToken {
  accessToken: string;
  expiresAt: Date;
}

/** Exchanges a stored refresh_token for a fresh access_token. This is
 * the one call calendarTokenService.getValidAccessToken makes when the
 * cached access_token has expired. Throws whatever google-auth-library
 * throws on a rejected/revoked refresh_token — the caller (calendarTokenService)
 * is what translates that into ConnectionRevokedError and marks the row
 * revoked; this function stays a plain "ask Google, report what it said". */
export async function refreshAccessToken(refreshToken: string): Promise<RefreshedAccessToken> {
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();

  if (!credentials.access_token || !credentials.expiry_date) {
    throw new Error('Google refresh response was missing an access_token or expiry.');
  }

  return {
    accessToken: credentials.access_token,
    expiresAt: new Date(credentials.expiry_date),
  };
}

/** Best-effort revoke on Google's side when a user disconnects
 * (calendarService.disconnectConnection). Swallows errors deliberately:
 * by the time this runs, the local connection row is already marked
 * revoked and every subscription's webhook channel already stopped — a
 * failed revoke call (token already invalid, Google unreachable) must
 * not roll any of that back or surface as a failure to the user, who
 * has no action they could take about it anyway. */
export async function revokeToken(refreshToken: string): Promise<void> {
  try {
    await client.revokeToken(refreshToken);
  } catch {
    // Best-effort — see comment above.
  }
}
