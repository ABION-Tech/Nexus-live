// Session 11 — PRD §10.4 two-axis preference model
// (notification_preferences, 0030_notification_preferences.sql). Split
// from notificationService.ts (notifications/notificationService.ts)
// the same way themeService.ts/userPreferencesService.ts are split from
// authService.ts: this is a self-service settings read/write, not part
// of the sending path itself — notificationService.ts's notifyInApp
// imports isNotificationEnabled from here rather than the reverse, to
// keep "does this user want this" and "record that this was sent" as
// separate concerns.
import { withOrgContext } from '../db.js';
import type { PoolClient } from 'pg';
import {
  NOTIFICATION_TYPES,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  type NotificationPreference,
  type NotificationType,
} from '@nexus/shared';

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return typeof value === 'string' && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

// Full type×channel grid, defaulting missing rows to enabled: true — a
// user who has never touched this screen should see every toggle on,
// matching the behavior they already had before this table existed
// (notifyInApp always sent).
export async function listPreferences(orgId: string, userId: string): Promise<NotificationPreference[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ notification_type: NotificationType; channel: NotificationChannel; enabled: boolean }>(
      `select notification_type, channel, enabled
       from notification_preferences
       where user_id = $1`,
      [userId]
    );
    const overrides = new Map(rows.map((r) => [`${r.notification_type}:${r.channel}`, r.enabled]));

    const grid: NotificationPreference[] = [];
    for (const notificationType of NOTIFICATION_TYPES) {
      for (const channel of NOTIFICATION_CHANNELS) {
        grid.push({
          notificationType,
          channel,
          enabled: overrides.get(`${notificationType}:${channel}`) ?? true,
        });
      }
    }
    return grid;
  });
}

export async function setPreference(
  orgId: string,
  userId: string,
  notificationType: NotificationType,
  channel: NotificationChannel,
  enabled: boolean
): Promise<NotificationPreference> {
  return withOrgContext(orgId, async (client) => {
    await client.query(
      `insert into notification_preferences (org_id, user_id, notification_type, channel, enabled, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (user_id, notification_type, channel)
       do update set enabled = excluded.enabled, updated_at = now()`,
      [orgId, userId, notificationType, channel, enabled]
    );
    return { notificationType, channel, enabled };
  });
}

// The gate notifyInApp (notifications/notificationService.ts) checks
// before writing a row. Takes the caller's already-open transactional
// client (same convention notifyInApp itself documents) rather than
// opening its own — this only ever runs from inside notifyInApp's own
// withOrgContext block, never standalone.
export async function isNotificationEnabled(
  client: PoolClient,
  userId: string,
  notificationType: string,
  channel: NotificationChannel
): Promise<boolean> {
  const { rows } = await client.query<{ enabled: boolean }>(
    `select enabled from notification_preferences
     where user_id = $1 and notification_type = $2 and channel = $3`,
    [userId, notificationType, channel]
  );
  // No row = never turned off = enabled, same default listPreferences
  // above applies to the grid.
  return rows[0]?.enabled ?? true;
}
