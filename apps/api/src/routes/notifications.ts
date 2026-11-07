// Settings > Notifications Preferences + push subscription lifecycle +
// inbox. Bundled into one route file under one prefix (same "related
// concerns, one file" shape routes/billing.ts already uses for
// checkout/summary/invoices) rather than three, since all three exist
// only to support the one settings screen this session builds.
//
// Self-service only, same posture as routes/userPreferences.ts: no
// resource/action permission gate — a user's own notification
// preferences, own push subscriptions, and own inbox aren't an
// RBAC-gated action on someone else's data. requireAuth is the whole
// check on every route here.
import type { FastifyInstance } from 'fastify';
import {
  listPreferences,
  setPreference,
  isNotificationType,
  isNotificationChannel,
} from '../services/notificationPreferencesService.js';
import { subscribeToPush, unsubscribeFromPush, isPushSubscriptionInput } from '../services/pushSubscriptionService.js';
import { listInbox, markNotificationRead } from '../services/notifications/notificationService.js';
import type { NotificationChannel, NotificationType } from '@nexus/shared';

export async function registerNotificationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // --- Preferences -------------------------------------------------
  app.get('/preferences', async (req, reply) => {
    const user = req.sessionUser!;
    reply.send({ preferences: await listPreferences(user.orgId, user.userId) });
  });

  app.patch('/preferences', async (req, reply) => {
    const user = req.sessionUser!;
    const body = (req.body as { notificationType?: unknown; channel?: unknown; enabled?: unknown }) ?? {};

    if (!isNotificationType(body.notificationType)) {
      reply.status(400).send({ error: 'invalid_body', message: 'notificationType is not a recognized notification type.' });
      return;
    }
    if (!isNotificationChannel(body.channel)) {
      reply.status(400).send({ error: 'invalid_body', message: "channel must be 'in_app' or 'push'." });
      return;
    }
    if (typeof body.enabled !== 'boolean') {
      reply.status(400).send({ error: 'invalid_body', message: 'enabled must be a boolean.' });
      return;
    }

    const preference = await setPreference(
      user.orgId,
      user.userId,
      body.notificationType as NotificationType,
      body.channel as NotificationChannel,
      body.enabled
    );
    reply.send(preference);
  });

  // --- Push subscription lifecycle ----------------------------------
  // Public (no auth needed beyond requireAuth above) VAPID public key —
  // this is the "way for the client to read the public key" the build
  // called for. Only the public half; VAPID_PRIVATE_KEY never leaves
  // webPushProvider.ts. Returns null rather than 503 when unset, since
  // this route is polled by a settings screen a user might load before
  // an operator has generated keys at all — the UI hides the "enable
  // push" button on null rather than surfacing a hard error for a
  // config gap that isn't the requesting user's problem.
  app.get('/vapid-public-key', async (_req, reply) => {
    reply.send({ publicKey: process.env.VAPID_PUBLIC_KEY ?? null });
  });

  app.post('/subscribe', async (req, reply) => {
    const user = req.sessionUser!;
    const body = req.body as unknown;
    if (!isPushSubscriptionInput(body)) {
      reply.status(400).send({
        error: 'invalid_body',
        message: 'Expected { endpoint, keys: { p256dh, auth } } — the shape PushSubscription.toJSON() returns.',
      });
      return;
    }
    await subscribeToPush(user.orgId, user.userId, body);
    reply.status(204).send();
  });

  // endpoint (a full push-service URL) travels URL-encoded in the path,
  // not a DELETE body or query string — matches every other delete-by-
  // identifier route in this codebase (routes/goals.ts, routes/files.ts,
  // etc.), all of which are DELETE /:id with nothing else on the
  // request; keeping the same shape here means apps/web's apiClient.delete
  // (path-only, no body support) needs no change to call this.
  app.delete('/subscribe/:endpoint', async (req, reply) => {
    const user = req.sessionUser!;
    const { endpoint } = req.params as { endpoint: string };
    await unsubscribeFromPush(user.orgId, user.userId, decodeURIComponent(endpoint));
    reply.status(204).send();
  });

  // --- Inbox ---------------------------------------------------------
  app.get('/inbox', async (req, reply) => {
    const user = req.sessionUser!;
    const query = req.query as { unreadOnly?: string; limit?: string };
    const notifications = await listInbox(user.orgId, user.userId, {
      unreadOnly: query.unreadOnly === 'true',
      limit: query.limit ? Number(query.limit) : undefined,
    });
    reply.send({ notifications });
  });

  app.patch('/inbox/:id/read', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };
    const found = await markNotificationRead(user.orgId, user.userId, id);
    if (!found) {
      reply.status(404).send({ error: 'not_found', message: 'No unread notification with that id.' });
      return;
    }
    reply.status(204).send();
  });
}
