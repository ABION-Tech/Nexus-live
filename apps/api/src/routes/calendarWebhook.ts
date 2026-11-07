// PRD §13.8-style isolation applied to Google, not n8n: this is the one
// NEXUS endpoint the public internet can reach without a NEXUS session,
// because Google Calendar push notifications (routes/calendar.ts's
// maybeRegisterChannel registers these) have no NEXUS identity to send.
// Deliberately its own file/prefix, not nested under calendar.ts's
// requireAuth-gated plugin, so it is never accidentally caught by that
// hook (Fastify plugin encapsulation already guarantees this, but the
// separate file makes it obvious on inspection too).
//
// Google's Calendar push notification contract: no body, just headers
// (X-Goog-Channel-Id, X-Goog-Resource-State, X-Goog-Channel-Token, ...),
// and it expects a fast 2xx or it will retry with backoff and eventually
// give up — which is exactly why the reconciliation sweep
// (routes/calendarMaintenance.ts) exists as a safety net rather than
// this being the only sync trigger.
import type { FastifyInstance } from 'fastify';
import { resolveSubscriptionByChannelId, verifyChannelToken, incrementalSync } from '../services/calendarSyncService.js';

export async function registerCalendarWebhookRoutes(app: FastifyInstance) {
  app.post('/', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const channelId = req.headers['x-goog-channel-id'] as string | undefined;
    const resourceState = req.headers['x-goog-resource-state'] as string | undefined;
    const token = req.headers['x-goog-channel-token'] as string | undefined;

    // Always 200 on a structurally-unrecognizable request — never give
    // an unauthenticated caller a way to distinguish "wrong secret" from
    // "not a real channel" from "malformed request" via status code.
    if (!channelId || !token) {
      reply.status(200).send();
      return;
    }

    // 'sync' is the one-time confirmation message Google sends
    // immediately after watchCalendar registers the channel — it carries
    // no actual change, acking it is the entire job.
    if (resourceState === 'sync') {
      reply.status(200).send();
      return;
    }

    const subscription = await resolveSubscriptionByChannelId(channelId);
    if (!subscription) {
      // Unknown or deactivated channel — Google doesn't stop sending to
      // a channel we never explicitly stopped (e.g. one orphaned by a
      // process crash between watchCalendar and the DB write). Ack
      // rather than error so Google doesn't retry indefinitely; nothing
      // here for it to retry into.
      reply.status(200).send();
      return;
    }

    if (!verifyChannelToken(subscription.id, token)) {
      req.log.warn({ channelId }, 'Calendar webhook token verification failed');
      reply.status(200).send(); // see note above — don't leak verification outcome via status
      return;
    }

    try {
      await incrementalSync(subscription.orgId, subscription.id);
    } catch (err) {
      // Sync failure is already recorded on the subscription row by
      // incrementalSync itself (last_sync_error). Still ack 200 — a 5xx
      // here just makes Google retry the same notification, and the
      // reconciliation sweep will pick this subscription up regardless.
      req.log.error({ err, subscriptionId: subscription.id }, 'Calendar webhook-triggered sync failed');
    }

    reply.status(200).send();
  });
}
