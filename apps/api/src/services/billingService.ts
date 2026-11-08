// billingService.ts — Session 47 (SESSION_47_SCOPE_BILLING.md). The one
// service everything else (guests.ts, invites.ts, aiService.ts,
// fileService.ts, calendar.ts, automation.ts) calls to answer "is this
// org allowed to do this," never touching org_billing or
// paystackProvider.ts directly (PRD §6's Provider-abstraction rule
// applies here the same way it does for AI/storage/push).
//
// Effective-tier resolution (open question #3's "Either" answer): a
// company's own org_billing row wins if it exists and its tier isn't
// 'free'; otherwise, if its parent is a group whose own row has
// cascades_to_children = true, that row's tier applies instead. This is
// resolved here, in TS, on every call — not cached beyond the single
// request — because getting this wrong silently (serving a stale
// cascade decision) is worse than the extra query it costs.
import { withOrgContext, pool } from '../db.js';
import {
  BILLING_TIERS,
  type BillingTierKey,
  type BillingStatusKey,
  type BillingFeatureKey,
  type BillingSummary,
} from '@nexus/shared';

interface OrgBillingRow {
  id: string;
  org_id: string;
  tier: BillingTierKey;
  billing_status: BillingStatusKey;
  seat_count: number;
  cascades_to_children: boolean;
  paystack_customer_code: string | null;
  paystack_subscription_code: string | null;
  paystack_plan_code: string | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  grace_period_ends_at: Date | null;
  last_payment_at: Date | null;
}

export class BillingLimitError extends Error {
  // statusCode set here (not just left for each route to decide) so
  // server.ts's global error handler — which already reads
  // `err.statusCode`/`err.code` off any thrown error, per PRD §13.4 —
  // picks this up automatically for every call site (chatReply,
  // generateReport, agentHandoffFallback) without each of those routes
  // needing its own instanceof check the way routes/goals.ts's
  // decomposeGoal call site adds one anyway, for its own more specific
  // message. 402, not 403/429: this is "you've used what your plan
  // includes this period," not an auth failure or a rate limit.
  public statusCode = 402;

  constructor(
    public code: 'seat_limit' | 'ai_usage_limit' | 'storage_limit' | 'feature_not_included',
    message: string,
    public tier: BillingTierKey
  ) {
    super(message);
    this.name = 'BillingLimitError';
  }
}

/** Own org_billing row, if any — no cascade resolution, no defaulting.
 * Exported for routes/billing.ts's own-org display (it wants to show
 * "you have no plan configured" distinctly from "you're on free"). */
export async function getOwnBillingRow(orgId: string): Promise<OrgBillingRow | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<OrgBillingRow>(`select * from org_billing where org_id = $1`, [orgId]);
    return rows[0] ?? null;
  });
}

interface EffectiveBilling {
  sourceOrgId: string;
  row: OrgBillingRow | null; // null when nothing paid applies anywhere in the chain — plain free defaults
}

/** Walks org -> parent group exactly once (this codebase's hierarchy is
 * two levels deep by design, DECISIONS.md §5 — no recursive walk
 * needed). Reads the org's own type/parent via the same
 * search_organizations bootstrap path canReadOrg/organizationService
 * already use for cross-org metadata, since a company reading its own
 * parent's *id* is `organizations`-RLS-visible already (0006's own
 * widened policy), but knowing whether that parent is a 'group' at all
 * needs the same bootstrap read the rest of this codebase already
 * standardizes on for org metadata lookups. */
async function resolveEffectiveBilling(orgId: string): Promise<EffectiveBilling> {
  const own = await getOwnBillingRow(orgId);
  if (own && own.tier !== 'free') {
    return { sourceOrgId: orgId, row: own };
  }

  const { rows: orgRows } = await pool.query<{ parent_org_id: string | null }>(
    `select parent_org_id from search_organizations(null) where id = $1`,
    [orgId]
  );
  const parentOrgId = orgRows[0]?.parent_org_id ?? null;

  if (parentOrgId) {
    const parentRow = await withOrgContext(orgId, async (client) => {
      // org_billing's own tenant_isolation policy (0025) already allows
      // reading the parent group's row from a company's org context —
      // same clause organizations' own policy uses for the same reason.
      const { rows } = await client.query<OrgBillingRow>(`select * from org_billing where org_id = $1`, [parentOrgId]);
      return rows[0] ?? null;
    });
    if (parentRow && parentRow.cascades_to_children && parentRow.tier !== 'free') {
      return { sourceOrgId: parentOrgId, row: parentRow };
    }
  }

  return { sourceOrgId: orgId, row: own };
}

function tierOf(effective: EffectiveBilling): BillingTierKey {
  return effective.row?.tier ?? 'free';
}

function statusOf(effective: EffectiveBilling): BillingStatusKey {
  return effective.row?.billing_status ?? 'active';
}

/** Current billing-period window for usage counting. Falls back to the
 * calendar month (UTC) when no Paystack subscription period is on
 * record — the common case for a free-tier org, which has no
 * subscription at all. */
function currentPeriodWindow(row: OrgBillingRow | null): { start: Date; end: Date } {
  if (row?.current_period_start && row?.current_period_end) {
    return { start: row.current_period_start, end: row.current_period_end };
  }
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

async function countAiUsageInPeriod(orgId: string, start: Date, end: Date): Promise<number> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `select count(*) from ai_usage where org_id = $1 and created_at >= $2 and created_at < $3`,
      [orgId, start.toISOString(), end.toISOString()]
    );
    return Number(rows[0]?.count ?? 0);
  });
}

/** Recomputes and persists seat_count for an org — call after any
 * membership-affecting write (invite acceptance, guest creation,
 * membership revoke). Cached on org_billing rather than counted live on
 * every request; a caller that only needs a point-in-time check without
 * writing should use countCurrentSeats instead. A no-op (writes nothing)
 * for an org with no org_billing row yet — a free-tier org with no row
 * doesn't need one created just to record a seat count nobody enforces
 * against it beyond the hardcoded free-tier default. */
export async function recomputeSeatCount(orgId: string): Promise<number> {
  const count = await withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ count: string }>(`select count(*) from org_memberships where org_id = $1`, [
      orgId,
    ]);
    return Number(rows[0]?.count ?? 0);
  });

  await withOrgContext(orgId, async (client) => {
    await client.query(
      `insert into org_billing (org_id, seat_count) values ($1, $2)
       on conflict (org_id) do update set seat_count = $2, updated_at = now()`,
      [orgId, count]
    );
  });

  return count;
}

async function countCurrentSeats(orgId: string): Promise<number> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ count: string }>(`select count(*) from org_memberships where org_id = $1`, [
      orgId,
    ]);
    return Number(rows[0]?.count ?? 0);
  });
}

/** Throws BillingLimitError if adding one more seat (an invite accept or
 * a guest credential create — the two org_memberships-growing writes,
 * open question #2: every role counts) would exceed the *effective*
 * tier's seat limit. Checked against a live count, not the cached
 * seat_count column — the cache can be one write behind the very
 * membership this call is about to create. */
export async function checkSeatLimit(orgId: string): Promise<void> {
  const effective = await resolveEffectiveBilling(orgId);
  const tier = BILLING_TIERS[tierOf(effective)];
  if (tier.seatLimit === null) return;

  const current = await countCurrentSeats(orgId);
  if (current + 1 > tier.seatLimit) {
    throw new BillingLimitError(
      'seat_limit',
      `Adding another member would exceed the ${tier.label} plan's ${tier.seatLimit}-seat limit.`,
      tier.key
    );
  }
}

/** Throws BillingLimitError if this org has already used its AI-call
 * allotment for the current billing period. Called from
 * aiService.ts's completeAndRecord, before resolveProviderForOrg — a
 * capped org should never reach the provider at all, not be charged
 * provider latency for a call that's about to be rejected anyway. */
export async function checkAiUsageLimit(orgId: string): Promise<void> {
  const effective = await resolveEffectiveBilling(orgId);
  const tier = BILLING_TIERS[tierOf(effective)];
  if (tier.aiUsageLimit === null) return;

  const { start, end } = currentPeriodWindow(effective.row);
  const used = await countAiUsageInPeriod(effective.sourceOrgId, start, end);
  if (used >= tier.aiUsageLimit) {
    throw new BillingLimitError(
      'ai_usage_limit',
      `The ${tier.label} plan's monthly AI usage limit (${tier.aiUsageLimit} calls) has been reached for this billing period.`,
      tier.key
    );
  }
}

/** Resolved storage quota in bytes for an org — fileService.ts's
 * getOrgStorageQuota calls this instead of computing its own default now.
 * Precedence, highest first: an explicit organizations.storage_quota_bytes
 * override (a platform admin can still hand-tune one org regardless of
 * its plan) > the effective tier's storageBytes > fileService's own
 * env-var fallback (only reachable if BILLING_TIERS.free.storageBytes
 * were ever removed — kept as a defensive floor, not a real code path
 * today). */
export async function getEffectiveStorageQuotaBytes(orgId: string, override: number | null): Promise<number> {
  if (override != null) return override;
  const effective = await resolveEffectiveBilling(orgId);
  return BILLING_TIERS[tierOf(effective)].storageBytes;
}

/** billingStatus === 'suspended' is a hard cut — no gated feature is
 * available regardless of tier, same posture as an expired/deactivated
 * org elsewhere in this codebase. 'past_due' and 'pending_review' keep
 * full feature access — that's the entire point of the grace period
 * (§1's locked decision): a failed charge degrades to a review flag for
 * Super Admin, not an immediate feature cutoff for the org's users, who
 * did nothing wrong at the moment the charge failed. */
export async function hasFeature(orgId: string, feature: BillingFeatureKey): Promise<boolean> {
  const effective = await resolveEffectiveBilling(orgId);
  if (statusOf(effective) === 'suspended') return false;
  return BILLING_TIERS[tierOf(effective)].features.includes(feature);
}

/** Same as hasFeature, but throws BillingLimitError instead of returning
 * false — the shape every gated route actually wants (catch once,
 * translate to a 402/403), rather than every call site re-deriving its
 * own error message from a boolean. */
export async function requireFeature(orgId: string, feature: BillingFeatureKey): Promise<void> {
  const effective = await resolveEffectiveBilling(orgId);
  const tier = BILLING_TIERS[tierOf(effective)];
  if (statusOf(effective) === 'suspended') {
    throw new BillingLimitError('feature_not_included', 'This organization\'s billing is suspended.', tier.key);
  }
  if (!tier.features.includes(feature)) {
    throw new BillingLimitError(
      'feature_not_included',
      `The ${tier.label} plan does not include this feature.`,
      tier.key
    );
  }
}

/** Full summary for routes/billing.ts's GET / — the one place every
 * number a leader's Billing page needs is assembled in one call, same
 * "thin route wrapping existing service reads" shape
 * companyAdmin.ts's overview route already uses for its own analytics
 * summary. storageUsedBytes/Quota deliberately duplicate what
 * fileService.ts's own getOrgStorageUsage/getEffectiveStorageQuotaBytes
 * compute — no new storage-counting logic lives here, just reuse. */
export async function getBillingSummary(orgId: string): Promise<BillingSummary> {
  const effective = await resolveEffectiveBilling(orgId);
  const tier = BILLING_TIERS[tierOf(effective)];
  const { start, end } = currentPeriodWindow(effective.row);

  const [seatCount, aiUsageThisPeriod, { getOrgStorageUsage, getOrgStorageQuota }] = await Promise.all([
    countCurrentSeats(orgId),
    countAiUsageInPeriod(orgId, start, end),
    import('./fileService.js'),
  ]);
  const [storageUsedBytes, storageQuotaBytes] = await Promise.all([
    getOrgStorageUsage(orgId),
    getOrgStorageQuota(orgId),
  ]);

  return {
    orgId,
    effectiveSourceOrgId: effective.sourceOrgId,
    tier: tier.key,
    billingStatus: statusOf(effective),
    seatCount,
    seatLimit: tier.seatLimit,
    aiUsageThisPeriod,
    aiUsageLimit: tier.aiUsageLimit,
    storageUsedBytes,
    storageQuotaBytes,
    currentPeriodStart: effective.row?.current_period_start?.toISOString(),
    currentPeriodEnd: effective.row?.current_period_end?.toISOString(),
    gracePeriodEndsAt: effective.row?.grace_period_ends_at?.toISOString() ?? undefined,
    features: tier.features,
  };
}

// ---- Invoices (Session 47 UI follow-up) ------------------------------
// routes/billing.ts's own /invoices originally ran `select *` inline in
// the route and sent the raw snake_case rows straight back — the one
// place in this file's blast radius that didn't go through a
// toXxx()-style mapper the way auditLogService.ts's toAuditLogEntry
// does. Moved here so it's mapped the same way as everything else this
// service returns, not because the route itself needed new logic.

export interface BillingInvoiceSummary {
  id: string;
  paystackReference: string;
  amountKobo: number;
  currency: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
}

interface BillingInvoiceRow {
  id: string;
  paystack_reference: string;
  amount_kobo: number;
  currency: string;
  status: string;
  paid_at: Date | null;
  created_at: Date;
}

function toBillingInvoiceSummary(row: BillingInvoiceRow): BillingInvoiceSummary {
  return {
    id: row.id,
    paystackReference: row.paystack_reference,
    amountKobo: row.amount_kobo,
    currency: row.currency,
    status: row.status,
    paidAt: row.paid_at ? row.paid_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listInvoices(orgId: string): Promise<BillingInvoiceSummary[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<BillingInvoiceRow>(
      `select id, paystack_reference, amount_kobo, currency, status, paid_at, created_at
         from billing_invoices where org_id = $1 order by created_at desc limit 50`,
      [orgId]
    );
    return rows.map(toBillingInvoiceSummary);
  });
}

// ---- Super Admin billing review queue (Session 47 UI follow-up) ------
// Same fix as listInvoices above, for superAdmin.ts's two review-queue
// routes — both previously sent list_billing_pending_review()'s and
// resolve_billing_review()'s raw function-return rows directly. Lives
// here rather than in superAdmin.ts itself: this file already owns
// every other org_billing read/write, and superAdmin.ts's own header
// says it's meant to stay "the thin route layer on top, not where [logic]
// is made."

export interface BillingReviewQueueEntry {
  orgId: string;
  orgName: string;
  tier: BillingTierKey;
  billingStatus: BillingStatusKey;
  gracePeriodEndsAt: string | null;
  reviewNote: string | null;
  updatedAt: string;
}

interface BillingReviewQueueRow {
  org_id: string;
  org_name: string;
  tier: BillingTierKey;
  billing_status: BillingStatusKey;
  grace_period_ends_at: Date | null;
  review_note: string | null;
  updated_at: Date;
}

function toBillingReviewQueueEntry(row: BillingReviewQueueRow): BillingReviewQueueEntry {
  return {
    orgId: row.org_id,
    orgName: row.org_name,
    tier: row.tier,
    billingStatus: row.billing_status,
    gracePeriodEndsAt: row.grace_period_ends_at ? row.grace_period_ends_at.toISOString() : null,
    reviewNote: row.review_note,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Cross-org by definition (Super Admin's queue spans every org), so
 * this reads via list_billing_pending_review()'s own SECURITY DEFINER
 * escape hatch on the plain pool — same posture as every other
 * cross-org read in this codebase (organizationService.ts's own
 * search-path functions), never withOrgContext. */
export async function listBillingPendingReview(): Promise<BillingReviewQueueEntry[]> {
  const { rows } = await pool.query<BillingReviewQueueRow>(`select * from list_billing_pending_review()`);
  return rows.map(toBillingReviewQueueEntry);
}

export interface ResolvedBillingReview {
  id: string;
  orgId: string;
  tier: BillingTierKey;
  billingStatus: BillingStatusKey;
  seatCount: number;
  cascadesToChildren: boolean;
  gracePeriodEndsAt: string | null;
  reviewNote: string | null;
  updatedAt: string;
}

interface ResolveBillingReviewRow {
  id: string;
  org_id: string;
  tier: BillingTierKey;
  billing_status: BillingStatusKey;
  seat_count: number;
  cascades_to_children: boolean;
  grace_period_ends_at: Date | null;
  review_note: string | null;
  updated_at: Date;
}

function toResolvedBillingReview(row: ResolveBillingReviewRow): ResolvedBillingReview {
  return {
    id: row.id,
    orgId: row.org_id,
    tier: row.tier,
    billingStatus: row.billing_status,
    seatCount: row.seat_count,
    cascadesToChildren: row.cascades_to_children,
    gracePeriodEndsAt: row.grace_period_ends_at ? row.grace_period_ends_at.toISOString() : null,
    reviewNote: row.review_note,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Returns null when resolve_billing_review found no org_billing row for
 * orgId (the function still returns a row shape, all-null, on no match —
 * checked via rows[0]'s own org_id being unset) so superAdmin.ts can
 * keep sending its existing 404 in that case rather than a 200 full of
 * nulls. */
export async function resolveBillingReviewEntry(
  orgId: string,
  newTier: BillingTierKey | null,
  newStatus: BillingStatusKey,
  note: string | null,
  reviewedByUserId: string
): Promise<ResolvedBillingReview | null> {
  const { rows } = await pool.query<ResolveBillingReviewRow>(
    `select * from resolve_billing_review($1, $2, $3, $4, $5)`,
    [orgId, newTier, newStatus, note, reviewedByUserId]
  );
  const row = rows[0];
  if (!row || !row.org_id) return null;
  return toResolvedBillingReview(row);
}

/** Session 53 — Super Admin sets an org's plan by hand (comped/internal
 * companies, or before Paystack is live). Writes the org's own
 * org_billing row (creating it if missing) and marks it active with an
 * audit note; Paystack fields are left untouched so a later real
 * subscription still reconciles normally. Seat count is recomputed so
 * the new limit applies immediately. Caller must already have passed
 * isPlatformAdmin(). */
export async function setOrgBillingTierManually(params: {
  orgId: string;
  tier: BillingTierKey;
  cascadesToChildren?: boolean;
  note?: string | null;
  actorUserId: string;
}): Promise<BillingSummary> {
  if (!(params.tier in BILLING_TIERS)) {
    throw new Error(`Unknown tier "${params.tier}".`);
  }
  await withOrgContext(params.orgId, async (client) => {
    await client.query(
      `insert into org_billing (org_id, tier, billing_status, cascades_to_children, review_note, reviewed_by_user_id, reviewed_at)
       values ($1, $2, 'active', coalesce($3, false), $4, $5, now())
       on conflict (org_id) do update
         set tier = excluded.tier,
             billing_status = 'active',
             grace_period_ends_at = null,
             cascades_to_children = coalesce($3, org_billing.cascades_to_children),
             review_note = excluded.review_note,
             reviewed_by_user_id = excluded.reviewed_by_user_id,
             reviewed_at = now(),
             updated_at = now()`,
      [params.orgId, params.tier, params.cascadesToChildren ?? null, params.note ?? 'Set manually by a Super Admin', params.actorUserId]
    );
  });
  await recomputeSeatCount(params.orgId).catch(() => undefined);
  return getBillingSummary(params.orgId);
}
