// billingWebhookService.ts — Session 47. The one place inbound Paystack
// events turn into org_billing state changes. routes/billingWebhook.ts
// (signature verification, raw body) is deliberately thin and calls
// straight into `processWebhookEvent` here — same "route is the thin
// HTTP layer, service holds the actual logic" split every other route/
// service pair in this codebase already follows.
//
// Org resolution has no single path — a webhook arrives with no NEXUS
// session and, for a brand-new subscriber's very first charge.success,
// no existing org_billing row with a matching customer code either
// (that row is what THIS event is about to create). Two paths, tried in
// order:
//   1. payload.data.metadata.orgId — set by paystackProvider's own
//      initializeTransaction at checkout time (routes/billing.ts's
//      /checkout), present on the transaction/charge object Paystack
//      echoes back. Covers first-time subscribe.
//   2. find_org_billing_by_customer_code / _by_subscription_code — for
//      every later event on an existing subscription (renewal,
//      cancellation, payment failure), where metadata isn't always
//      re-sent by Paystack but the org already has a row keyed by
//      customer/subscription code from path 1's own first write.
// An event that resolves to neither is recorded (org_id null, same
// audit_log-style carve-out 0025's own header describes) and left
// unprocessed for manual reconciliation — never silently dropped.
import { createHash } from 'node:crypto';
import { pool, withOrgContext } from '../db.js';

const RESOLVABLE_EVENT_TYPES = new Set([
  'charge.success',
  'subscription.create',
  'subscription.disable',
  'subscription.not_renew',
  'invoice.payment_failed',
  'invoice.update',
]);

interface PaystackEventPayload {
  event: string;
  data: {
    reference?: string;
    /** invoice.* events: one per billing period. */
    invoice_code?: string;
    id?: number | string;
    amount?: number;
    status?: string;
    customer?: { customer_code?: string; email?: string };
    subscription_code?: string;
    plan?: { plan_code?: string } | string | null;
    metadata?: { orgId?: string } | null;
    subscription?: { subscription_code?: string } | null;
    paid_at?: string | null;
    next_payment_date?: string | null;
  };
}

/** Stable dedupe key for billing_events' (provider, provider_event_id)
 * unique constraint. Paystack retries deliver the same body again, so the
 * key must be identical for a retry and different for a genuinely new
 * event. Session 60 (C-05) fixed two ways it wasn't:
 *  - invoice.* events were keyed by subscription_code alone, so the
 *    second month's failed charge on a subscription looked like a retry
 *    of the first month's and was dropped. They now use invoice_code.
 *  - the last-resort key used Date.now(), so a retry never matched. It
 *    now hashes the body, which a retry repeats exactly. */
export function deriveEventId(payload: PaystackEventPayload, rawBody?: string): string {
  const d = payload.data ?? {};
  if (d.reference) return `${payload.event}:${d.reference}`;
  if (d.invoice_code) return `${payload.event}:${d.invoice_code}`;
  const sub = d.subscription_code ?? d.subscription?.subscription_code;
  if (sub) {
    // Subscription lifecycle events happen once per state change; include
    // the period date when present so a renewal cycle is its own event.
    const period = d.next_payment_date ?? d.paid_at;
    return `${payload.event}:${sub}${period ? `:${period}` : ''}`;
  }
  const body = rawBody ?? JSON.stringify(payload);
  return `${payload.event}:sha256:${createHash('sha256').update(body).digest('hex')}`;
}

async function resolveOrgId(payload: PaystackEventPayload): Promise<string | null> {
  const metaOrgId = payload.data.metadata?.orgId;
  if (metaOrgId) return metaOrgId;

  const customerCode = payload.data.customer?.customer_code;
  if (customerCode) {
    const { rows } = await pool.query<{ org_id: string }>(
      `select org_id from find_org_billing_by_customer_code($1)`,
      [customerCode]
    );
    if (rows[0]?.org_id) return rows[0].org_id;
  }

  const subscriptionCode = payload.data.subscription_code ?? payload.data.subscription?.subscription_code;
  if (subscriptionCode) {
    const { rows } = await pool.query<{ org_id: string }>(
      `select org_id from find_org_billing_by_subscription_code($1)`,
      [subscriptionCode]
    );
    if (rows[0]?.org_id) return rows[0].org_id;
  }

  return null;
}

function planCodeToTier(planCode: string | null | undefined): 'starter' | 'pro' | null {
  if (!planCode) return null;
  if (planCode === process.env.PAYSTACK_PLAN_CODE_STARTER) return 'starter';
  if (planCode === process.env.PAYSTACK_PLAN_CODE_PRO) return 'pro';
  return null; // an unrecognized plan code updates status/dates but never guesses a tier
}

/** Applies one resolved event's effect to org_billing. Called only after
 * an org_id is known — the caller (processWebhookEvent) is responsible
 * for the "no org resolved" branch. */
async function applyEvent(orgId: string, payload: PaystackEventPayload): Promise<void> {
  const planCode =
    typeof payload.data.plan === 'string' ? payload.data.plan : payload.data.plan?.plan_code ?? null;
  const tier = planCodeToTier(planCode);
  const customerCode = payload.data.customer?.customer_code ?? null;
  const subscriptionCode = payload.data.subscription_code ?? payload.data.subscription?.subscription_code ?? null;

  switch (payload.event) {
    case 'charge.success': {
      await pool.query(
        `select upsert_org_billing_for_webhook($1, $2, 'active', $3, $4, $5, $6, $7, null, $8, true)`,
        [
          orgId,
          tier, // null leaves tier unchanged for a renewal charge whose plan code wasn't recognized
          customerCode,
          subscriptionCode,
          planCode,
          payload.data.paid_at ?? new Date().toISOString(),
          payload.data.next_payment_date ?? null,
          payload.data.paid_at ?? new Date().toISOString(),
        ]
      );
      if (payload.data.reference && payload.data.amount) {
        await withOrgContext(orgId, async (client) => {
          await client.query(
            `insert into billing_invoices (org_id, paystack_reference, amount_kobo, status, paid_at)
             values ($1, $2, $3, 'success', $4)
             on conflict (org_id, paystack_reference) do nothing`,
            [orgId, payload.data.reference, payload.data.amount, payload.data.paid_at ?? new Date().toISOString()]
          );
        });
      }
      return;
    }

    case 'invoice.payment_failed': {
      // §1's locked grace-period decision: a failed charge does NOT cut
      // access immediately. Status moves to 'past_due' (billingService's
      // own hasFeature/requireFeature keep full access for this status —
      // see that file's own comment) with a grace window; the sweep
      // (automationJobs.ts's runBillingGraceCheck) is what escalates an
      // unresolved past_due row to 'pending_review' once the grace
      // window closes, not this handler.
      const gracePeriodEndsAt = new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
      await pool.query(
        `select upsert_org_billing_for_webhook($1, null, 'past_due', $2, $3, null, null, null, $4, null, false)`,
        [orgId, customerCode, subscriptionCode, gracePeriodEndsAt]
      );
      if (payload.data.reference) {
        await withOrgContext(orgId, async (client) => {
          await client.query(
            `insert into billing_invoices (org_id, paystack_reference, amount_kobo, status)
             values ($1, $2, $3, 'failed')
             on conflict (org_id, paystack_reference) do nothing`,
            [orgId, payload.data.reference, payload.data.amount ?? 0]
          );
        });
      }
      return;
    }

    case 'subscription.disable':
    case 'subscription.not_renew': {
      // A cancellation, not a failed charge — no grace period applies
      // (there's nothing pending to retry); this org simply reverts to
      // free at the end of its already-paid period. Downgrading `tier`
      // immediately (rather than waiting for current_period_end to
      // pass) matches this session's "hard cap, checked live" posture
      // elsewhere (billingService.ts's own header) over building a
      // second scheduled-downgrade mechanism for one edge case.
      await pool.query(
        `select upsert_org_billing_for_webhook($1, 'free', 'active', $2, $3, null, null, null, null, null, true)`,
        [orgId, customerCode, subscriptionCode]
      );
      return;
    }

    case 'subscription.create':
    case 'invoice.update':
    default:
      // Recorded (see processWebhookEvent) but no org_billing state
      // change — these carry no new fact this table needs beyond what
      // charge.success already captures for the same subscription.
      return;
  }
}

const GRACE_PERIOD_DAYS = 7; // §1's own scoping doc figure — a week between a failed charge and mandatory review.

export interface WebhookProcessResult {
  recorded: boolean;
  processed: boolean;
  orgId: string | null;
  /** Session 60: this delivery was a retry of an event already applied
   * (or being applied right now), so nothing was changed. */
  duplicate?: boolean;
}

/** Entry point called by routes/billingWebhook.ts once the signature is
 * verified. Always records first, before any state change, so an incoming
 * Paystack event is durably kept even if applying it fails.
 *
 * Session 60 (C-05): claim_billing_event (0045) decides whether this
 * delivery may apply the event. A retry of an event that was already
 * applied — or that another delivery is applying right now — changes
 * nothing. A retry of an event whose earlier attempt failed is applied
 * again (after 5 minutes). */
export async function processWebhookEvent(rawPayload: unknown, rawBody?: string): Promise<WebhookProcessResult> {
  const payload = rawPayload as PaystackEventPayload;
  if (!payload?.event) {
    return { recorded: false, processed: false, orgId: null };
  }

  const orgId = await resolveOrgId(payload);
  const eventId = deriveEventId(payload, rawBody);

  const { rows } = await pool.query<{ id: string; is_new: boolean; claimed: boolean }>(
    `select id, is_new, claimed from claim_billing_event($1, $2, $3, $4)`,
    [orgId, payload.event, eventId, JSON.stringify(payload)]
  );
  const claim = rows[0];
  if (!claim) return { recorded: false, processed: false, orgId };
  if (!claim.claimed) return { recorded: true, processed: false, orgId, duplicate: true };
  const eventRowId = claim.id;

  if (!orgId || !RESOLVABLE_EVENT_TYPES.has(payload.event)) {
    // Recorded either way — org-less (needs manual reconciliation) or a
    // real event type this handler has nothing to do for.
    await pool.query(`select mark_billing_event_processed($1, $2, $3)`, [
      eventRowId,
      Boolean(orgId),
      orgId ? null : 'No org resolved from customer/subscription code or metadata.',
    ]);
    return { recorded: true, processed: Boolean(orgId), orgId };
  }

  try {
    await applyEvent(orgId, payload);
    await pool.query(`select mark_billing_event_processed($1, true, null)`, [eventRowId]);
    return { recorded: true, processed: true, orgId };
  } catch (err) {
    await pool.query(`select mark_billing_event_processed($1, false, $2)`, [
      eventRowId,
      err instanceof Error ? err.message : String(err),
    ]);
    // Re-thrown so the route can decide its own response (still 200 to
    // Paystack — see routes/billingWebhook.ts).
    throw err;
  }
}
