// Paystack provider — PRD's Provider-abstraction rule (PRD §6: UI →
// Service → Provider → External API), same tier as objectStorageProvider.ts
// and webPushProvider.ts. billingService.ts never imports this directly
// (see its own header) — only billingWebhookService.ts (processing
// inbound events) and routes/billing.ts (initiating checkout) do.
//
// One provider, Paystack only (0025_billing.sql's own `provider = 'paystack'`
// CHECK constraint is deliberately narrow, per its own comment) — no
// vendor-abstraction interface the way aiProvider.ts/objectStorageProvider.ts
// have one, because §1's locked decision names Paystack specifically, not
// "a payment provider." If a second provider is ever added, this file's
// shape becomes the template, not a premature interface today.
//
// Config read lazily inside each call (not at module load) — same
// reasoning objectStorageProvider.ts's own `client()`/`bucket()` give:
// importing this file (e.g. a test that mocks fetch) never requires
// PAYSTACK_SECRET_KEY to be set, and a missing key surfaces as a scoped
// PaystackNotConfiguredError at the point of use, not a startup crash.

import crypto from 'node:crypto';

const PAYSTACK_API_BASE = 'https://api.paystack.co';

export class PaystackNotConfiguredError extends Error {
  constructor() {
    super('Paystack is not configured — set PAYSTACK_SECRET_KEY.');
    this.name = 'PaystackNotConfiguredError';
  }
}

export class PaystackApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'PaystackApiError';
  }
}

function secretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new PaystackNotConfiguredError();
  return key;
}

async function paystackRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${PAYSTACK_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const body = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: T } | null;
  if (!res.ok || !body?.status) {
    throw new PaystackApiError(body?.message ?? `Paystack request to ${path} failed (${res.status}).`, res.status);
  }
  return body.data as T;
}

export interface InitializeTransactionResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

/** Starts a checkout — used for both the first subscription payment and
 * a plan-change/upgrade re-authorization. `planCode` is one of the
 * PAYSTACK_PLAN_CODE_{STARTER,PRO} env vars (routes/billing.ts resolves
 * which one); omitting it makes this a one-off charge instead of a
 * subscription — not used by this session's checkout path, but left
 * possible for a future one-off invoice use case rather than a second
 * function. `metadata.orgId` is round-tripped through Paystack's own
 * payload — billingWebhookService.ts reads it back off the webhook
 * event to resolve which org a payment belongs to for a first-time
 * subscriber (no org_billing row with a matching customer code exists
 * yet at that point — see that file's own comment on the two org-
 * resolution paths). */
export async function initializeTransaction(params: {
  email: string;
  amountKobo: number;
  planCode?: string;
  orgId: string;
  callbackUrl: string;
}): Promise<InitializeTransactionResult> {
  const data = await paystackRequest<{ authorization_url: string; access_code: string; reference: string }>(
    '/transaction/initialize',
    {
      method: 'POST',
      body: JSON.stringify({
        email: params.email,
        amount: params.amountKobo,
        plan: params.planCode,
        callback_url: params.callbackUrl,
        metadata: { orgId: params.orgId },
      }),
    }
  );
  return { authorizationUrl: data.authorization_url, accessCode: data.access_code, reference: data.reference };
}

export interface VerifyTransactionResult {
  status: 'success' | 'failed' | 'abandoned';
  reference: string;
  amountKobo: number;
  customerCode: string;
  customerEmail: string;
  planCode: string | null;
  orgId: string | null; // from metadata.orgId, if present (see initializeTransaction's own comment)
}

/** Server-side confirmation of a transaction's real outcome — never
 * trust the client-side redirect alone (PRD §13.4's "don't trust the
 * client" posture); routes/billing.ts's own /checkout/callback calls
 * this before showing success, same as billingWebhookService.ts calling
 * it (or trusting the webhook payload directly) on charge.success. */
export async function verifyTransaction(reference: string): Promise<VerifyTransactionResult> {
  const data = await paystackRequest<{
    status: string;
    reference: string;
    amount: number;
    customer: { customer_code: string; email: string };
    plan?: { plan_code: string } | null;
    metadata?: { orgId?: string } | null;
  }>(`/transaction/verify/${encodeURIComponent(reference)}`);
  return {
    status: data.status as VerifyTransactionResult['status'],
    reference: data.reference,
    amountKobo: data.amount,
    customerCode: data.customer.customer_code,
    customerEmail: data.customer.email,
    planCode: data.plan?.plan_code ?? null,
    orgId: data.metadata?.orgId ?? null,
  };
}

/** HMAC-SHA512 signature check on the raw request body, Paystack's own
 * documented verification method (X-Paystack-Signature header) — the
 * only thing standing between this public webhook endpoint and anyone
 * on the internet POSTing a fabricated charge.success. Uses the raw
 * string body, not a re-serialized JSON.stringify(parsed) — those are
 * not guaranteed byte-identical (key order, whitespace), and Paystack
 * signs the exact bytes it sent. */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) return false;
  const expected = crypto.createHmac('sha512', key).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}
