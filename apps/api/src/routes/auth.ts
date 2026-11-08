import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { pool } from '../db.js';
import { buildConsentUrl, verifyAuthCode } from '../services/googleOAuthService.js';
import { createSession, revokeSession, createMobileExchangeCode, consumeMobileExchangeCode } from '../services/sessionService.js';
import { acceptInvite, InviteError } from '../services/inviteService.js';
import { recomputeSeatCount } from '../services/billingService.js';
import { verifyGuestLogin } from '../services/guestService.js';
import {
  loginWithPassword,
  requestPasswordLink,
  setPasswordWithToken,
  PasswordAuthError,
} from '../services/passwordAuthService.js';
import { SESSION_COOKIE_NAME } from '../plugins/auth.js';
import { isPlatformAdmin, isGroupAdmin, isCompanyAdmin } from '../services/authorizationService.js';
import { getThemePreference } from '../services/userPreferencesService.js';

// PRD §10.1 AuthService — Google OAuth is the ONLY login path in
// production. Session = httpOnly Secure cookie holding an opaque token,
// never a URL token, never localStorage (PRD §13.2).
//
// Full flow as of this session, replacing the flat 403 `not_invited`
// from Session 5: a verified Google identity with no existing `users`
// row is no longer rejected outright — it falls through to
// `acceptInvite`, which checks for a still-pending, unexpired invite for
// that email (PRD §3's "pending until leader approves" — the invite
// itself, created by a leader ahead of time, IS the approval). Only an
// identity with *neither* an existing account *nor* a pending invite
// gets `not_invited`.

const STATE_COOKIE_NAME = 'nexus_oauth_state';
// PRD §16 — set only on the mobile branch of /google/start, read back by
// /google/callback to decide which of the two response shapes to send
// (cookie + redirect-to-web-origin, vs. exchange-code + deep-link-back-
// to-app). Same short TTL and same-cookie-lifecycle as STATE_COOKIE_NAME
// since they're always set and cleared together.
const PLATFORM_COOKIE_NAME = 'nexus_oauth_platform';
// Must match android/app/src/main/AndroidManifest.xml's intent-filter
// scheme (`com.abion.nexus`, the same value as capacitor.config.ts's
// appId — Capacitor's own convention for a custom-scheme deep link).
const MOBILE_CALLBACK_SCHEME = 'com.abion.nexus://oauth-callback';
const isProd = process.env.NODE_ENV === 'production';

// PRD §16 (Capacitor) — the Android app's WebView serves the bundle from
// a synthetic `https://localhost` origin (capacitor.config.ts's
// `androidScheme: 'https'`), which is cross-site relative to the real API
// domain. `sameSite: 'lax'` cookies are withheld by the browser/WebView on
// cross-site fetch/XHR (Lax only rides along on top-level navigations),
// so every authenticated request from the native app would silently drop
// the session cookie and look logged-out. `sameSite: 'none'` is required
// for that to work, which in turn requires `secure: true` — safe here
// since the browser web app is also always HTTPS in production. Dev stays
// on 'lax'/non-secure since 'none' without `secure` is rejected outright
// by browsers, and localhost dev has no cross-site cookie problem to
// solve in the first place.
const SESSION_COOKIE_SAMESITE = isProd ? ('none' as const) : ('lax' as const);

export async function registerAuthRoutes(app: FastifyInstance) {
  // Defense-in-depth against exactly the "logout flash but stays logged
  // in" class of bug (NEXT_STEPS.md A0): nothing under this router
  // should ever be cacheable by a browser HTTP cache, an intermediate
  // proxy, or this app's own service worker (public/sw.js does
  // stale-while-revalidate on same-origin GETs). The SW's own origin
  // check currently excludes the API only because the API happens to be
  // cross-origin from the web app in this deployment — that's an
  // accident of topology, not a guarantee, so this header makes the
  // no-cache behavior explicit and correct regardless of how the API is
  // ever proxied/hosted in the future.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // Step 1: redirect to Google's consent screen. CSRF state is a random
  // value round-tripped via its own short-lived cookie and checked
  // against the query param Google sends back in /callback.
  //
  // PRD §16 — `?platform=mobile` is set by LoginPage.tsx only when
  // Capacitor.isNativePlatform() is true, and only to open this URL in
  // the *system* browser (via @capacitor/browser), never to navigate the
  // app's own WebView here — Google rejects OAuth from embedded WebViews
  // outright (`disallowed_useragent`). Stashed in its own cookie
  // alongside the CSRF state cookie so /google/callback — running in
  // that same system-browser process — knows which response shape to
  // send back.
  app.get('/google/start', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const state = crypto.randomBytes(16).toString('base64url');
    reply.setCookie(STATE_COOKIE_NAME, state, {
      httpOnly: true,
      secure: isProd,
      sameSite: SESSION_COOKIE_SAMESITE,
      maxAge: 10 * 60,
      path: '/',
    });
    const { platform } = req.query as { platform?: string };
    if (platform === 'mobile') {
      reply.setCookie(PLATFORM_COOKIE_NAME, 'mobile', {
        httpOnly: true,
        secure: isProd,
        sameSite: SESSION_COOKIE_SAMESITE,
        maxAge: 10 * 60,
        path: '/',
      });
    }
    reply.redirect(buildConsentUrl(state));
  });

  // Step 2: Google redirects back here with ?code=&state=.
  app.get('/google/callback', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const expectedState = req.cookies?.[STATE_COOKIE_NAME];
    reply.clearCookie(STATE_COOKIE_NAME, { path: '/' });

    if (!code || !state || !expectedState || state !== expectedState) {
      reply.status(400).send({ error: 'invalid_state', message: 'OAuth state mismatch — please retry sign-in.' });
      return;
    }

    let identity;
    try {
      identity = await verifyAuthCode(code);
    } catch (err) {
      req.log.warn({ err }, 'Google id_token verification failed');
      reply.status(401).send({ error: 'invalid_token', message: 'Could not verify Google identity.' });
      return;
    }

    // Pre-org-context lookup by email — intentionally the raw pool, not
    // withOrgContext, because we don't know the org yet (that's what
    // this query determines). Goes through the `find_user_by_email`
    // SECURITY DEFINER function (0003_invites.sql), not a plain SELECT
    // on `users`: RLS is FORCE'd on that table and nexus_app is
    // NOBYPASSRLS, so a plain SELECT here would need
    // `app.current_org_id` already set — which is exactly what this
    // lookup exists to determine. (This was a real, previously-shipped
    // bug: the original raw-table version of this query silently
    // returned zero rows for *every* email, recognized or not — caught
    // this session by testing against a real Postgres instance, not by
    // inspection. See 0003_invites.sql's header comment.)
    const { rows } = await pool.query(`select id, org_id from find_user_by_email($1)`, [identity.email]);

    let userId: string;
    let orgId: string;

    if (rows.length > 0) {
      ({ id: userId, org_id: orgId } = rows[0]);
    } else {
      // No existing account — fall through to the invite path before
      // rejecting outright. `identity.name` already falls back to the
      // email itself if Google's payload had no `name` claim
      // (googleOAuthService.ts), so this is genuinely "best available
      // display name," not a raw, possibly-empty field.
      try {
        const accepted = await acceptInvite({ email: identity.email, googleDisplayName: identity.name });
        userId = accepted.userId;
        orgId = accepted.orgId;
        // Session 47: this is the authoritative seat-count refresh point
        // — org_memberships actually grows here, unlike invites.ts's own
        // pre-check at invite-creation time. Best-effort: a stale
        // seat_count cache is a much smaller problem than blocking a
        // user's first successful login on it, same "never let logging/
        // bookkeeping become a user-facing feature failure" posture
        // recordAiUsageSafely already takes for ai_usage.
        recomputeSeatCount(orgId).catch((err) => req.log.warn({ err, orgId }, 'Failed to recompute seat count after invite acceptance'));
      } catch (err) {
        if (err instanceof InviteError) {
          const errorCode = err.code === 'expired' ? 'invite_expired' : 'not_invited';
          const message =
            err.code === 'expired'
              ? err.message
              : 'No NEXUS account for this Google account yet. Ask a leader to add you.';
          reply.status(403).send({ error: errorCode, message });
          return;
        }
        throw err;
      }
    }

    const { token, expiresAt } = await createSession(userId, orgId);

    // PRD §16 mobile branch: this response is running in the *system*
    // browser (opened by @capacitor/browser), which has a cookie jar
    // completely separate from the app's own WebView. Setting the
    // session cookie here would authenticate the system browser and
    // leave the app itself still logged out. Instead: mint a one-time
    // exchange code (sessionService.ts's own header explains why this
    // isn't a §13.2 violation) and hand it to the app via a deep link;
    // the app then redeems it from inside its own WebView
    // (POST /auth/mobile/exchange below), which sets the cookie in the
    // right cookie jar.
    const platformCookie = req.cookies?.[PLATFORM_COOKIE_NAME];
    reply.clearCookie(PLATFORM_COOKIE_NAME, { path: '/' });
    if (platformCookie === 'mobile') {
      const code = createMobileExchangeCode(token);
      reply.redirect(`${MOBILE_CALLBACK_SCHEME}?code=${code}`);
      return;
    }

    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: SESSION_COOKIE_SAMESITE,
      expires: expiresAt,
      path: '/',
    });

    reply.redirect(process.env.WEB_ORIGIN ?? 'http://localhost:5173');
  });

  // PRD §16 — the other half of the mobile bridge above. Called by the
  // app's own WebView (fetch with credentials:'include') immediately
  // after appUrlOpen delivers the deep link, so the cookie this sets
  // lands in the WebView's cookie jar, not the system browser's.
  app.post('/mobile/exchange', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { code } = (req.body as { code?: string }) ?? {};
    if (!code) {
      reply.status(400).send({ error: 'invalid_body', message: 'code is required.' });
      return;
    }
    const token = consumeMobileExchangeCode(code);
    if (!token) {
      // Same "don't distinguish the failure reason" posture as every
      // other auth failure path in this file — unknown, expired, and
      // already-redeemed all look identical to the caller.
      reply.status(401).send({ error: 'invalid_code', message: 'This sign-in link has expired. Please try again.' });
      return;
    }
    // Exchange codes carry no expiry info back to the cookie itself —
    // reuse the same session TTL every other session cookie gets, since
    // the underlying `sessions` row was already created with that TTL in
    // /google/callback above.
    const ttlMs = Number(process.env.SESSION_TTL_MINUTES ?? 60) * 60_000;
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: SESSION_COOKIE_SAMESITE,
      expires: new Date(Date.now() + ttlMs),
      path: '/',
    });
    reply.send({ ok: true });
  });

  // Session 37 — the one deliberate exception to "OAuth is the only
  // login path" (PRD §13.2), scoped to the new `guest` role only. Same
  // rate-limit posture as /google/start: this is a real password check
  // on an internet-facing endpoint.
  app.post('/guest-login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { email, password } = (req.body as { email?: string; password?: string }) ?? {};
    if (!email || !password) {
      reply.status(400).send({ error: 'invalid_body', message: 'email and password are required.' });
      return;
    }

    const verified = await verifyGuestLogin(email, password);
    if (!verified) {
      // Same "don't distinguish the failure reason" posture as every
      // other auth failure path in this file.
      reply.status(401).send({ error: 'invalid_credentials', message: 'Incorrect email or password.' });
      return;
    }

    const { token, expiresAt } = await createSession(verified.userId, verified.orgId);
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: SESSION_COOKIE_SAMESITE,
      expires: expiresAt,
      path: '/',
    });
    reply.send({ ok: true });
  });

  // ---- Session 54: member password sign-in -------------------------------
  // A second login path alongside Google (PRD §13.2's Google-only rule is
  // relaxed here at Othniel's request; Google stays available). See
  // passwordAuthService.ts for the design: passwords are only ever set by
  // their owner through a one-time emailed link.

  // Which sign-in options this deployment offers, so the login page never
  // shows a Google button that can't work (an unset client ID makes Google
  // reject the request with "Error 400: invalid_request").
  app.get('/methods', async (_req, reply) => {
    reply.send({ google: Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID), password: true });
  });

  app.post('/password/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { email, password } = (req.body as { email?: string; password?: string }) ?? {};
    if (!email || !password) {
      reply.status(400).send({ error: 'invalid_body', message: 'Enter your email and password.' });
      return;
    }
    const verified = await loginWithPassword(email, password);
    if (!verified) {
      reply.status(401).send({ error: 'invalid_credentials', message: 'That email or password is incorrect.' });
      return;
    }
    const { token, expiresAt } = await createSession(verified.userId, verified.orgId);
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: SESSION_COOKIE_SAMESITE,
      expires: expiresAt,
      path: '/',
    });
    reply.send({ ok: true });
  });

  // Always 200 with the same body, whether or not the address is known.
  app.post('/password/request', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { email } = (req.body as { email?: string }) ?? {};
    if (email) {
      await requestPasswordLink(email, process.env.WEB_ORIGIN ?? 'http://localhost:5173').catch((err) =>
        req.log.warn({ err }, 'Failed to send password link')
      );
    }
    reply.send({ ok: true, message: 'If that address is on NEXUS, a link is on its way. Check your inbox.' });
  });

  app.post('/password/set', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { token, password, name } = (req.body as { token?: string; password?: string; name?: string }) ?? {};
    if (!token || !password) {
      reply.status(400).send({ error: 'invalid_body', message: 'token and password are required.' });
      return;
    }
    try {
      const result = await setPasswordWithToken({ token, password, name });
      if (result.createdAccount) {
        recomputeSeatCount(result.orgId).catch((err) => req.log.warn({ err }, 'Failed to recompute seat count after invite acceptance'));
      }
      const { token: sessionToken, expiresAt } = await createSession(result.userId, result.orgId);
      reply.setCookie(SESSION_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        secure: isProd,
        sameSite: SESSION_COOKIE_SAMESITE,
        expires: expiresAt,
        path: '/',
      });
      reply.send({ ok: true });
    } catch (err) {
      if (err instanceof PasswordAuthError) {
        const status = err.code === 'weak_password' ? 400 : err.code === 'invalid_token' ? 410 : 403;
        reply.status(status).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    if (token) await revokeSession(token);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    reply.send({ ok: true });
  });

  // Current user, or 401. This is the concrete proof point that the
  // cookie -> session -> RLS-scoped-org-context chain works end to end —
  // see SESSION_LOG Session 5 for how this was verified against a real
  // Postgres instance, not just read for syntax.
  app.get('/session', { preHandler: app.requireAuth }, async (req) => {
    const u = req.sessionUser!;
    // Session 42: three cheap admin-gate checks folded into the one call
    // the client already makes on every load, so the frontend has what
    // it needs to decide which admin shell (if any) to show in the
    // sidebar without a second round trip. All three are already-built
    // authorizationService gates (Sessions 40/41) — nothing new is
    // authorized here, this just surfaces their result to the client
    // the same "convenience, not the real boundary" way ia.ts's own
    // `permissionGated` note already documents for Goals/AI Analyst:
    // every /admin/* route still re-checks for real server-side.
    // Session 50: theme folded into the same already-happening round
    // trip as the three admin-gate flags above — same "the client
    // already calls this on every load" reasoning this comment block
    // gives for those, applied to the new PRD §14 preference.
    const [platformAdmin, groupAdmin, companyAdmin, themePreference] = await Promise.all([
      isPlatformAdmin(u.userId),
      isGroupAdmin(u),
      isCompanyAdmin(u),
      getThemePreference(u.orgId, u.userId),
    ]);
    return {
      id: u.userId,
      orgId: u.orgId,
      role: u.role,
      name: u.name,
      email: u.email,
      isPlatformAdmin: platformAdmin,
      isGroupAdmin: groupAdmin,
      isCompanyAdmin: companyAdmin,
      themePreference,
      // Session 11 follow-up (ADMIN_BUILD_GUIDE.md §5): the backend has
      // carried req.sessionUser.impersonatedBy since Session 11, but
      // nothing ever put it on the wire — the frontend had no way to
      // know a given session was an impersonation at all, which is how
      // this shipped with a fully audited start/end/mode-change backend
      // and zero banner or exit control. Surfacing the same client-safe
      // subset here that impersonationService.ts already logs (never
      // the target's session/cookie internals) is what actually closes
      // that gap; ImpersonationBanner.tsx (components/navigation) is
      // the consumer.
      impersonatedBy: u.impersonatedBy
        ? {
            impersonationId: u.impersonatedBy.impersonationId,
            actorName: u.impersonatedBy.actorName,
            mode: u.impersonatedBy.mode,
            startedAt: u.impersonatedBy.startedAt,
          }
        : undefined,
    };
  });
}
