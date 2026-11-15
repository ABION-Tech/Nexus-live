// Session 60 (C-05) — Paystack delivers webhooks at least once, so a
// retry must change nothing, and a genuinely new event must never be
// mistaken for a retry. (Claiming itself is tested on real Postgres in
// db.integration.test.ts.)
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../db.js', () => ({
  pool: { query: (...a: unknown[]) => query(...a) },
  withOrgContext: async (_org: string, fn: (c: { query: typeof query }) => unknown) => fn({ query }),
}));

const { deriveEventId, processWebhookEvent } = await import('./billingWebhookService.js');

describe('deriveEventId', () => {
  it('uses the transaction reference when there is one', () => {
    expect(deriveEventId({ event: 'charge.success', data: { reference: 'T123' } })).toBe('charge.success:T123');
  });

  it("keys invoices by invoice, so month two's failure isn't a 'retry' of month one's", () => {
    const sub = { subscription: { subscription_code: 'SUB_1' } };
    const nov = deriveEventId({ event: 'invoice.payment_failed', data: { invoice_code: 'INV_nov', ...sub } });
    const dec = deriveEventId({ event: 'invoice.payment_failed', data: { invoice_code: 'INV_dec', ...sub } });
    expect(nov).not.toBe(dec);
  });

  it('separates renewal cycles of the same subscription', () => {
    const a = deriveEventId({ event: 'subscription.not_renew', data: { subscription_code: 'SUB_1', next_payment_date: '2026-12-01' } });
    const b = deriveEventId({ event: 'subscription.not_renew', data: { subscription_code: 'SUB_1', next_payment_date: '2027-01-01' } });
    expect(a).not.toBe(b);
  });

  it('falls back to a hash of the body: the same for a retry, never the clock', () => {
    const body = JSON.stringify({ event: 'customeridentification.success', data: { customer: { customer_code: 'C1' } } });
    const p = JSON.parse(body);
    expect(deriveEventId(p, body)).toBe(deriveEventId(p, body));
    expect(deriveEventId(p, body)).toMatch(/^customeridentification\.success:sha256:[0-9a-f]{64}$/);
  });
});

describe('processWebhookEvent', () => {
  const charge = { event: 'charge.success', data: { reference: 'T1', amount: 500000, metadata: { orgId: 'org-1' }, customer: { customer_code: 'C1' } } };

  beforeEach(() => query.mockReset());

  it('a retry of an event already applied changes nothing', async () => {
    query.mockImplementation(async (sql: unknown) =>
      String(sql).includes('claim_billing_event') ? { rows: [{ id: 'e1', is_new: false, claimed: false }] } : { rows: [] }
    );
    const res = await processWebhookEvent(charge);
    expect(res).toEqual({ recorded: true, processed: false, orgId: 'org-1', duplicate: true });
    const sqls = query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('upsert_org_billing_for_webhook'))).toBe(false);
    expect(sqls.some((s) => s.includes('mark_billing_event_processed'))).toBe(false);
  });

  it('a new event is applied once and marked processed', async () => {
    query.mockImplementation(async (sql: unknown) =>
      String(sql).includes('claim_billing_event') ? { rows: [{ id: 'e2', is_new: true, claimed: true }] } : { rows: [] }
    );
    const res = await processWebhookEvent(charge);
    expect(res.processed).toBe(true);
    const sqls = query.mock.calls.map((c) => String(c[0]));
    expect(sqls.filter((s) => s.includes('upsert_org_billing_for_webhook'))).toHaveLength(1);
    expect(query.mock.calls.find((c) => String(c[0]).includes('mark_billing_event_processed'))?.[1]).toEqual(['e2']);
  });
});
