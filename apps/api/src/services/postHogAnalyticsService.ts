// postHogAnalyticsService.ts — ADMIN_BUILD_GUIDE.md §3 "Session 4 —
// Super Admin backend": "analyticsService.ts — PostHog no-op stub."
//
// Named differently from the guide's own literal filename on purpose:
// `analyticsService.ts` already exists in this repo (PRD §8.7 Task
// Trends / Failsafe categories, Session-numbered separately from this
// guide) and is a real, wired-up service — reusing its name here would
// either silently shadow it or require renaming an unrelated, working
// file mid-session for no functional reason. This file is the guide's
// PostHog stub under a name that doesn't collide.
//
// No-op per the guide: no PostHog SDK dependency added, no network call
// made. `track()` exists so call sites (this session's superAdmin.ts
// investigation/analytics endpoints, if ever wired to real product
// analytics) have a stable interface to code against now — swapping
// this for a real PostHog client later is a body-swap of this one file,
// same AIProvider/EmailProvider-style abstraction PRD §6 already asks
// every external integration to sit behind.
export interface AnalyticsEvent {
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
}

export function track(_event: AnalyticsEvent): void {
  // Deliberately empty — see file header. Swap for a real PostHog
  // client.capture(...) call when product analytics is actually wired.
}
