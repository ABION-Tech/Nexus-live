// Web Push provider — ported from the MVP's standalone send_push.js
// Vercel function. Same underlying logic (web-push + VAPID), but now lives
// inside NEXUS API as a Provider (PRD §6: UI → Service → Provider →
// External API), not a separate serverless function. Secrets stay
// server-side only (PRD §13.4) — same guarantee as before, fewer moving
// parts, and it's reachable from the same rate-limit/audit-log
// infrastructure as everything else.
import webpush from 'web-push';

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

let configured = false;
function ensureConfigured() {
  if (configured) return;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error('VAPID keys not configured — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.');
  }
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:admin@abion.org', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
}

// Returns { sent: true } normally, { sent: false, stale: true } when the
// subscription is dead (404/410 — user revoked, browser data cleared) so
// the caller can prune it from `push_subscriptions` — same 404/410 handling
// as the original send_push.js.
export async function sendWebPush(subscription: PushSubscription, payload: PushPayload) {
  ensureConfigured();
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { sent: true as const };
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    const stale = statusCode === 404 || statusCode === 410;
    if (stale) return { sent: false as const, stale: true as const };
    throw err;
  }
}
