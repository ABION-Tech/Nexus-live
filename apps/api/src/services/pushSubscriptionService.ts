// Session 11 — push subscription lifecycle against `push_subscriptions`
// (0009_remaining_entities.sql — table + RLS have existed since that
// migration; nothing wrote to it until now). Split from
// notifications/notificationService.ts's notifyPush (the send path)
// the same way notificationPreferencesService.ts is split from
// notifyInApp: this owns "which endpoints does this user have
// registered," not "deliver to them."
import { withOrgContext } from '../db.js';
import type { PushSubscriptionInput } from '@nexus/shared';

export function isPushSubscriptionInput(value: unknown): value is PushSubscriptionInput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.endpoint !== 'string' || !v.endpoint) return false;
  if (typeof v.keys !== 'object' || v.keys === null) return false;
  const keys = v.keys as Record<string, unknown>;
  return typeof keys.p256dh === 'string' && !!keys.p256dh && typeof keys.auth === 'string' && !!keys.auth;
}

// Upsert-by-(user_id, endpoint) — the table's own unique constraint
// (0009) already enforces this at the DB layer; a re-subscribe on the
// same device (browser rotated keys without the app ever calling
// unsubscribe first) should replace the stored keys, not error or
// duplicate.
export async function subscribeToPush(orgId: string, userId: string, subscription: PushSubscriptionInput): Promise<void> {
  await withOrgContext(orgId, async (client) => {
    await client.query(
      `insert into push_subscriptions (org_id, user_id, endpoint, p256dh_key, auth_key)
       values ($1, $2, $3, $4, $5)
       on conflict (user_id, endpoint)
       do update set p256dh_key = excluded.p256dh_key, auth_key = excluded.auth_key`,
      [orgId, userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
    );
  });
}

export async function unsubscribeFromPush(orgId: string, userId: string, endpoint: string): Promise<void> {
  await withOrgContext(orgId, async (client) => {
    await client.query(`delete from push_subscriptions where user_id = $1 and endpoint = $2`, [userId, endpoint]);
  });
}

// Used by the send path (a future notifyPush caller) to fan a payload
// out to every device a user has registered, and by
// notificationService.ts to prune a subscription sendWebPush reports as
// stale (404/410 — see webPushProvider.ts's own comment on that check).
export async function listSubscriptionsForUser(
  orgId: string,
  userId: string
): Promise<Array<{ endpoint: string; keys: { p256dh: string; auth: string } }>> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ endpoint: string; p256dh_key: string; auth_key: string }>(
      `select endpoint, p256dh_key, auth_key from push_subscriptions where user_id = $1`,
      [userId]
    );
    return rows.map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh_key, auth: r.auth_key } }));
  });
}

export async function pruneStaleSubscription(orgId: string, userId: string, endpoint: string): Promise<void> {
  await unsubscribeFromPush(orgId, userId, endpoint);
}
