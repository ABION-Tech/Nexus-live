// Web-side billingService — wraps apps/api/src/routes/billing.ts
// (Session 47 backend; this session adds the Settings > Billing UI the
// prior session's own "Next steps" #3 flagged as not built). Same thin
// one-function-per-route convention as superAdminService.ts — no
// business logic here, tier/limit interpretation stays in
// BILLING_TIERS (@nexus/shared) and the server's own billingService.ts.
//
// GET /invoices now goes through billingService.ts's own listInvoices
// mapper server-side (Session 47 UI follow-up cleanup), so this uses
// the shared, camelCase @nexus/shared BillingInvoice type rather than
// a hand-typed snake_case shape.
import { apiClient } from './apiClient';
import type { BillingInvoice, BillingSummary, BillingTierKey } from '@nexus/shared';

export interface BillingRawRow {
  id: string;
  org_id: string;
  tier: BillingTierKey;
  billing_status: string;
  seat_count: number;
  cascades_to_children: boolean;
  current_period_start: string | null;
  current_period_end: string | null;
  grace_period_ends_at: string | null;
}

export function fetchBillingSummary(): Promise<BillingSummary> {
  return apiClient.get<BillingSummary>('/billing');
}

/** Distinct from fetchBillingSummary — null here means "no org_billing
 * row at all" (never configured), which the summary can't distinguish
 * from plain free-tier defaults (billing.ts's own /raw comment). Used
 * to show "no plan configured yet" instead of implying free was chosen. */
export function fetchOwnBillingRow(): Promise<BillingRawRow | null> {
  return apiClient.get<{ row: BillingRawRow | null }>('/billing/raw').then((r) => r.row);
}

export function fetchBillingInvoices(): Promise<BillingInvoice[]> {
  return apiClient.get<{ invoices: BillingInvoice[] }>('/billing/invoices').then((r) => r.invoices);
}

export function startCheckout(tier: 'starter' | 'pro'): Promise<{ authorizationUrl: string; reference: string }> {
  return apiClient.post<{ authorizationUrl: string; reference: string }>('/billing/checkout', { tier });
}

/** Called from the /settings/billing/callback landing route after
 * Paystack redirects back — server-verified feedback only (billing.ts's
 * own comment: "never the source of truth," the webhook is), so this is
 * purely a "did it look like it worked" UI signal, not what actually
 * updates org_billing. */
export function verifyCheckoutCallback(reference: string): Promise<{ status: string; reference: string }> {
  return apiClient.get<{ status: string; reference: string }>(`/billing/checkout/callback?reference=${encodeURIComponent(reference)}`);
}
