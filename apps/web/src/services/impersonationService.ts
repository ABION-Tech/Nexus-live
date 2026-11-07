// Web-side impersonationService — wraps routes/admin/impersonation.ts's
// /end and /mode (POST /api/v1/admin/impersonation/*). No wrapper for
// /start here: nothing in this codebase's frontend triggers a start yet
// (see ImpersonationBanner.tsx's own header note) — this file only
// covers what a session that's *already* impersonating needs to do to
// itself: change its own mode, or end.
import { apiClient } from './apiClient';

/** Ends the current session's active impersonation. Mirrors the
 * server's own POST /end contract exactly: it always acts on
 * req.sessionUser.impersonatedBy, never takes an id, and clears the
 * impersonation cookie server-side — the caller's next GET /session
 * will come back anonymous (routes/admin/impersonation.ts), same as a
 * real logout. Callers should re-run their session check afterward
 * (authService.getCurrentSession / the app's own loadSession) rather
 * than assuming any particular resulting state. */
export function endImpersonation(): Promise<void> {
  return apiClient.post<void>('/admin/impersonation/end');
}

/** Elevates or steps back down the current impersonation's write
 * access. A no-op call if the session isn't actually an impersonation —
 * the server throws in that case (ImpersonationError('invalid', ...)),
 * so callers should only expose this when CurrentUser.impersonatedBy is
 * already present. */
export function setImpersonationMode(mode: 'read_only' | 'write'): Promise<void> {
  return apiClient.post<void>('/admin/impersonation/mode', { mode });
}
