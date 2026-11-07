// PRD §8.10 Automation / §9.1 automation_controls, automation_log. Same
// layering as every other service here — no permission logic, that's
// routes/automation.ts's job.
//
// §12 frames the 9 scheduled jobs as "a migration checklist, not a
// design question" — every org should see exactly those 9 toggles, no
// more, no fewer, so listAutomationControls seeds any missing key to its
// PRD-documented default (enabled) rather than an org organically ending
// up with a subset depending on when they first loaded the panel.
import { withOrgContext } from '../db.js';
import { AUTOMATION_CONTROL_KEYS } from '@nexus/shared';
import type { AutomationControl, AutomationControlKey, AutomationHealthEntry, AutomationLogEntry, AutomationRunLogEntry } from '@nexus/shared';
import { UNIMPLEMENTED_JOBS } from './automationJobs.js';

interface AutomationControlRow {
  id: string;
  org_id: string;
  key: string;
  enabled: boolean;
  updated_by_user_id: string | null;
  updated_at: Date;
}

interface AutomationLogRow {
  id: string;
  org_id: string;
  control_key: string;
  previous_value: boolean | null;
  new_value: boolean;
  changed_by_user_id: string | null;
  changed_at: Date;
}

function toControl(row: AutomationControlRow): AutomationControl {
  return {
    id: row.id,
    orgId: row.org_id,
    key: row.key as AutomationControlKey,
    enabled: row.enabled,
    updatedByUserId: row.updated_by_user_id ?? undefined,
    updatedAt: row.updated_at.toISOString(),
  };
}

function toLogEntry(row: AutomationLogRow): AutomationLogEntry {
  return {
    id: row.id,
    orgId: row.org_id,
    controlKey: row.control_key,
    previousValue: row.previous_value,
    newValue: row.new_value,
    changedByUserId: row.changed_by_user_id ?? undefined,
    changedAt: row.changed_at.toISOString(),
  };
}

export function isKnownAutomationKey(key: string): key is AutomationControlKey {
  return (AUTOMATION_CONTROL_KEYS as readonly string[]).includes(key);
}

/** Ensures all 9 PRD §12 keys exist for this org (default enabled=true —
 * matches the MVP's `8. Automation Controls` sheet default, per DECISIONS
 * on ports carrying MVP defaults forward unless the audit flagged a
 * reason not to), then returns all of them, ordered to match §12's own
 * table order rather than alphabetically — the toggle panel should read
 * top-to-bottom the same way the PRD's checklist does. */
export async function listAutomationControls(orgId: string): Promise<AutomationControl[]> {
  return withOrgContext(orgId, async (client) => {
    // One statement, not a loop of 9 — insert every key that doesn't
    // already have a row, leave existing rows (and their enabled state)
    // untouched via ON CONFLICT DO NOTHING.
    await client.query(
      `insert into automation_controls (org_id, key, enabled)
       select $1, k, true from unnest($2::text[]) as k
       on conflict (org_id, key) do nothing`,
      [orgId, AUTOMATION_CONTROL_KEYS as unknown as string[]]
    );

    const { rows } = await client.query<AutomationControlRow>(
      `select * from automation_controls where org_id = $1`,
      [orgId]
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));
    // Re-order to §12's table order — the query above has no ORDER BY
    // matching an array that isn't a real column, so do it here instead
    // of contorting the SQL.
    return AUTOMATION_CONTROL_KEYS.map((key) => toControl(byKey.get(key)!));
  });
}

export class UnknownAutomationKeyError extends Error {
  constructor(key: string) {
    super(`'${key}' is not one of the ${AUTOMATION_CONTROL_KEYS.length} known automation jobs (PRD §12).`);
    this.name = 'UnknownAutomationKeyError';
  }
}

/** Toggles one control and appends the audit row in the same
 * transaction (withOrgContext already runs its callback inside one) —
 * PRD §13.10's audit log must never be out of sync with the state it
 * describes. Returns the updated control, or null if this org has no
 * row for the key yet (shouldn't happen once listAutomationControls has
 * been called at least once, but a client could PATCH a key it never
 * GET'd first). */
export async function setAutomationControl(
  orgId: string,
  key: string,
  enabled: boolean,
  actorUserId: string
): Promise<AutomationControl | null> {
  if (!isKnownAutomationKey(key)) {
    throw new UnknownAutomationKeyError(key);
  }

  return withOrgContext(orgId, async (client) => {
    // Upsert rather than assume the seed row exists — same reasoning as
    // listAutomationControls: a client could PATCH before ever GETing.
    const { rows: beforeRows } = await client.query<AutomationControlRow>(
      `select * from automation_controls where org_id = $1 and key = $2`,
      [orgId, key]
    );
    const previousValue = beforeRows[0]?.enabled ?? null;

    const { rows } = await client.query<AutomationControlRow>(
      `insert into automation_controls (org_id, key, enabled, updated_by_user_id, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (org_id, key)
       do update set enabled = excluded.enabled, updated_by_user_id = excluded.updated_by_user_id, updated_at = now()
       returning *`,
      [orgId, key, enabled, actorUserId]
    );
    const after = rows[0]!;

    // Log every PATCH, even a no-op flip-to-the-same-value — PRD §13.10
    // wants "who, what, when, ... and the result," and a toggle a leader
    // clicked but that didn't change anything is still a real action
    // worth an audit row, not noise to suppress (matching activity_log's
    // own append-only, no-silent-skip stance elsewhere in this codebase).
    await client.query(
      `insert into automation_log (org_id, control_key, previous_value, new_value, changed_by_user_id)
       values ($1, $2, $3, $4, $5)`,
      [orgId, key, previousValue, enabled, actorUserId]
    );

    return toControl(after);
  });
}

export async function listAutomationLog(orgId: string, limit = 50): Promise<AutomationLogEntry[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<AutomationLogRow>(
      `select * from automation_log where org_id = $1 order by changed_at desc limit $2`,
      [orgId, Math.min(Math.max(limit, 1), 200)] // PRD §13.4 pagination enforcement — no unbounded ?limit=
    );
    return rows.map(toLogEntry);
  });
}

// ---------------------------------------------------------------------
// 0024 (Phase H) — automation_run_log. Real backing data for the
// cron-job-health half of §8.10, written by routes/automationMaintenance.ts
// (the scheduler-facing trigger, gated by a shared secret rather than a
// NEXUS session — same reason calendarMaintenance.ts's /sweep is
// unauthenticated-by-session) and read by GET /automation/health below.
// ---------------------------------------------------------------------
interface AutomationRunLogRow {
  id: string;
  org_id: string;
  job_key: string;
  started_at: Date;
  finished_at: Date;
  status: 'success' | 'error';
  detail: Record<string, unknown> | null;
  error: string | null;
}

function toRunLogEntry(row: AutomationRunLogRow): AutomationRunLogEntry {
  return {
    id: row.id,
    orgId: row.org_id,
    jobKey: row.job_key,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at.toISOString(),
    status: row.status,
    detail: row.detail ?? undefined,
    error: row.error ?? undefined,
  };
}

export interface RecordAutomationRunInput {
  orgId: string;
  jobKey: string;
  startedAt: Date;
  finishedAt: Date;
  status: 'success' | 'error';
  detail?: Record<string, unknown>;
  error?: string;
}

/** One row per (org, job_key) per maintenance-endpoint invocation —
 * called once per org in the results returned by an IMPLEMENTED_JOBS
 * entry (automationJobs.ts), not once per maintenance call, since a
 * single job run dispatches across every org that has that job enabled
 * (see automationJobs.ts's own dispatchToEnabledOrgs). startedAt/
 * finishedAt are timestamped to the whole invocation rather than
 * per-org sub-timing — see routes/automationMaintenance.ts's own
 * comment on why that's precise enough for what the health view
 * actually needs. */
export async function recordAutomationRun(input: RecordAutomationRunInput): Promise<void> {
  await withOrgContext(input.orgId, async (client) => {
    await client.query(
      `insert into automation_run_log (org_id, job_key, started_at, finished_at, status, detail, error)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.orgId,
        input.jobKey,
        input.startedAt,
        input.finishedAt,
        input.status,
        input.detail ? JSON.stringify(input.detail) : null,
        input.error ?? null,
      ]
    );
  });
}

/** One entry per §12 job (closed set, same AUTOMATION_CONTROL_KEYS order
 * as listAutomationControls), each carrying whether that job has a real
 * implementation yet (`UNIMPLEMENTED_JOBS`, automationJobs.ts's own
 * schema-gap list) and its most recent automation_run_log row, if any.
 * `lastRun` is undefined — not a fabricated "never run" row — for a
 * job that's implemented but hasn't actually been triggered by the
 * external scheduler yet; the UI is expected to render that state
 * ("not yet run") distinctly from a completed success/error run, same
 * "don't stub fake last-run data" instruction Session 31 gave itself
 * before this endpoint existed. */
export async function getAutomationHealth(orgId: string): Promise<AutomationHealthEntry[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<AutomationRunLogRow>(
      `select distinct on (job_key) * from automation_run_log where org_id = $1 order by job_key, started_at desc`,
      [orgId]
    );
    const byKey = new Map(rows.map((r) => [r.job_key, toRunLogEntry(r)]));
    return AUTOMATION_CONTROL_KEYS.map((key) => ({
      key,
      implemented: !UNIMPLEMENTED_JOBS.has(key),
      lastRun: byKey.get(key),
    }));
  });
}
