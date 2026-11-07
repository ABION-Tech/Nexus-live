// Settings > Billing (ADMIN_BUILD_GUIDE.md-style leader-only page,
// Session 47's own "Next steps" #3 — backend landed that session,
// this is the UI pass). Leader-gated client-side the same way
// GuestInvites.tsx/TeamRoles.tsx already are; the real boundary is
// requireLeader() in routes/billing.ts itself. Reads GET /billing (the
// always-resolved summary, defaulting to free) for the main view, and
// GET /billing/invoices for payment history. Upgrading a tier hands off
// to Paystack's own hosted checkout (POST /billing/checkout ->
// authorizationUrl) rather than collecting card details here — this
// page never touches card data, per PRD §13's "don't touch what you
// don't have to" posture the rest of this codebase follows for anything
// payment-adjacent.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Card, Badge, ProgressBar, LoadingState, ErrorState, EmptyState, useToast } from '../../components/ui';
import type { BadgeTone } from '../../components/ui';
import {
  fetchBillingSummary,
  fetchBillingInvoices,
  startCheckout,
  verifyCheckoutCallback,
} from '../../services/billingService';
import type { CurrentUser } from '../../services/authService';
import { BILLING_TIERS, BILLING_TIER_KEYS, type BillingInvoice, type BillingSummary, type BillingTierKey } from '@nexus/shared';
import { ApiError } from '../../services/apiClient';

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; summary: BillingSummary; invoices: BillingInvoice[] };

const STATUS_TONE: Record<string, BadgeTone> = {
  active: 'success',
  past_due: 'warning',
  pending_review: 'warning',
  suspended: 'danger',
};

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  past_due: 'Past due',
  pending_review: 'Pending Super Admin review',
  suspended: 'Suspended',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Kobo -> naira display. Placeholder pricing per packages/shared's own
 * header on BILLING_TIERS — formatting is real even though the amounts
 * underneath aren't final. */
function formatKobo(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;
}

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-NG', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function Billing({ user }: { user: CurrentUser }) {
  const { show } = useToast();
  const canManage = user.role === 'leader';
  const [searchParams, setSearchParams] = useSearchParams();

  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const [checkingOut, setCheckingOut] = useState<BillingTierKey | null>(null);
  const [verifyingCallback, setVerifyingCallback] = useState(false);

  function load() {
    setState({ status: 'loading' });
    Promise.all([fetchBillingSummary(), fetchBillingInvoices()])
      .then(([summary, invoices]) => setState({ status: 'ready', summary, invoices }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(load, []);

  // Paystack checkout callback landing (routes/billing.ts builds the
  // redirect as `${webOrigin}/settings/billing/callback?...` — Paystack
  // appends its own `reference` and `trxref` params on top). Handled
  // here, not a separate component, so a bare /settings/billing/callback
  // route (registered in app/App.tsx) can render this same page and
  // still show the rest of the billing view underneath the verification
  // banner. Runs once per landed reference, not on every render.
  useEffect(() => {
    const reference = searchParams.get('reference') ?? searchParams.get('trxref');
    if (!reference) return;
    setVerifyingCallback(true);
    verifyCheckoutCallback(reference)
      .then((result) => {
        if (result.status === 'success') {
          show('Payment confirmed — your plan has been updated.', 'success');
        } else {
          show(`Payment status: ${result.status}. It may take a moment to reflect.`, 'default');
        }
        load();
      })
      .catch((err: unknown) => {
        show(err instanceof Error ? err.message : 'Could not verify the payment.', 'danger');
      })
      .finally(() => {
        setVerifyingCallback(false);
        searchParams.delete('reference');
        searchParams.delete('trxref');
        setSearchParams(searchParams, { replace: true });
      });
    // Only re-run if the reference itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('reference'), searchParams.get('trxref')]);

  async function handleUpgrade(tier: BillingTierKey) {
    setCheckingOut(tier);
    try {
      const { authorizationUrl } = await startCheckout(tier as 'starter' | 'pro');
      window.location.href = authorizationUrl;
    } catch (err: unknown) {
      const message =
        err instanceof ApiError && err.code === 'not_configured'
          ? 'Checkout is not configured yet for this plan. Contact your platform administrator.'
          : err instanceof Error
            ? err.message
            : 'Could not start checkout.';
      show(message, 'danger');
      setCheckingOut(null);
    }
  }

  if (!canManage) {
    return (
      <EmptyState
        title="Leader access required"
        description="Only a leader can view or manage this organization's billing."
      />
    );
  }

  return (
    <div className="nx-page nx-view-enter">
      <div>
        <h2>Billing</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
          Plan, usage against this billing period, and payment history. Charges are processed by Paystack — this
          page never collects or stores card details directly.
        </p>
      </div>

      {verifyingCallback && <LoadingState label="Confirming your payment…" />}
      {state.status === 'loading' && <LoadingState label="Loading billing…" />}
      {state.status === 'error' && <ErrorState title="Couldn't load billing" description={state.message} onRetry={load} />}

      {state.status === 'ready' && (
        <>
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div className="nx-row">
                  <h3>{BILLING_TIERS[state.summary.tier].label} plan</h3>
                  <Badge tone={STATUS_TONE[state.summary.billingStatus] ?? 'neutral'} dot>
                    {STATUS_LABEL[state.summary.billingStatus] ?? state.summary.billingStatus}
                  </Badge>
                </div>
                {state.summary.effectiveSourceOrgId !== state.summary.orgId && (
                  <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
                    Inherited from this organization's parent group — its plan cascades down to companies within it.
                  </p>
                )}
                {state.summary.billingStatus === 'past_due' && (
                  <p style={{ color: 'var(--accent2)', fontSize: 13, marginTop: 4 }}>
                    A recent charge failed. Access continues during the grace period
                    {state.summary.gracePeriodEndsAt ? ` (until ${formatDate(state.summary.gracePeriodEndsAt)})` : ''} —
                    update your payment method to avoid a hold on your account.
                  </p>
                )}
                {state.summary.billingStatus === 'pending_review' && (
                  <p style={{ color: 'var(--accent2)', fontSize: 13, marginTop: 4 }}>
                    This account's grace period has ended and is awaiting manual review by a platform administrator.
                  </p>
                )}
                {(state.summary.currentPeriodStart || state.summary.currentPeriodEnd) && (
                  <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
                    Current period: {formatDate(state.summary.currentPeriodStart)} – {formatDate(state.summary.currentPeriodEnd)}
                  </p>
                )}
              </div>
              {BILLING_TIERS[state.summary.tier].basePriceKobo > 0 && (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 22, fontWeight: 600 }}>{formatKobo(BILLING_TIERS[state.summary.tier].basePriceKobo)}</div>
                  <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>per month</div>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <h3 style={{ marginBottom: 12 }}>Usage this period</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <UsageRow
                label="Seats"
                used={state.summary.seatCount}
                limit={state.summary.seatLimit}
                formatValue={(n) => String(n)}
              />
              <UsageRow
                label="AI usage"
                used={state.summary.aiUsageThisPeriod}
                limit={state.summary.aiUsageLimit}
                formatValue={(n) => String(n)}
              />
              <UsageRow
                label="Storage"
                used={state.summary.storageUsedBytes}
                limit={state.summary.storageQuotaBytes}
                formatValue={formatBytes}
              />
            </div>
          </Card>

          <Card>
            <h3 style={{ marginBottom: 12 }}>Plans</h3>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {BILLING_TIER_KEYS.map((key) => {
                const tier = BILLING_TIERS[key];
                const isCurrent = key === state.summary.tier;
                const isPayable = key === 'starter' || key === 'pro';
                return (
                  <div
                    key={key}
                    style={{
                      flex: '1 1 220px',
                      border: `1px solid ${isCurrent ? 'var(--accent2)' : 'var(--border-strong)'}`,
                      borderRadius: 8,
                      padding: 16,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <div className="nx-row nx-row--between">
                      <strong>{tier.label}</strong>
                      {isCurrent && <Badge tone="info">Current</Badge>}
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 600 }}>
                      {tier.basePriceKobo > 0 ? `${formatKobo(tier.basePriceKobo)}/mo` : 'Free'}
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-dim)', fontSize: 13 }}>
                      <li>{tier.seatLimit === null ? 'Unlimited seats' : `Up to ${tier.seatLimit} seats`}</li>
                      <li>{tier.aiUsageLimit === null ? 'Unlimited AI usage' : `${tier.aiUsageLimit} AI calls / period`}</li>
                      <li>{formatBytes(tier.storageBytes)} storage</li>
                      {tier.features.length > 0 && <li>{tier.features.join(', ').replace(/_/g, ' ')}</li>}
                    </ul>
                    {isPayable && !isCurrent && (
                      <Button
                        variant="secondary"
                        onClick={() => handleUpgrade(key)}
                        disabled={checkingOut !== null}
                      >
                        {checkingOut === key ? 'Redirecting…' : `Switch to ${tier.label}`}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card>
            <h3 style={{ marginBottom: 12 }}>Payment history</h3>
            {state.invoices.length === 0 ? (
              <EmptyState title="No invoices yet" description="Payments will appear here once a charge is processed." />
            ) : (
              <div className="nx-stack nx-stack--sm">
                {state.invoices.map((inv) => (
                  <div
                    key={inv.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '10px 12px',
                      border: '1px solid var(--border-strong)',
                      borderRadius: 8,
                      fontSize: 13,
                    }}
                  >
                    <span>{formatDate(inv.paidAt ?? inv.createdAt)}</span>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{inv.paystackReference}</span>
                    <span>{formatKobo(inv.amountKobo)}</span>
                    <Badge tone={inv.status === 'success' ? 'success' : inv.status === 'failed' ? 'danger' : 'neutral'}>
                      {inv.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function UsageRow({
  label,
  used,
  limit,
  formatValue,
}: {
  label: string;
  used: number;
  limit: number | null;
  formatValue: (n: number) => string;
}) {
  const pct = limit === null ? 0 : limit === 0 ? 100 : (used / limit) * 100;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
        <span>{label}</span>
        <span style={{ color: 'var(--text-dim)' }}>
          {formatValue(used)} {limit === null ? '(unlimited)' : `/ ${formatValue(limit)}`}
        </span>
      </div>
      {limit !== null && <ProgressBar value={pct} />}
    </div>
  );
}
