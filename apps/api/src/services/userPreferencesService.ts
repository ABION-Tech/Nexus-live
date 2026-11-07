// Session 50 — PRD §14 light/dark toggle. Split out from authService.ts
// (Google OAuth/session issuance) rather than added there: this is a
// self-service settings read/write on an already-authenticated user, not
// part of the auth flow itself — same reasoning permissionService.ts and
// authorizationService.ts are separate files even though both ultimately
// gate on `users`/`org_memberships`.
import { withOrgContext } from '../db.js';
import type { ThemePreference } from '@nexus/shared';

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark';
}

export { isThemePreference };

/** Used by both GET /auth/session (routes/auth.ts) and this module's own
 * PATCH handler's response — a single read path so the two never
 * disagree about what "the current preference" means. */
export async function getThemePreference(orgId: string, userId: string): Promise<ThemePreference> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ theme_preference: ThemePreference }>(
      `select theme_preference from users where id = $1`,
      [userId],
    );
    // A missing row here would mean the session's own userId doesn't
    // resolve against `users` under this orgId's RLS context — i.e. the
    // session is stale/invalid in a way createSession/verifySession
    // should already have prevented. Falling back to the column default
    // rather than throwing keeps this read-path as robust as every other
    // "trust the session, but don't crash the page over it" spot in this
    // codebase (see authService.ts's own 401-vs-throw split).
    return rows[0]?.theme_preference ?? 'dark';
  });
}

export async function setThemePreference(
  orgId: string,
  userId: string,
  preference: ThemePreference,
): Promise<ThemePreference> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ theme_preference: ThemePreference }>(
      `update users set theme_preference = $1 where id = $2 returning theme_preference`,
      [preference, userId],
    );
    // Unlike the read path above, a write that matches zero rows isn't a
    // "fall back to a sane default" situation — it means the session's
    // own userId didn't resolve against `users` under this orgId's RLS
    // context at the moment of the write, which should already have been
    // caught upstream. Throwing here (500, same as any other unexpected
    // server-side invariant break in this codebase) rather than silently
    // returning the requested value as if it had been persisted.
    if (!rows[0]) {
      throw new Error(`setThemePreference: no user row updated for userId=${userId} under orgId=${orgId}`);
    }
    return rows[0].theme_preference;
  });
}
