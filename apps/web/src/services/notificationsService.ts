// Settings > Notifications Preferences — mirrors the API-side split
// (routes/notifications.ts) in three groups: preferences, push
// subscription lifecycle, inbox. Same file-boundary reasoning
// themeService.ts documents for its own split from authService.ts.
import { apiClient } from './apiClient';
import type { NotificationChannel, NotificationInboxEntry, NotificationPreference, NotificationType, PushSubscriptionInput } from '@nexus/shared';

export function fetchNotificationPreferences(): Promise<{ preferences: NotificationPreference[] }> {
  return apiClient.get<{ preferences: NotificationPreference[] }>('/notifications/preferences');
}

export function patchNotificationPreference(
  notificationType: NotificationType,
  channel: NotificationChannel,
  enabled: boolean
): Promise<NotificationPreference> {
  return apiClient.patch<NotificationPreference>('/notifications/preferences', { notificationType, channel, enabled });
}

export function fetchVapidPublicKey(): Promise<{ publicKey: string | null }> {
  return apiClient.get<{ publicKey: string | null }>('/notifications/vapid-public-key');
}

export function subscribeToPush(subscription: PushSubscriptionInput): Promise<void> {
  return apiClient.post<void>('/notifications/subscribe', subscription);
}

export function unsubscribeFromPush(endpoint: string): Promise<void> {
  return apiClient.delete<void>(`/notifications/subscribe/${encodeURIComponent(endpoint)}`);
}

export function fetchNotificationInbox(opts?: { unreadOnly?: boolean; limit?: number }): Promise<{ notifications: NotificationInboxEntry[] }> {
  const params = new URLSearchParams();
  if (opts?.unreadOnly) params.set('unreadOnly', 'true');
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return apiClient.get<{ notifications: NotificationInboxEntry[] }>(`/notifications/inbox${qs ? `?${qs}` : ''}`);
}

export function markNotificationRead(id: string): Promise<void> {
  return apiClient.patch<void>(`/notifications/inbox/${id}/read`);
}
