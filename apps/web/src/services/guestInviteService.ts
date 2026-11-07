// Web-side guest-invite service — wraps apps/api/src/routes/guests.ts
// (ADMIN_BUILD_GUIDE.md §1, backend from Session 37; this is the
// Session 41/42 UI surface the guide's own header comment on guests.ts
// says was still missing: "The guest-invite *surface* (a page in
// Settings) is Session 41/42 per the guide's own numbering").
// Named guestInviteService rather than guestService to avoid colliding
// with a future guest-session-side service, and because this file only
// ever covers the one leader-only creation action — not guest login,
// which is a full-page credential form on LoginPage, not a fetch.
import { apiClient } from './apiClient';

export interface GuestCredential {
  userId: string;
  name: string;
  email: string;
  tempPassword: string; // returned exactly once — never re-fetchable after this
}

export function createGuestCredential(name: string, email: string): Promise<GuestCredential> {
  return apiClient.post<GuestCredential>('/guests', { name, email });
}
