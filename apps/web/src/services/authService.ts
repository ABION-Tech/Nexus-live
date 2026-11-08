// Web-side authService — wraps routes/auth.ts (PRD §10.1). Google OAuth
// is a full browser-redirect flow (start → Google consent → callback
// sets the httpOnly cookie → redirects back here), not a fetch()-based
// call, so `googleSignInUrl` is a plain URL to navigate to, not a method
// that calls apiClient.
//
// PRD §16 — that's the *web* story. On Android, Google refuses OAuth
// inside an embedded WebView (`disallowed_useragent`), so the native
// path (startMobileGoogleSignIn below) opens the same URL in the
// *system* browser via @capacitor/browser instead of navigating in
// place, then waits for the deep-link callback the system browser sends
// back (routes/auth.ts's mobile branch + AndroidManifest.xml's
// oauth-callback intent-filter) to redeem a one-time code for the real
// session cookie, set correctly inside the app's own WebView.
import { apiClient, ApiError, API_BASE } from './apiClient';
import type { ThemePreference } from '@nexus/shared';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { App as CapacitorApp } from '@capacitor/app';

// Session 11 follow-up — client-safe subset of sessionService's
// ImpersonationContext. Deliberately mirrors only the fields GET
// /auth/session now sends (see auth.ts's own note): no actorUserId, no
// target internals, nothing beyond what a banner needs to say "you are
// impersonating X, started at Y, currently Z mode".
export interface ImpersonationInfo {
  impersonationId: string;
  actorName: string;
  mode: 'read_only' | 'write';
  startedAt: string;
}

export interface CurrentUser {
  id: string;
  orgId: string;
  role: string;
  name: string;
  email: string;
  // Session 42: three admin-gate flags GET /session now folds in
  // (ADMIN_BUILD_GUIDE.md §3 "Session 6" dashboard UI pass) — same
  // "convenience, not the real boundary" posture as ia.ts's own
  // `permissionGated` note: these only decide what's shown in the
  // sidebar. Every /admin/* route still re-checks for real server-side
  // via isPlatformAdmin/isGroupAdmin/isCompanyAdmin.
  isPlatformAdmin: boolean;
  isGroupAdmin: boolean;
  isCompanyAdmin: boolean;
  // Session 11 follow-up — present only when this session is currently
  // an impersonation (the browser is authenticated as the target, per
  // impersonationService.ts's own doc comment on why the cookie swaps
  // rather than layering a second identity on top). undefined for every
  // normal session.
  impersonatedBy?: ImpersonationInfo;
  // Session 50 — PRD §14 theme toggle. Folded into the same /session
  // round trip as the three flags above, same reasoning.
  themePreference: ThemePreference;
}

export const googleSignInUrl = `${API_BASE}/auth/google/start`;

export const isNativePlatform = Capacitor.isNativePlatform();

/** PRD §16 mobile sign-in entry point — LoginPage.tsx calls this instead
 * of navigating to googleSignInUrl when isNativePlatform is true. Opens
 * Google's consent screen in the system browser (not this WebView) with
 * ?platform=mobile so routes/auth.ts's /google/callback knows to send
 * back a deep-link + exchange-code instead of setting a cookie directly
 * on this (wrong) browser context. */
export async function startMobileGoogleSignIn(): Promise<void> {
  await Browser.open({ url: `${googleSignInUrl}?platform=mobile` });
}

/** Exchanges the one-time code from the oauth-callback deep link for a
 * real session, setting the httpOnly cookie inside this WebView (see
 * routes/auth.ts's POST /mobile/exchange for why this round trip has to
 * happen from here rather than from the system browser). Call once,
 * as soon as the deep link is observed. */
async function exchangeMobileAuthCode(code: string): Promise<void> {
  await apiClient.post('/auth/mobile/exchange', { code });
}

/** Wires the deep-link listener. Call exactly once at app startup
 * (app/App.tsx) on native platforms only — a no-op with nothing to clean
 * up on web, since Capacitor.isNativePlatform() there means this never
 * even reaches CapacitorApp.addListener. `onSignedIn` is the caller's
 * chance to re-fetch the session and navigate away from LoginPage;
 * kept as a callback rather than a hard-coded redirect here so this
 * file stays framework/router-agnostic like the rest of authService.ts. */
export function listenForMobileOAuthCallback(onSignedIn: () => void, onError: (message: string) => void): void {
  if (!isNativePlatform) return;
  CapacitorApp.addListener('appUrlOpen', async ({ url }) => {
    if (!url.startsWith('com.abion.nexus://oauth-callback')) return;
    const code = new URL(url).searchParams.get('code');
    await Browser.close().catch(() => {
      /* already closed itself (some Android versions auto-close on
         redirect) — not an error worth surfacing. */
    });
    if (!code) {
      onError('Sign-in was cancelled or did not complete.');
      return;
    }
    try {
      await exchangeMobileAuthCode(code);
      onSignedIn();
    } catch {
      onError('Sign-in link expired — please try again.');
    }
  });
}

/** Returns the current session, or null for a "not logged in" 401 —
 * that's an expected, common state (anyone before they sign in), not an
 * error to surface via ErrorState the way a 500 or network failure is. */
export async function getCurrentSession(): Promise<CurrentUser | null> {
  try {
    return await apiClient.get<CurrentUser>('/auth/session');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function logout(): Promise<{ ok: true }> {
  return apiClient.post<{ ok: true }>('/auth/logout');
}

// Dev-only roster login (apps/api/src/routes/devAuth.ts) — only exists
// when the API was started with DEV_LOGIN=true and NODE_ENV !==
// 'production'; otherwise these 404 and LoginPage.tsx hides the picker.
// Not a fallback LoginPage should assume is always there.
export interface DevRosterUser {
  id: string;
  name: string;
  email: string;
  orgId: string;
  role: string;
}

export async function fetchDevRoster(): Promise<DevRosterUser[] | null> {
  try {
    const res = await apiClient.get<{ users: DevRosterUser[] }>('/auth/dev-login/roster');
    return res.users;
  } catch {
    // 404 (route not mounted) or any other failure: treat identically —
    // dev login just isn't available here, not an error to surface.
    return null;
  }
}

export function devLogin(userId: string): Promise<{ ok: true }> {
  return apiClient.post<{ ok: true }>('/auth/dev-login', { userId });
}

// ---- Session 54: password sign-in (routes/auth.ts /password/*) -----------

export interface AuthMethods {
  google: boolean;
  password: boolean;
}

/** Which sign-in options the API offers. Falls back to password-only if
 * the call fails, so the page is never left with no way in. */
export async function fetchAuthMethods(): Promise<AuthMethods> {
  try {
    return await apiClient.get<AuthMethods>('/auth/methods');
  } catch {
    return { google: false, password: true };
  }
}

export function passwordLogin(email: string, password: string): Promise<{ ok: true }> {
  return apiClient.post<{ ok: true }>('/auth/password/login', { email, password });
}

export function requestPasswordLink(email: string): Promise<{ ok: true; message: string }> {
  return apiClient.post<{ ok: true; message: string }>('/auth/password/request', { email });
}

export function setPasswordWithToken(token: string, password: string, name?: string): Promise<{ ok: true }> {
  return apiClient.post<{ ok: true }>('/auth/password/set', { token, password, name });
}
