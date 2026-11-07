// Super Admin > Billing Review Queue (ADMIN_BUILD_GUIDE.md §3 "Session
// 5" shell; this screen is Session 47's own "Next steps" #3 — the
// backend (superAdmin.ts's "Billing review queue" block) landed with no
// UI). §1's locked decision: a past-due org that runs out its grace
// period lands in `billing_status = 'pending_review'` for a platform
// admin to resolve by hand, never an automatic suspend — this page is
// the entire Super Admin side of that. Same list-then-drill-in shape as
// SuperOrganizations.tsx, but the "drill-in" here is a resolve action
// (comp back to a tier, downgrade, or suspend), not an edit form.
import { useEffect, useState } from 'react';
import { Button, Card, Badge, Modal, Select, Input, LoadingState, ErrorState, EmptyState, useToast } from '../../components/ui';
import type { BadgeTone } from '../../components/ui';
import {
  fetchBillingReviewQueue,
  resolveBillingReview,
} from '../../services/superAdminService';
import { BILLING_TIER_KEYS, BILLING_STATUS_KEYS, BILLING_TIERS, type BillingReviewQueueEntry } from '@nexus/shared';

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: BillingReviewQueueEntry[] };

const STATUS_TONE: Record<string, BadgeTone> = {
  active: 'success',
  past_due: 'warning',
  pending_review: 'warning',
  suspended: 'danger',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-NG', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function daysOverdue(graceEndsAt: string | null): number | null {
  if (!graceEndsAt) return null;
  const diffMs = Date.now() - new Date(graceEndsAt).getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

export function SuperBilling() {
  const { show } = useToast();
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [resolving, setResolving] = useState<BillingReviewQueueEntry | null>(null);

  function load() {
    setState({ status: 'loading' });
    fetchBillingReviewQueue()
      .then((entries) => setState({ status: 'ready', entries }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(load, []);

  function handleResolved() {
    setResolving(null);
    load();
  }

  return (
    <div className="nx-page nx-view-enter">
      <div>
        <h2>Billing Review Queue</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
          Organizations whose grace period ended after a failed charge, waiting on a manual decision. Nothing here
          is auto-suspended — access continued through the grace period per policy; resolving an entry is the only
          way it leaves this queue.
        </p>
      </div>

      {state.status === 'loading' && <LoadingState label="Loading review queue…" />}
      {state.status === 'error' && <ErrorState title="Couldn't load the review queue" description={state.message} onRetry={load} />}

      {state.status === 'ready' && (
        state.entries.length === 0 ? (
          <EmptyState title="Nothing pending review" description="No organization is currently awaiting a billing decision." />
        ) : (
          <div className="nx-stack nx-stack--md">
            {state.entries.map((entry) => {
              const overdue = daysOverdue(entry.gracePeriodEndsAt);
              return (
                <Card key={entry.orgId}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                    <div>
                      <div className="nx-row">
                        <strong>{entry.orgName}</strong>
                        <Badge tone={STATUS_TONE[entry.billingStatus] ?? 'neutral'} dot>
                          {entry.billingStatus}
                        </Badge>
                        <Badge tone="neutral">{BILLING_TIERS[entry.tier as keyof typeof BILLING_TIERS]?.label ?? entry.tier}</Badge>
                      </div>
                      <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
                        Grace period ended {formatDate(entry.gracePeriodEndsAt)}
                        {overdue !== null && ` — ${overdue} day${overdue === 1 ? '' : 's'} overdue`}
                      </p>
                      {entry.reviewNote && (
                        <p style={{ fontSize: 13, marginTop: 4 }}>
                          <span style={{ color: 'var(--text-dim)' }}>Note: </span>
                          {entry.reviewNote}
                        </p>
                      )}
                    </div>
                    <Button onClick={() => setResolving(entry)}>Resolve</Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )
      )}

      {resolving && (
        <ResolveModal
          entry={resolving}
          onClose={() => setResolving(null)}
          onResolved={handleResolved}
          onError={(message) => show(message, 'danger')}
        />
      )}
    </div>
  );
}

function ResolveModal({
  entry,
  onClose,
  onResolved,
  onError,
}: {
  entry: BillingReviewQueueEntry;
  onClose: () => void;
  onResolved: () => void;
  onError: (message: string) => void;
}) {
  const { show } = useToast();
  const [tier, setTier] = useState(entry.tier);
  const [billingStatus, setBillingStatus] = useState('active');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      await resolveBillingReview(entry.orgId, { tier, billingStatus, note: note.trim() || undefined });
      show(`Billing resolved for ${entry.orgName}.`, 'success');
      onResolved();
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : 'Could not resolve this entry.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Resolve billing — ${entry.orgName}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 320 }}>
        <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          Comp them back onto their existing tier if the retry succeeded outside the webhook path, downgrade to
          free, or suspend. This always clears the pending grace window regardless of which way you resolve it.
        </p>
        <Select
          label="Tier"
          value={tier}
          onChange={(e) => setTier(e.target.value as typeof tier)}
          options={BILLING_TIER_KEYS.map((k) => ({ value: k, label: BILLING_TIERS[k].label }))}
        />
        <Select
          label="Billing status"
          value={billingStatus}
          onChange={(e) => setBillingStatus(e.target.value)}
          options={BILLING_STATUS_KEYS.map((k) => ({ value: k, label: k.replace(/_/g, ' ') }))}
        />
        <Input
          label="Note (optional)"
          placeholder="e.g. Confirmed manual payment via bank transfer"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>{submitting ? 'Resolving…' : 'Resolve'}</Button>
        </div>
      </div>
    </Modal>
  );
}
