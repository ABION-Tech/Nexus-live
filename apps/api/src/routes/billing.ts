// PRD's Billing page, Session 47. Leader-only, same direct
// `role === 'leader'` gate as guests.ts (see that file's own comment) —
// billing is an org-admin action, not a `permissions` table grant; there
// is no `billing` resource in the permission system by design.
//
// This file only ever reads/writes through billingService.ts and
// paystackProvider.ts — it never touches org_billing directly (mirrors
// billingService.ts's own header: "the one service everything else
// calls").
import type { FastifyInstance } from 'fastify';
import { getBillingSummary, getOwnBillingRow, listInvoices } from '../services/billingService.js';
import { initializeTransaction, verifyTransaction, PaystackNotConfiguredError, PaystackApiError } from '../integrations/paystackProvider.js';
import { BILLING_TIERS, type BillingTierKey } from '@nexus/shared';

const PAYABLE_TIERS: BillingTierKey[] = ['starter', 'pro'];

function requireLeader(req: any, reply: any): boolean {
  const user = req.sessionUser!;
  if (user.role !== 'leader') {
    reply.status(403).send({ error: 'forbidden', message: 'Only a leader can manage billing.' });
    return false;
  }
  return true;
}

function planCodeForTier(tier: BillingTierKey): string | undefined {
  if (tier === 'starter') return process.env.PAYSTACK_PLAN_CODE_STARTER;
  if (tier === 'pro') return process.env.PAYSTACK_PLAN_CODE_PRO;
  return undefined;
}

export async function registerBillingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (req, reply) => {
    if (!requireLeader(req, reply)) return;
    const user = req.sessionUser!;
    const summary = await getBillingSummary(user.orgId);
    reply.send(summary);
  });

  // Distinct from the summary above — routes/admin/superAdmin.ts's own
  // review queue wants "does this org have a paid row at all," which
  // getBillingSummary can't answer on its own (it always resolves to at
  // least free-tier defaults, per billingService.ts's own header).
  app.get('/raw', async (req, reply) => {
    if (!requireLeader(req, reply)) return;
    const user = req.sessionUser!;
    const row = await getOwnBillingRow(user.orgId);
    reply.send({ row });
  });

  app.get('/invoices', async (req, reply) => {
    if (!requireLeader(req, reply)) return;
    const user = req.sessionUser!;
    const invoices = await listInvoices(user.orgId);
    reply.send({ invoices });
  });

  app.post('/checkout', async (req, reply) => {
    if (!requireLeader(req, reply)) return;
    const user = req.sessionUser!;
    const body = req.body as { tier?: string };
    if (!body?.tier || !PAYABLE_TIERS.includes(body.tier as BillingTierKey)) {
      reply.status(400).send({ error: 'invalid_body', message: `tier must be one of ${PAYABLE_TIERS.join(', ')}.` });
      return;
    }
    const tier = body.tier as BillingTierKey;
    const planCode = planCodeForTier(tier);
    if (!planCode) {
      reply.status(503).send({
        error: 'not_configured',
        message: `No Paystack plan code configured for the ${tier} tier. Set PAYSTACK_PLAN_CODE_${tier.toUpperCase()}.`,
      });
      return;
    }

    const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
    try {
      const result = await initializeTransaction({
        email: user.email,
        amountKobo: BILLING_TIERS[tier].basePriceKobo,
        planCode,
        orgId: user.orgId,
        callbackUrl: `${webOrigin}/settings/billing/callback`,
      });
      reply.send({ authorizationUrl: result.authorizationUrl, reference: result.reference });
    } catch (err) {
      if (err instanceof PaystackNotConfiguredError) {
        reply.status(503).send({ error: 'not_configured', message: err.message });
        return;
      }
      if (err instanceof PaystackApiError) {
        reply.status(502).send({ error: 'paystack_error', message: err.message });
        return;
      }
      throw err;
    }
  });

  // Client-side redirect landing point after Paystack's checkout —
  // never the source of truth for whether payment actually applies
  // (that's the webhook, routes/billingWebhook.ts, arriving
  // asynchronously and independently of this call). This just gives the
  // Billing page immediate, server-verified UI feedback ("did the charge
  // succeed") rather than trusting Paystack's own client-side redirect
  // params, per PRD §13.4's "don't trust the client" posture.
  app.get('/checkout/callback', async (req, reply) => {
    if (!requireLeader(req, reply)) return;
    const q = req.query as { reference?: string };
    if (!q?.reference) {
      reply.status(400).send({ error: 'invalid_query', message: 'reference is required.' });
      return;
    }
    try {
      const result = await verifyTransaction(q.reference);
      reply.send({ status: result.status, reference: result.reference });
    } catch (err) {
      if (err instanceof PaystackNotConfiguredError) {
        reply.status(503).send({ error: 'not_configured', message: err.message });
        return;
      }
      if (err instanceof PaystackApiError) {
        reply.status(502).send({ error: 'paystack_error', message: err.message });
        return;
      }
      throw err;
    }
  });
}
