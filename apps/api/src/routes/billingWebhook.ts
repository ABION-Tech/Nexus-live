// Session 47 — the one NEXUS endpoint Paystack's servers reach without
// a NEXUS session, same class as calendarWebhook.ts (see that file's
// own header for why this is its own file/prefix rather than nested
// under an authed plugin).
//
// Needs the RAW request body (exact bytes, not Fastify's already-parsed
// JSON) because paystackProvider.verifyWebhookSignature signs/checks the
// literal bytes Paystack sent — re-serializing a parsed object is not
// guaranteed byte-identical (key order, whitespace) and would make
// signature verification unreliable. `addContentTypeParser` here is
// scoped to this plugin's own encapsulation context (Fastify plugin
// isolation — same guarantee calendarWebhook.ts's header leans on for
// "never accidentally caught by requireAuth"), so it does not change
// how any other route in this codebase parses JSON.
import type { FastifyInstance } from 'fastify';
import { verifyWebhookSignature } from '../integrations/paystackProvider.js';
import { processWebhookEvent } from '../services/billingWebhookService.js';

export async function registerBillingWebhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body); // keep the raw string; this route parses it itself after verification
  });

  app.post('/', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const rawBody = req.body as unknown as string;
    const signature = req.headers['x-paystack-signature'] as string | undefined;

    if (typeof rawBody !== 'string' || !verifyWebhookSignature(rawBody, signature)) {
      // Always ack 200 on a failed/missing signature — same "don't leak
      // verification outcome via status code" posture
      // calendarWebhook.ts's own token check already takes. A non-200
      // here would just make Paystack retry the same unsigned/forged
      // request indefinitely.
      req.log.warn('Paystack webhook signature verification failed');
      reply.status(200).send();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      reply.status(200).send(); // malformed body from a signature-valid caller shouldn't happen; ack and drop
      return;
    }

    try {
      await processWebhookEvent(parsed);
    } catch (err) {
      // Recorded and marked unprocessed by processWebhookEvent itself
      // before this throw — still ack 200 so Paystack doesn't retry into
      // the same failure; billing_events.processed=false is the durable
      // record for manual reconciliation, same posture
      // calendarWebhook.ts's own sync-failure handling takes.
      req.log.error({ err }, 'Paystack webhook processing failed');
    }

    reply.status(200).send();
  });
}
