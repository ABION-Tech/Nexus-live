// aiUsageService.ts — ADMIN_BUILD_GUIDE.md §3 "Session 3 — AI provider
// interface + usage tracking" (repo Session 39), second half. Only
// written after AIProvider.complete()'s return-shape change (see
// integrations/aiProvider.ts) was made and verified against every
// existing caller — the guide's own required ordering, not a stylistic
// choice ("Session 3's ai_usage piece cannot start before its
// interface-change half is verified").
//
// Deliberately service-only this session, no HTTP route: the guide asks
// for "ai_usage table + aiUsageService.ts, wired to the new shape", full
// stop — a route exposing this (the "AI & Costs" dashboard) is Session
// 4/40's Super Admin backend, same "schema/service now, route later"
// split 0016_admin_foundation.sql already took with audit_log's write
// side landing in this same later session. `getOrgUsageSummary` below
// exists for that future caller and for this session's own tests to
// verify against, not because anything calls it yet.
import { withOrgContext } from '../db.js';
import type { AiUsageFeature, AiUsageRecord, AiUsageSummary, AiTestTarget } from '@nexus/shared';

interface AiUsageRow {
  id: string;
  org_id: string;
  actor_user_id: string | null;
  feature: AiUsageFeature;
  provider_target: AiTestTarget;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  latency_ms: number;
  success: boolean;
  error_message: string | null;
  created_at: Date;
}

function toAiUsageRecord(row: AiUsageRow): AiUsageRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    actorUserId: row.actor_user_id ?? undefined,
    feature: row.feature,
    providerTarget: row.provider_target,
    model: row.model,
    promptTokens: row.prompt_tokens ?? undefined,
    completionTokens: row.completion_tokens ?? undefined,
    totalTokens: row.total_tokens ?? undefined,
    latencyMs: row.latency_ms,
    success: row.success,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

export interface RecordAiUsageInput {
  orgId: string;
  actorUserId?: string;
  feature: AiUsageFeature;
  providerTarget: AiTestTarget;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  success: boolean;
  errorMessage?: string;
}

/** Writes one ai_usage row. Called from aiService.ts's four methods —
 * once per `provider.complete()` call, whether it succeeded or threw,
 * so a failed completion is still counted (feature-usage and cost
 * tracking both care that an attempt was made, not just that it
 * worked) rather than only ever logging successes. Never throws itself:
 * a logging failure must not turn into a user-facing AI-feature failure
 * — see recordAiUsageSafely below, which is what callers actually use. */
export async function recordAiUsage(input: RecordAiUsageInput): Promise<AiUsageRecord> {
  return withOrgContext(input.orgId, async (client) => {
    const { rows } = await client.query<AiUsageRow>(
      `insert into ai_usage (
         org_id, actor_user_id, feature, provider_target, model,
         prompt_tokens, completion_tokens, total_tokens, latency_ms, success, error_message
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning *`,
      [
        input.orgId,
        input.actorUserId ?? null,
        input.feature,
        input.providerTarget,
        input.model,
        input.promptTokens ?? null,
        input.completionTokens ?? null,
        input.totalTokens ?? null,
        input.latencyMs,
        input.success,
        input.errorMessage ?? null,
      ]
    );
    return toAiUsageRecord(rows[0]!);
  });
}

/** What aiService.ts actually calls — swallows a logging failure to a
 * console warning rather than letting it propagate. A goal decomposition
 * (or chat reply, or report, or agent handoff) that itself succeeded
 * must not come back to the user as an error just because the *usage
 * log write* failed; that would make observability infrastructure a new
 * source of user-facing outages, which is backwards. */
export async function recordAiUsageSafely(input: RecordAiUsageInput): Promise<void> {
  try {
    await recordAiUsage(input);
  } catch (err) {
    // Deliberate console.warn: a swallowed failure still needs to be
    // visible somewhere, and this file has no other logging channel
    // wired in yet (no systemMetricsService until Session 4/40). No
    // eslint-disable needed — this repo's config doesn't flag no-console.
    console.warn('[aiUsageService] failed to record AI usage', err);
  }
}

export async function listOrgUsage(orgId: string, limit = 100): Promise<AiUsageRecord[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<AiUsageRow>(
      `select * from ai_usage where org_id = $1 order by created_at desc limit $2`,
      [orgId, limit]
    );
    return rows.map(toAiUsageRecord);
  });
}

const ALL_FEATURES: AiUsageFeature[] = ['goal_decomposition', 'chat', 'report', 'agent_handoff'];

/** Computed on read, same posture AiReportSignals already takes for
 * task/task_trends data — no pre-aggregated rollup table for this
 * session, since nothing reads it yet (see this file's own top comment).
 * `since` is optional so a future caller (Session 4/40's dashboard) can
 * ask for a rolling window without this function itself needing to know
 * what window that dashboard wants by default. */
export async function getOrgUsageSummary(orgId: string, since?: Date): Promise<AiUsageSummary> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = since
      ? await client.query<AiUsageRow>(`select * from ai_usage where org_id = $1 and created_at >= $2`, [orgId, since])
      : await client.query<AiUsageRow>(`select * from ai_usage where org_id = $1`, [orgId]);

    const byFeature = Object.fromEntries(ALL_FEATURES.map((f) => [f, { calls: 0, totalTokens: 0 }])) as AiUsageSummary['byFeature'];
    let successCount = 0;
    let totalTokens = 0;
    let latencySum = 0;

    for (const row of rows) {
      if (row.success) successCount++;
      const tokens = row.total_tokens ?? 0;
      totalTokens += tokens;
      latencySum += row.latency_ms;
      byFeature[row.feature].calls++;
      byFeature[row.feature].totalTokens += tokens;
    }

    return {
      totalCalls: rows.length,
      successCount,
      failureCount: rows.length - successCount,
      totalTokens,
      averageLatencyMs: rows.length === 0 ? 0 : Math.round(latencySum / rows.length),
      byFeature,
    };
  });
}
