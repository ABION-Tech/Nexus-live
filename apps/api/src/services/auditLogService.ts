// auditLogService.ts — ADMIN_BUILD_GUIDE.md §3 "Session 4 — Super Admin
// backend" (repo Session 40): "auditLogService.ts write-side, wired into
// org/guest admin actions." audit_log's schema landed in
// 0016_admin_foundation.sql (Session 37, schema only, per that session's
// own scope note); this is its first real caller.
//
// Two write paths, matching the table's own org_id-nullable design
// (PRD §13.10 / 0016's own column comment: "null for platform-level
// actions"):
//   - logOrgAction: the common case — an action taken inside a real org
//     context (a leader edits their own org's name, a group admin views
//     a child company, etc). Goes through withOrgContext like every
//     other org-scoped write in this codebase.
//   - logPlatformAction: a Super Admin action with no single owning org
//     (create a group, change a company's plan, reassign a company
//     between groups). Routed through insert_platform_audit_log()
//     (0021_audit_log_platform_insert_fn.sql) — a plain raw-pool insert
//     with org_id=null and a RETURNING clause fails under audit_log's
//     own SELECT policy (confirmed live this session; see that
//     migration's header for the full repro), so this is not a stylistic
//     choice, it's the only path that actually returns the written row.
//
// Both are "safely" variants by default (never throw) for the same
// reason aiUsageService.recordAiUsageSafely never throws: a successful
// admin action must not come back to the caller as an error just
// because the *audit write* failed. The route layer calls the safe
// variant after the real action succeeds or fails, logging either way.
import { pool, withOrgContext } from '../db.js';
import type { AuditLogEntry, AuditResult } from '@nexus/shared';

interface AuditLogRow {
  id: string;
  timestamp: Date;
  user_id: string | null;
  org_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  session_id: string | null;
  result: AuditResult;
  previous_value: unknown;
  new_value: unknown;
  metadata: Record<string, unknown> | null;
}

function toAuditLogEntry(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    timestamp: row.timestamp.toISOString(),
    userId: row.user_id ?? undefined,
    orgId: row.org_id ?? undefined,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id ?? undefined,
    ipAddress: row.ip_address ?? undefined,
    userAgent: row.user_agent ?? undefined,
    sessionId: row.session_id ?? undefined,
    result: row.result,
    previousValue: row.previous_value ?? undefined,
    newValue: row.new_value ?? undefined,
    metadata: row.metadata ?? undefined,
  };
}

export interface AuditLogInput {
  userId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  result: AuditResult;
  ipAddress?: string;
  userAgent?: string;
  sessionId?: string;
  previousValue?: unknown;
  newValue?: unknown;
  metadata?: Record<string, unknown>;
  // Session 11 (ADMIN_BUILD_GUIDE.md §5). `userId` above is deliberately
  // left as whatever the caller was already passing (almost always
  // `user.userId`) — during impersonation that's the *target's* id,
  // which is correct: an org's own activity log should show the
  // target's name doing the thing, not leak that staff were behind the
  // wheel. This field is the separate, additive trail: pass
  // `user.impersonatedBy` straight through (see sessionService.ts's
  // SessionUser) and it's folded into `metadata` below, so the two
  // identities are both on the row without changing what `user_id`
  // means anywhere else in this codebase. Not yet wired into every
  // existing call site — see ADMIN_BUILD_GUIDE.md §5's own note that
  // that sweep is a known follow-up, not part of this session.
  impersonatedBy?: { impersonationId: string; actorUserId: string; actorName: string; mode: 'read_only' | 'write' };
}

function withImpersonationMetadata(input: AuditLogInput): Record<string, unknown> | null {
  if (!input.impersonatedBy) return input.metadata ?? null;
  return { ...(input.metadata ?? {}), impersonatedBy: input.impersonatedBy };
}

export async function logOrgAction(orgId: string, input: AuditLogInput): Promise<AuditLogEntry> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<AuditLogRow>(
      `insert into audit_log (
         user_id, org_id, action, resource_type, resource_id, result,
         ip_address, user_agent, session_id, previous_value, new_value, metadata
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       returning *`,
      [
        input.userId ?? null,
        orgId,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        input.result,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        input.sessionId ?? null,
        input.previousValue ?? null,
        input.newValue ?? null,
        withImpersonationMetadata(input),
      ]
    );
    return toAuditLogEntry(rows[0]!);
  });
}

export async function logPlatformAction(input: AuditLogInput): Promise<AuditLogEntry> {
  const { rows } = await pool.query<AuditLogRow>(
    `select * from insert_platform_audit_log($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.userId ?? null,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      input.result,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      input.sessionId ?? null,
      input.previousValue ?? null,
      input.newValue ?? null,
      withImpersonationMetadata(input),
    ]
  );
  return toAuditLogEntry(rows[0]!);
}

/** What route handlers actually call — never throws, same posture as
 * aiUsageService.recordAiUsageSafely (see this file's own header). */
export async function logOrgActionSafely(orgId: string, input: AuditLogInput): Promise<void> {
  try {
    await logOrgAction(orgId, input);
  } catch (err) {
    console.warn('[auditLogService] failed to record org-scoped audit entry', err);
  }
}

export async function logPlatformActionSafely(input: AuditLogInput): Promise<void> {
  try {
    await logPlatformAction(input);
  } catch (err) {
    console.warn('[auditLogService] failed to record platform-level audit entry', err);
  }
}

export interface AuditLogSearchParams {
  orgId?: string;
  userId?: string;
  action?: string;
  resourceType?: string;
  result?: AuditResult;
  since?: Date;
  until?: Date;
  limit?: number;
}

/** Read side — routed through search_audit_log (0019), the
 * nexus_bootstrap-owned function built for exactly this cross-org,
 * no-single-target query shape. Caller (routes/admin/superAdmin.ts) is
 * responsible for gating this on isPlatformAdmin() before it's ever
 * reached — this function itself does no authorization, same trust
 * split organizationService.ts's platform-only functions already take
 * (JS checks first, DB function just answers the query). */
export async function searchAuditLog(params: AuditLogSearchParams): Promise<AuditLogEntry[]> {
  const { rows } = await pool.query<AuditLogRow>(
    `select * from search_audit_log($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.orgId ?? null,
      params.userId ?? null,
      params.action ?? null,
      params.resourceType ?? null,
      params.result ?? null,
      params.since ?? null,
      params.until ?? null,
      params.limit ?? 100,
    ]
  );
  return rows.map(toAuditLogEntry);
}
