// NotificationService — push channel (PRD §10.4). This is the only thing
// routes/other services should import; nobody calls webPushProvider
// directly (PRD §6 abstraction rule: UI/routes never touch a Provider or
// External API directly).
//
// Session 11: push_subscriptions wiring (pushSubscriptionService.ts) and
// the two-axis preference gate (notificationPreferencesService.ts) both
// landed — the two TODOs that used to sit here are done; notifyPushToUser
// below is the fan-out entry point real feature code should call instead
// of notifyPush directly.
import { sendWebPush, type PushSubscription, type PushPayload } from '../../integrations/webPushProvider.js';
import { listSubscriptionsForUser, pruneStaleSubscription } from '../pushSubscriptionService.js';
import { isNotificationEnabled } from '../notificationPreferencesService.js';
import { withOrgContext } from '../../db.js';
import type { PoolClient } from 'pg';
import type { NotificationInboxEntry } from '@nexus/shared';

export async function notifyPush(subscription: PushSubscription, payload: PushPayload) {
  return sendWebPush(subscription, payload);
}

// Fans a payload out to every device a user has registered, gated by
// that user's own push preference for this notification type (PRD
// §10.4's channel axis). Prunes any endpoint sendWebPush reports as
// stale (404/410) rather than leaving a dead row for the next send to
// fail on again.
export async function notifyPushToUser(
  orgId: string,
  userId: string,
  notificationType: string,
  payload: PushPayload
): Promise<void> {
  const enabled = await withOrgContext(orgId, (client) => isNotificationEnabled(client, userId, notificationType, 'push'));
  if (!enabled) return;

  const subscriptions = await listSubscriptionsForUser(orgId, userId);
  for (const subscription of subscriptions) {
    const result = await sendWebPush(subscription, payload);
    if (!result.sent && result.stale) {
      await pruneStaleSubscription(orgId, userId, subscription.endpoint);
    }
  }
}

// ---------------------------------------------------------------------
// notifyInApp — 0024 (Phase H). First real writer to the `notifications`
// table: it's existed since 0009 (schema'd, RLS'd) but nothing wrote to
// it until the scheduled jobs (automationJobs.ts) needed somewhere real
// to land "you have an overdue task" / "N teammates haven't filed EOD"
// without an EmailService or a wired push_subscriptions table to
// deliver through — neither of those exist yet (see this file's own
// TODOs above and PRD §10.3, still unbuilt). `channel = 'in_app'` is a
// real, always-available delivery path with no external dependency;
// `email`/`push`/`whatsapp` stay in the table's own check() constraint
// for when EmailService/the push wiring above actually exist, not used
// by this function.
//
// Deliberately takes the same `client` the caller is already running on
// inside `withOrgContext` (same convention activityLogService.ts's own
// header documents) rather than opening its own — a job that fails
// partway through a transaction should not have already-committed
// notification rows for work that got rolled back.
// ---------------------------------------------------------------------
export interface NotifyInAppInput {
  orgId: string;
  userId: string;
  taskId?: string | null;
  type: string; // e.g. 'deadline', 'eod_reminder', 'eod_missing_summary', 'digest' — PRD §10.4's notification-type axis; free text here, not an enum, since the type set is still growing and nothing downstream branches on it yet
  title: string;
  body?: string;
}

export async function notifyInApp(client: PoolClient, input: NotifyInAppInput): Promise<void> {
  // PRD §10.4 gate — Session 11. Checked against the same client/
  // transaction the insert below runs on, so a preference read and the
  // write it gates stay consistent within one automationJobs.ts job run.
  // Silently skips rather than throwing: "user turned this off" is not
  // an error condition for the caller.
  const enabled = await isNotificationEnabled(client, input.userId, input.type, 'in_app');
  if (!enabled) return;

  await client.query(
    `insert into notifications (org_id, user_id, task_id, type, channel, title, body)
     values ($1, $2, $3, $4, 'in_app', $5, $6)`,
    [input.orgId, input.userId, input.taskId ?? null, input.type, input.title, input.body ?? null]
  );
}

// ---------------------------------------------------------------------
// Inbox — Session 11. First real reader of `notifications` (it's existed
// since 0009, written to since Phase H's notifyInApp, but nothing ever
// listed or acknowledged a row until this session's Settings screen
// needed somewhere to show them).
// ---------------------------------------------------------------------
export async function listInbox(
  orgId: string,
  userId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {}
): Promise<NotificationInboxEntry[]> {
  return withOrgContext(orgId, async (client) => {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100); // PRD §13.4 pagination enforcement — no unbounded fetch
    const { rows } = await client.query<{
      id: string;
      type: string;
      channel: string;
      title: string;
      body: string | null;
      task_id: string | null;
      read_at: string | null;
      created_at: string;
    }>(
      `select id, type, channel, title, body, task_id, read_at, created_at
       from notifications
       where user_id = $1 ${opts.unreadOnly ? 'and read_at is null' : ''}
       order by created_at desc
       limit $2`,
      [userId, limit]
    );
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      channel: r.channel,
      title: r.title,
      body: r.body,
      taskId: r.task_id,
      readAt: r.read_at,
      createdAt: r.created_at,
    }));
  });
}

// Returns false (route maps to 404) rather than throwing when no
// matching unread row exists — either an already-read notification or
// one that isn't this user's, and RLS's own tenant_isolation policy
// already prevents the latter from ever matching cross-org regardless.
export async function markNotificationRead(orgId: string, userId: string, id: string): Promise<boolean> {
  return withOrgContext(orgId, async (client) => {
    const { rowCount } = await client.query(
      `update notifications set read_at = now() where id = $1 and user_id = $2 and read_at is null`,
      [id, userId]
    );
    return (rowCount ?? 0) > 0;
  });
}
