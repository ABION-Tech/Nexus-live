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
 * unique constraint — Paystack doesn't send one canonical event id in
 * every payload shape, so this is derived: reference (when present, the
 * more specific identifier) or a type+customer+timestamp fallback.
 * Prevents Paystack's documented at-least-once retry delivery from
 * double-applying the same event (e.g. crediting a payment twice). */
function deriveEventId(payload: PaystackEventPayload): string {
  const ref = payload.data.reference || payload.data.subscription_code;
  if (ref) return `${payload.event}:${ref}`;
  const customer = payload.data.customer?.customer_code ?? 'unknown';
  return `${payload.event}:${customer}:${payload.data.paid_at ?? payload.data.next_payment_date ?? Date.now()}`;
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
}

/** Entry point called by routes/billingWebhook.ts once the signature is
 * verified. Always records first (`record_billing_event`, before any
 * org resolution or state change) — a parsing/lookup failure downstream
 * must never mean an incoming Paystack event was never durably recorded
 * at all, same posture 0025_billing.sql's own header describes for that
 * function. */
export async function processWebhookEvent(rawPayload: unknown): Promise<WebhookProcessResult> {
  const payload = rawPayload as PaystackEventPayload;
  if (!payload?.event) {
    return { recorded: false, processed: false, orgId: null };
  }

  const orgId = await resolveOrgId(payload);
  const eventId = deriveEventId(payload);

  const { rows } = await pool.query<{ id: string }>(`select id from record_billing_event($1, $2, $3, $4)`, [
    orgId,
    payload.event,
    eventId,
    JSON.stringify(payload),
  ]);
  const eventRowId = rows[0]?.id;

  if (!orgId || !RESOLVABLE_EVENT_TYPES.has(payload.event)) {
    // Recorded either way — org-less (needs manual reconciliation) or a
    // real event type this handler has nothing to do for (e.g. a
    // Paystack event type not in RESOLVABLE_EVENT_TYPES at all).
    if (eventRowId) {
      await pool.query(`select mark_billing_event_processed($1, $2, $3)`, [
        eventRowId,
        Boolean(orgId),
        orgId ? null : 'No org resolved from customer/subscription code or metadata.',
      ]);
    }
    return { recorded: true, processed: Boolean(orgId), orgId };
  }

  try {
    await applyEvent(orgId, payload);
    if (eventRowId) {
      await pool.query(`select mark_billing_event_processed($1, true, null)`, [eventRowId]);
    }
    return { recorded: true, processed: true, orgId };
  } catch (err) {
    if (eventRowId) {
      await pool.query(`select mark_billing_event_processed($1, false, $2)`, [
        eventRowId,
        err instanceof Error ? err.message : String(err),
      ]);
    }
    // Re-thrown so the route can decide its own response (still 200 to
    // Paystack — see routes/billingWebhook.ts's own comment on always
    // acking receipt regardless of processing outcome, same as
    // calendarWebhook.ts's posture).
    throw err;
  }
}
