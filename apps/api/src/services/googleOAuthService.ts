// Google OAuth — the only login path in production (PRD §10.1). Isolated
// here so routes/auth.ts doesn't know it's Google specifically; if this
// ever needs a second identity provider, this file's shape is the seam.
import { OAuth2Client } from 'google-auth-library';

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '';
const REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI ?? 'http://localhost:3001/api/v1/auth/google/callback';

const client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

export function buildConsentUrl(state: string): string {
  return client.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'select_account',
  });
}

export interface GoogleIdentity {
  email: string;
  name: string;
  sub: string; // Google's stable user id — not currently stored, kept for future dedup use
}

/** Exchanges an authorization code for tokens, verifies the id_token
 * signature/audience/issuer, and returns the verified identity claims.
 * Throws on any verification failure — callers must not treat a caught
 * error as "unauthenticated, continue"; it means the token could not be
 * trusted at all. */
export async function verifyAuthCode(code: string): Promise<GoogleIdentity> {
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    throw new Error('Google token response had no id_token');
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload?.email || !payload.email_verified) {
    throw new Error('Google identity missing a verified email');
  }

  return {
    email: payload.email,
    name: payload.name ?? payload.email,
    sub: payload.sub,
  };
}
