import { useEffect, useState } from 'react';
import { Card, Checkbox, Button, Table, LoadingState, ErrorState, useToast } from '../../components/ui';
import {
  fetchNotificationPreferences,
  patchNotificationPreference,
  fetchVapidPublicKey,
  subscribeToPush,
  unsubscribeFromPush,
} from '../../services/notificationsService';
import { urlBase64ToUint8Array } from '../../utils/webPush';
import {
  NOTIFICATION_TYPES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPE_LABELS,
  type NotificationChannel,
  type NotificationPreference,
  type NotificationType,
} from '@nexus/shared';

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

// Push permission/subscription is browser state, not server state — the
// server only knows "does a subscription row exist for this endpoint",
// which isn't the same question as "is Notification permission granted
// on this device right now" (permission can be revoked in browser
// settings without ever telling this app). Tracked separately from the
// preferences grid above for that reason, same way registerServiceWorker.ts
// treats service-worker registration as independent of anything
// server-side.
type PushState =
  | { status: 'unsupported' }
  | { status: 'checking' }
  | { status: 'denied' }
  | { status: 'subscribed'; endpoint: string }
  | { status: 'unsubscribed' };

// Settings > Notifications Preferences (PRD §10.4's two-axis model,
// finally with a screen). Built from the same design-system primitives
// (Card/Table/Checkbox/Button + var(--*) tokens) as Integrations.tsx —
// no new visual language introduced for one settings page.
export function NotificationsPreferences() {
  const { show } = useToast();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [prefs, setPrefs] = useState<NotificationPreference[]>([]);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const [pushState, setPushState] = useState<PushState>({ status: 'checking' });
  const [pushBusy, setPushBusy] = useState(false);

  function load() {
    setState({ status: 'loading' });
    fetchNotificationPreferences()
      .then(({ preferences }) => {
        setPrefs(preferences);
        setState({ status: 'ready' });
      })
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(load, []);

  // Reflect actual browser/subscription state on mount — a push
  // subscription created on a different device, or revoked from browser
  // settings since last visit, should show up here without a stale
  // "subscribed" button surviving either.
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushState({ status: 'unsupported' });
      return;
    }
    if (Notification.permission === 'denied') {
      setPushState({ status: 'denied' });
      return;
    }
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        setPushState(sub ? { status: 'subscribed', endpoint: sub.endpoint } : { status: 'unsubscribed' });
      })
      .catch(() => setPushState({ status: 'unsubscribed' }));
  }, []);

  function getEnabled(notificationType: NotificationType, channel: NotificationChannel): boolean {
    return prefs.find((p) => p.notificationType === notificationType && p.channel === channel)?.enabled ?? true;
  }

  async function handleToggle(notificationType: NotificationType, channel: NotificationChannel, next: boolean) {
    const key = `${notificationType}:${channel}`;
    const previous = prefs;
    // Optimistic — a settings toggle should feel instant; revert on failure.
    setPrefs((cur) =>
      cur.some((p) => p.notificationType === notificationType && p.channel === channel)
        ? cur.map((p) => (p.notificationType === notificationType && p.channel === channel ? { ...p, enabled: next } : p))
        : [...cur, { notificationType, channel, enabled: next }]
    );
    setSavingKey(key);
    try {
      await patchNotificationPreference(notificationType, channel, next);
    } catch (err: unknown) {
      setPrefs(previous);
      show(err instanceof Error ? err.message : 'Could not save that change.', 'danger');
    } finally {
      setSavingKey(null);
    }
  }

  async function handleEnablePush() {
    setPushBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setPushState({ status: 'denied' });
        show('Push notifications need browser permission — allow notifications for this site to turn them on.', 'danger');
        return;
      }
      const { publicKey } = await fetchVapidPublicKey();
      if (!publicKey) {
        show('Push notifications are not configured on the server yet.', 'danger');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // BufferSource wants a plain ArrayBuffer-backed view; the
        // conversion helper returns Uint8Array<ArrayBufferLike>, which
        // TS's DOM lib no longer accepts here directly (SharedArrayBuffer
        // is technically included in ArrayBufferLike but not BufferSource).
        // Re-viewing the same bytes as a fresh Uint8Array<ArrayBuffer>
        // satisfies the type without copying semantics changing anything
        // at runtime.
        applicationServerKey: new Uint8Array(urlBase64ToUint8Array(publicKey)),
      });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error('Browser returned an incomplete push subscription.');
      }
      await subscribeToPush({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
      setPushState({ status: 'subscribed', endpoint: subscription.endpoint });
      show('Push notifications enabled on this device.', 'success');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Could not enable push notifications.', 'danger');
    } finally {
      setPushBusy(false);
    }
  }

  async function handleDisablePush() {
    if (pushState.status !== 'subscribed') return;
    setPushBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.getSubscription();
      await unsubscribeFromPush(pushState.endpoint);
      await subscription?.unsubscribe();
      setPushState({ status: 'unsubscribed' });
      show('Push notifications turned off on this device.', 'success');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Could not disable push notifications.', 'danger');
    } finally {
      setPushBusy(false);
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading notification preferences…" />;
  if (state.status === 'error') {
    return <ErrorState title="Couldn't load notification preferences" description={state.message} onRetry={load} />;
  }

  return (
    <div className="nx-page nx-page--narrow nx-view-enter">
      <div>
        <h2>Notifications Preferences</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
          Choose which notification types reach you in-app and via push. A type left on keeps working exactly as
          before — this screen only records the ones you turn off.
        </p>
      </div>

      <Card style={{ padding: 0 }}>
        <Table<NotificationType>
          columns={[
            { key: 'type', header: 'Notification', render: (t) => NOTIFICATION_TYPE_LABELS[t] },
            ...NOTIFICATION_CHANNELS.map((channel) => ({
              key: channel,
              header: channel === 'in_app' ? 'In-app' : 'Push',
              render: (t: NotificationType) => (
                <Checkbox
                  label=""
                  checked={getEnabled(t, channel)}
                  disabled={savingKey === `${t}:${channel}`}
                  onChange={(e) => handleToggle(t, channel, e.target.checked)}
                />
              ),
            })),
          ]}
          rows={[...NOTIFICATION_TYPES]}
          rowKey={(t) => t}
        />
      </Card>

      <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15 }}>Push notifications on this device</h3>
          <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
            Push is per-device — enabling it here only affects this browser. Your Push column above still controls
            which notification types are eligible to send.
          </p>
        </div>
        {pushState.status === 'unsupported' && (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>This browser doesn't support push notifications.</p>
        )}
        {pushState.status === 'denied' && (
          <p style={{ fontSize: 13, color: 'var(--danger)' }}>
            Notifications are blocked for this site in your browser settings. Allow them there, then reload this page.
          </p>
        )}
        {pushState.status === 'checking' && <p style={{ fontSize: 13, color: 'var(--muted)' }}>Checking…</p>}
        {pushState.status === 'unsubscribed' && (
          <div>
            <Button onClick={handleEnablePush} disabled={pushBusy}>
              {pushBusy ? 'Enabling…' : 'Enable push notifications'}
            </Button>
          </div>
        )}
        {pushState.status === 'subscribed' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 13, color: 'var(--success)' }}>✓ Enabled on this device</span>
            <Button variant="secondary" size="sm" onClick={handleDisablePush} disabled={pushBusy}>
              {pushBusy ? 'Disabling…' : 'Disable'}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
