// Closes next-steps item #2 from the Session 9 hardening pass
// (SESSION_LOG.md: "aiUsageService.ts test coverage — same shape of gap
// organizationService.ts had; not closed this session"). Same mocking
// posture as organizationService.test.ts: db.js's withOrgContext is
// mocked to hand back a fake client, so what's under test is this
// file's own query-shaping and aggregation logic, not Postgres/RLS
// itself — no live instance available in this environment (see
// SESSION_LOG's own "Not run: real Postgres" note).
//
// Three things this file's own header comments call out as load-bearing
// and worth pinning down directly:
//  1. recordAiUsage's row mapping (null DB columns -> undefined on the
//     wire type, per toAiUsageRecord's `?? undefined` conversions).
//  2. recordAiUsageSafely's "never throws" contract — the whole reason
//     it exists instead of callers using recordAiUsage directly.
//  3. getOrgUsageSummary's aggregation math — success/failure split,
//     token totals, average latency (including the empty-set /
//     divide-by-zero case), and per-feature breakdown seeded for all
//     four known features even when a row never exercises one of them.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeClient = { query: vi.fn() };

vi.mock('../db.js', () => ({
  pool: { query: vi.fn() },
  withOrgContext: vi.fn(async (_orgId: string, fn: (client: unknown) => unknown) => fn(fakeClient)),
}));

import { withOrgContext } from '../db.js';
import {
  getOrgUsageSummary,
  listOrgUsage,
  recordAiUsage,
  recordAiUsageSafely,
  type RecordAiUsageInput,
} from './aiUsageService.js';

const withOrgContextMock = withOrgContext as unknown as ReturnType<typeof vi.fn>;

const now = new Date('2026-08-30T00:00:00.000Z');

function usageRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'usage-1',
    org_id: 'org-1',
    actor_user_id: 'user-1',
    feature: 'chat',
    provider_target: 'chat',
    model: 'gpt-test',
    prompt_tokens: 10,
    completion_tokens: 20,
    total_tokens: 30,
    latency_ms: 500,
    success: true,
    error_message: null,
    created_at: now,
    ...overrides,
  };
}

function baseInput(overrides: Partial<RecordAiUsageInput> = {}): RecordAiUsageInput {
  return {
    orgId: 'org-1',
    actorUserId: 'user-1',
    feature: 'chat',
    providerTarget: 'chat',
    model: 'gpt-test',
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    latencyMs: 500,
    success: true,
    ...overrides,
  };
}

beforeEach(() => {
  fakeClient.query.mockReset();
  withOrgContextMock.mockClear();
});

describe('recordAiUsage', () => {
  it('inserts under the org context for the input org', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [usageRow()] });

    await recordAiUsage(baseInput());

    expect(withOrgContextMock).toHaveBeenCalledWith('org-1', expect.any(Function));
    expect(fakeClient.query).toHaveBeenCalledTimes(1);
    const [sql, params] = fakeClient.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/insert into ai_usage/i);
    expect(params).toEqual([
      'org-1',
      'user-1',
      'chat',
      'chat',
      'gpt-test',
      10,
      20,
      30,
      500,
      true,
      null, // errorMessage defaults to null, not undefined, on the wire to Postgres
    ]);
  });

  it('defaults optional fields to null params rather than omitting them', async () => {
    fakeClient.query.mockResolvedValueOnce({
      rows: [
        usageRow({
          actor_user_id: null,
          prompt_tokens: null,
          completion_tokens: null,
          total_tokens: null,
          success: false,
          error_message: 'provider timeout',
        }),
      ],
    });

    await recordAiUsage(
      baseInput({
        actorUserId: undefined,
        promptTokens: undefined,
        completionTokens: undefined,
        totalTokens: undefined,
        success: false,
        errorMessage: 'provider timeout',
      })
    );

    const [, params] = fakeClient.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['org-1', null, 'chat', 'chat', 'gpt-test', null, null, null, 500, false, 'provider timeout']);
  });

  it('maps a returned row to the wire shape, turning null columns into undefined', async () => {
    fakeClient.query.mockResolvedValueOnce({
      rows: [
        usageRow({
          actor_user_id: null,
          prompt_tokens: null,
          completion_tokens: null,
          total_tokens: null,
          error_message: null,
        }),
      ],
    });

    const result = await recordAiUsage(baseInput({ actorUserId: undefined }));

    expect(result).toEqual({
      id: 'usage-1',
      orgId: 'org-1',
      actorUserId: undefined,
      feature: 'chat',
      providerTarget: 'chat',
      model: 'gpt-test',
      promptTokens: undefined,
      completionTokens: undefined,
      totalTokens: undefined,
      latencyMs: 500,
      success: true,
      errorMessage: undefined,
      createdAt: now.toISOString(),
    });
  });

  it('propagates a write failure to the caller (recordAiUsage itself does not swallow)', async () => {
    fakeClient.query.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(recordAiUsage(baseInput())).rejects.toThrow('db unavailable');
  });
});

describe('recordAiUsageSafely', () => {
  it('resolves normally on a successful write', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [usageRow()] });

    await expect(recordAiUsageSafely(baseInput())).resolves.toBeUndefined();
  });

  it('never throws when the underlying write fails — logs instead', async () => {
    fakeClient.query.mockRejectedValueOnce(new Error('db unavailable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(recordAiUsageSafely(baseInput())).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith('[aiUsageService] failed to record AI usage', expect.any(Error));
    warnSpy.mockRestore();
  });

  it('never throws when withOrgContext itself rejects (e.g. bad org id)', async () => {
    withOrgContextMock.mockRejectedValueOnce(new Error('org not found'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(recordAiUsageSafely(baseInput())).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('listOrgUsage', () => {
  it('scopes the query to the org and orders by newest first', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [usageRow(), usageRow({ id: 'usage-2' })] });

    const result = await listOrgUsage('org-1');

    expect(withOrgContextMock).toHaveBeenCalledWith('org-1', expect.any(Function));
    const [sql, params] = fakeClient.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/order by created_at desc/i);
    expect(params).toEqual(['org-1', 100]);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('usage-1');
  });

  it('passes a custom limit through instead of the default 100', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [] });

    await listOrgUsage('org-1', 5);

    const [, params] = fakeClient.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['org-1', 5]);
  });
});

describe('getOrgUsageSummary', () => {
  it('returns a zeroed summary, with every known feature seeded, for an org with no rows', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [] });

    const result = await getOrgUsageSummary('org-1');

    expect(result).toEqual({
      totalCalls: 0,
      successCount: 0,
      failureCount: 0,
      totalTokens: 0,
      averageLatencyMs: 0, // divide-by-zero guarded, not NaN
      byFeature: {
        goal_decomposition: { calls: 0, totalTokens: 0 },
        chat: { calls: 0, totalTokens: 0 },
        report: { calls: 0, totalTokens: 0 },
        agent_handoff: { calls: 0, totalTokens: 0 },
      },
    });
  });

  it('aggregates success/failure counts, token totals, average latency, and per-feature breakdown', async () => {
    fakeClient.query.mockResolvedValueOnce({
      rows: [
        usageRow({ id: 'a', feature: 'chat', total_tokens: 30, latency_ms: 400, success: true }),
        usageRow({ id: 'b', feature: 'chat', total_tokens: 10, latency_ms: 600, success: false }),
        usageRow({ id: 'c', feature: 'goal_decomposition', total_tokens: 100, latency_ms: 1000, success: true }),
        // total_tokens null on a row must count as 0 toward totals, not blow up the sum
        usageRow({ id: 'd', feature: 'report', total_tokens: null, latency_ms: 200, success: true }),
      ],
    });

    const result = await getOrgUsageSummary('org-1');

    expect(result.totalCalls).toBe(4);
    expect(result.successCount).toBe(3);
    expect(result.failureCount).toBe(1);
    expect(result.totalTokens).toBe(140); // 30 + 10 + 100 + 0
    expect(result.averageLatencyMs).toBe(Math.round((400 + 600 + 1000 + 200) / 4));
    expect(result.byFeature.chat).toEqual({ calls: 2, totalTokens: 40 });
    expect(result.byFeature.goal_decomposition).toEqual({ calls: 1, totalTokens: 100 });
    expect(result.byFeature.report).toEqual({ calls: 1, totalTokens: 0 });
    expect(result.byFeature.agent_handoff).toEqual({ calls: 0, totalTokens: 0 }); // never exercised, still present
  });

  it('passes `since` through as a second query param and switches SQL branches when provided', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [] });
    const since = new Date('2026-08-01T00:00:00.000Z');

    await getOrgUsageSummary('org-1', since);

    const [sql, params] = fakeClient.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/created_at >= \$2/);
    expect(params).toEqual(['org-1', since]);
  });

  it('omits the `since` filter entirely when not provided (not just an ignored null param)', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [] });

    await getOrgUsageSummary('org-1');

    const [sql, params] = fakeClient.query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/created_at >=/);
    expect(params).toEqual(['org-1']);
  });
});
