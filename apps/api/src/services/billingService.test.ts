// Service-level tests for billingService.ts (Session 47 backend +
// this session's UI follow-up). db.js is mocked — this is limit/
// resolution logic under test, same posture fileService.test.ts already
// takes for its own quota checks, not an RLS/migration integration test
// (SESSION_LOG.md's own "Not run" section already flags 0025_billing.sql
// as unverified against real Postgres — that gap isn't closed here).
//
// Covers: effective-tier cascade resolution (own row wins if not free;
// otherwise a cascading parent group's row; otherwise plain free),
// checkSeatLimit/checkAiUsageLimit/hasFeature/requireFeature's
// pass/throw branches, getEffectiveStorageQuotaBytes's override
// precedence, and the three listInvoices/listBillingPendingReview/
// resolveBillingReviewEntry mappers this session added (the fix for the
// "raw select * rows sent to the client" gap flagged in the frontend
// follow-up).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeClient, poolQuery } = vi.hoisted(() => ({
  fakeClient: { query: vi.fn() },
  poolQuery: vi.fn(),
}));

vi.mock('../db.js', () => ({
  pool: { query: poolQuery },
  withOrgContext: vi.fn(async (_orgId: string, fn: (client: unknown) => unknown) => fn(fakeClient)),
}));

vi.mock('./fileService.js', () => ({
  getOrgStorageUsage: vi.fn(async () => 1024),
  getOrgStorageQuota: vi.fn(async () => 500 * 1024 * 1024),
}));

import { withOrgContext } from '../db.js';
import {
  checkSeatLimit,
  checkAiUsageLimit,
  hasFeature,
  requireFeature,
  getEffectiveStorageQuotaBytes,
  getBillingSummary,
  getOwnBillingRow,
  recomputeSeatCount,
  listInvoices,
  listBillingPendingReview,
  resolveBillingReviewEntry,
  BillingLimitError,
} from './billingService.js';

const withOrgContextMock = withOrgContext as unknown as ReturnType<typeof vi.fn>;

const FREE_ORG = 'org-free';
const STARTER_ORG = 'org-starter';
const PRO_ORG = 'org-pro';
const COMPANY_ORG = 'org-company';
const GROUP_ORG = 'org-group';

function ownBillingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'billing-1',
    org_id: FREE_ORG,
    tier: 'free',
    billing_status: 'active',
    seat_count: 0,
    cascades_to_children: false,
    paystack_customer_code: null,
    paystack_subscription_code: null,
    paystack_plan_code: null,
    current_period_start: null,
    current_period_end: null,
    grace_period_ends_at: null,
    last_payment_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  fakeClient.query.mockReset();
  poolQuery.mockReset();
  withOrgContextMock.mockClear();
});

describe('resolveEffectiveBilling (via checkSeatLimit/hasFeature)', () => {
  it('uses the org\'s own row when it exists and is not free', async () => {
    fakeClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('from org_billing where org_id = $1')) {
        return { rows: [ownBillingRow({ org_id: PRO_ORG, tier: 'pro' })] };
      }
      if (sql.includes('from org_memberships')) {
        return { rows: [{ count: '3' }] };
      }
      return { rows: [] };
    });

    // pro has no seat limit — should resolve without throwing, proving
    // the pro tier (not a free default) was the one actually applied.
    await expect(checkSeatLimit(PRO_ORG)).resolves.toBeUndefined();
  });

  it('falls through to a cascading parent group\'s tier when the org\'s own row is free/absent', async () => {
    let orgBillingCalls = 0;
    fakeClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('from org_billing where org_id = $1')) {
        orgBillingCalls += 1;
        // First call: the company's own row (none). Second call (inside
        // the parent branch): the parent group's row.
        return orgBillingCalls === 1
          ? { rows: [] }
          : { rows: [ownBillingRow({ org_id: GROUP_ORG, tier: 'pro', cascades_to_children: true })] };
      }
      if (sql.includes('from org_memberships')) {
        return { rows: [{ count: '3' }] };
      }
      return { rows: [] };
    });
    poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('from search_organizations')) {
        return { rows: [{ parent_org_id: GROUP_ORG }] };
      }
      return { rows: [] };
    });

    await expect(checkSeatLimit(COMPANY_ORG)).resolves.toBeUndefined();
  });

  it('does not cascade when the parent group\'s row has cascades_to_children = false', async () => {
    let orgBillingCalls = 0;
    fakeClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('from org_billing where org_id = $1')) {
        orgBillingCalls += 1;
        if (orgBillingCalls === 1) return { rows: [] }; // company's own row: none
        return { rows: [ownBillingRow({ org_id: GROUP_ORG, tier: 'pro', cascades_to_children: false })] };
      }
      if (sql.includes('from org_memberships')) {
        return { rows: [{ count: '6' }] }; // over free's 5-seat limit
      }
      return { rows: [] };
    });
    poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('from search_organizations')) {
        return { rows: [{ parent_org_id: GROUP_ORG }] };
      }
      return { rows: [] };
    });

    // cascades_to_children is false, so free's 5-seat limit still
    // applies even though the parent is on pro — a 6th seat should throw.
    await expect(checkSeatLimit(COMPANY_ORG)).rejects.toBeInstanceOf(BillingLimitError);
  });
});

describe('checkSeatLimit', () => {
  it('throws BillingLimitError(seat_limit) when adding a seat would exceed the tier limit', async () => {
    fakeClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('from org_billing where org_id = $1')) return { rows: [] }; // free default
      if (sql.includes('from org_memberships')) return { rows: [{ count: '5' }] }; // already at free's cap
      return { rows: [] };
    });
    poolQuery.mockResolvedValue({ rows: [{ parent_org_id: null }] });

    await expect(checkSeatLimit(FREE_ORG)).rejects.toMatchObject({ code: 'seat_limit', statusCode: 402, tier: 'free' });
  });

  it('allows a seat add under the limit', async () => {
    fakeClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('from org_billing where org_id = $1')) return { rows: [] };
      if (sql.includes('from org_memberships')) return { rows: [{ count: '2' }] };
      return { rows: [] };
    });
    poolQuery.mockResolvedValue({ rows: [{ parent_org_id: null }] });

    await expect(checkSeatLimit(FREE_ORG)).resolves.toBeUndefined();
  });
});

describe('checkAiUsageLimit', () => {
  it('throws BillingLimitError(ai_usage_limit) once the period\'s usage meets the cap', async () => {
    fakeClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('from org_billing where org_id = $1')) return { rows: [] };
      if (sql.includes('from ai_usage')) return { rows: [{ count: '50' }] }; // free's cap is 50
      return { rows: [] };
    });
    poolQuery.mockResolvedValue({ rows: [{ parent_org_id: null }] });

    await expect(checkAiUsageLimit(FREE_ORG)).rejects.toMatchObject({ code: 'ai_usage_limit', statusCode: 402 });
  });

  it('passes when usage is under the cap', async () => {
    fakeClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('from org_billing where org_id = $1')) return { rows: [] };
      if (sql.includes('from ai_usage')) return { rows: [{ count: '10' }] };
      return { rows: [] };
    });
    poolQuery.mockResolvedValue({ rows: [{ parent_org_id: null }] });

    await expect(checkAiUsageLimit(FREE_ORG)).resolves.toBeUndefined();
  });
});

describe('hasFeature / requireFeature', () => {
  it('hasFeature returns false for a feature not on the free tier', async () => {
    fakeClient.query.mockResolvedValue({ rows: [] });
    poolQuery.mockResolvedValue({ rows: [{ parent_org_id: null }] });

    await expect(hasFeature(FREE_ORG, 'automation')).resolves.toBe(false);
  });

  it('hasFeature returns true for a feature the resolved tier includes', async () => {
    fakeClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('from org_billing where org_id = $1')) {
        return { rows: [ownBillingRow({ org_id: STARTER_ORG, tier: 'starter' })] };
      }
      return { rows: [] };
    });

    await expect(hasFeature(STARTER_ORG, 'guest_invites')).resolves.toBe(true);
  });

  it('hasFeature is false when billing_status is suspended, regardless of tier', async () => {
    fakeClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('from org_billing where org_id = $1')) {
        return { rows: [ownBillingRow({ org_id: PRO_ORG, tier: 'pro', billing_status: 'suspended' })] };
      }
      return { rows: [] };
    });

    await expect(hasFeature(PRO_ORG, 'agent_handoff')).resolves.toBe(false);
  });

  it('requireFeature throws feature_not_included when the tier lacks it', async () => {
    fakeClient.query.mockResolvedValue({ rows: [] });
    poolQuery.mockResolvedValue({ rows: [{ parent_org_id: null }] });

    await expect(requireFeature(FREE_ORG, 'calendar_sync')).rejects.toMatchObject({ code: 'feature_not_included' });
  });

  it('requireFeature throws feature_not_included (suspended message) when billing is suspended even if the tier includes the feature', async () => {
    fakeClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('from org_billing where org_id = $1')) {
        return { rows: [ownBillingRow({ org_id: PRO_ORG, tier: 'pro', billing_status: 'suspended' })] };
      }
      return { rows: [] };
    });

    await expect(requireFeature(PRO_ORG, 'ai_reports')).rejects.toMatchObject({ code: 'feature_not_included' });
  });

  it('past_due and pending_review keep full feature access (grace period posture)', async () => {
    fakeClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('from org_billing where org_id = $1')) {
        return { rows: [ownBillingRow({ org_id: PRO_ORG, tier: 'pro', billing_status: 'past_due' })] };
      }
      return { rows: [] };
    });

    await expect(hasFeature(PRO_ORG, 'agent_handoff')).resolves.toBe(true);
  });
});

describe('getEffectiveStorageQuotaBytes', () => {
  it('an explicit override always wins, regardless of tier', async () => {
    await expect(getEffectiveStorageQuotaBytes(FREE_ORG, 12345)).resolves.toBe(12345);
    // No DB call should have been needed to resolve the override.
    expect(fakeClient.query).not.toHaveBeenCalled();
  });

  it('falls back to the resolved tier\'s storageBytes when no override is set', async () => {
    fakeClient.query.mockResolvedValue({ rows: [] }); // free default
    poolQuery.mockResolvedValue({ rows: [{ parent_org_id: null }] });

    await expect(getEffectiveStorageQuotaBytes(FREE_ORG, null)).resolves.toBe(500 * 1024 * 1024);
  });
});

describe('getOwnBillingRow', () => {
  it('returns null (not a free default) when no org_billing row exists', async () => {
    fakeClient.query.mockResolvedValue({ rows: [] });
    await expect(getOwnBillingRow(FREE_ORG)).resolves.toBeNull();
  });

  it('returns the row as-is when one exists', async () => {
    const row = ownBillingRow({ org_id: PRO_ORG, tier: 'pro' });
    fakeClient.query.mockResolvedValue({ rows: [row] });
    await expect(getOwnBillingRow(PRO_ORG)).resolves.toEqual(row);
  });
});

describe('recomputeSeatCount', () => {
  it('counts current org_memberships and upserts seat_count', async () => {
    fakeClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('from org_memberships')) return { rows: [{ count: '4' }] };
      if (sql.startsWith('insert into org_billing')) return { rows: [] };
      return { rows: [] };
    });

    await expect(recomputeSeatCount(FREE_ORG)).resolves.toBe(4);
    expect(fakeClient.query).toHaveBeenCalledWith(expect.stringContaining('insert into org_billing'), [FREE_ORG, 4]);
  });
});

describe('getBillingSummary', () => {
  it('assembles seat/AI/storage numbers with the resolved tier\'s limits', async () => {
    fakeClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('from org_billing where org_id = $1')) {
        return { rows: [ownBillingRow({ org_id: STARTER_ORG, tier: 'starter' })] };
      }
      if (sql.includes('from org_memberships')) return { rows: [{ count: '7' }] };
      if (sql.includes('from ai_usage')) return { rows: [{ count: '20' }] };
      return { rows: [] };
    });

    const summary = await getBillingSummary(STARTER_ORG);
    expect(summary).toMatchObject({
      orgId: STARTER_ORG,
      effectiveSourceOrgId: STARTER_ORG,
      tier: 'starter',
      billingStatus: 'active',
      seatCount: 7,
      seatLimit: 25,
      aiUsageThisPeriod: 20,
      aiUsageLimit: 500,
      storageUsedBytes: 1024,
      storageQuotaBytes: 500 * 1024 * 1024,
    });
  });
});

// ---- listInvoices / listBillingPendingReview / resolveBillingReviewEntry
// (this session's mapper additions — the frontend-followup fix for
// "raw select * rows sent straight to the client")

describe('listInvoices', () => {
  it('maps snake_case invoice rows to camelCase BillingInvoiceSummary', async () => {
    fakeClient.query.mockResolvedValue({
      rows: [
        {
          id: 'inv-1',
          paystack_reference: 'ref-abc',
          amount_kobo: 1_500_000,
          currency: 'NGN',
          status: 'success',
          paid_at: new Date('2026-08-01T00:00:00.000Z'),
          created_at: new Date('2026-08-01T00:00:00.000Z'),
        },
      ],
    });

    const invoices = await listInvoices(STARTER_ORG);
    expect(invoices).toEqual([
      {
        id: 'inv-1',
        paystackReference: 'ref-abc',
        amountKobo: 1_500_000,
        currency: 'NGN',
        status: 'success',
        paidAt: '2026-08-01T00:00:00.000Z',
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
  });

  it('maps a null paid_at through as null, not a crash', async () => {
    fakeClient.query.mockResolvedValue({
      rows: [
        {
          id: 'inv-2',
          paystack_reference: 'ref-def',
          amount_kobo: 500_000,
          currency: 'NGN',
          status: 'pending',
          paid_at: null,
          created_at: new Date('2026-08-02T00:00:00.000Z'),
        },
      ],
    });

    const [invoice] = await listInvoices(STARTER_ORG);
    expect(invoice!.paidAt).toBeNull();
  });
});

describe('listBillingPendingReview', () => {
  it('maps snake_case review-queue rows to camelCase, cross-org via the plain pool', async () => {
    poolQuery.mockResolvedValue({
      rows: [
        {
          org_id: 'org-overdue',
          org_name: 'Overdue Co',
          tier: 'pro',
          billing_status: 'pending_review',
          grace_period_ends_at: new Date('2026-08-20T00:00:00.000Z'),
          review_note: null,
          updated_at: new Date('2026-08-21T00:00:00.000Z'),
        },
      ],
    });

    const entries = await listBillingPendingReview();
    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining('list_billing_pending_review()'));
    expect(entries).toEqual([
      {
        orgId: 'org-overdue',
        orgName: 'Overdue Co',
        tier: 'pro',
        billingStatus: 'pending_review',
        gracePeriodEndsAt: '2026-08-20T00:00:00.000Z',
        reviewNote: null,
        updatedAt: '2026-08-21T00:00:00.000Z',
      },
    ]);
  });
});

describe('resolveBillingReviewEntry', () => {
  it('maps the resolved row to camelCase on a match', async () => {
    poolQuery.mockResolvedValue({
      rows: [
        {
          id: 'billing-9',
          org_id: 'org-overdue',
          tier: 'free',
          billing_status: 'active',
          seat_count: 3,
          cascades_to_children: false,
          grace_period_ends_at: null,
          review_note: 'Manually downgraded',
          updated_at: new Date('2026-08-22T00:00:00.000Z'),
        },
      ],
    });

    const result = await resolveBillingReviewEntry('org-overdue', 'free', 'active', 'Manually downgraded', 'user-admin');
    expect(result).toEqual({
      id: 'billing-9',
      orgId: 'org-overdue',
      tier: 'free',
      billingStatus: 'active',
      seatCount: 3,
      cascadesToChildren: false,
      gracePeriodEndsAt: null,
      reviewNote: 'Manually downgraded',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });
  });

  it('returns null when no org_billing row matched (all-null row shape)', async () => {
    poolQuery.mockResolvedValue({ rows: [{ id: null, org_id: null }] });
    await expect(resolveBillingReviewEntry('org-missing', null, 'active', null, 'user-admin')).resolves.toBeNull();
  });

  it('returns null when the function returns no rows at all', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await expect(resolveBillingReviewEntry('org-missing', null, 'active', null, 'user-admin')).resolves.toBeNull();
  });
});
