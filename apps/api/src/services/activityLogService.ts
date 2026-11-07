// Writes to `activity_log` (0009_remaining_entities.sql — "Auto Activity,
// field-level change history", PRD §13.10). Until this file existed, the
// table had zero call sites anywhere in the codebase despite being fully
// schema'd and RLS-covered — this closes that gap for the resources wired
// below. See SESSION_LOG for which resources are (and aren't yet) wired.
//
// Always call this with the *same* `client` a mutation is already running
// on inside `withOrgContext` — never open a second `withOrgContext` call
// just to log, or the log write becomes a separate transaction that can
// commit independently of the mutation it's supposedly auditing.
import type { PoolClient } from 'pg';

export interface ActivityChange {
  /** Column/field name as it appears in the resource's own DB row. `null`
   * for whole-resource events (e.g. "created") that aren't a single field
   * transition. */
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
}

export interface LogActivityParams {
  orgId: string;
  /** Null for system-initiated changes with no human actor (none exist
   * yet, but the column is nullable for when they do). */
  actorUserId: string | null;
  resourceType: string;
  resourceId: string;
  changes: ActivityChange[];
}

/** Normalizes a DB column value to activity_log's `text` columns. Dates
 * compare/store as ISO strings so a Date and its own re-fetched value are
 * never treated as "changed" just because of object identity. */
export function stringifyValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Diffs a set of named columns between a before/after row pair, using
 * `stringifyValue` so Date columns compare by value. Skips any column
 * whose before/after values are equal after stringification — an update
 * that resends the same value for a field is not a change worth logging.
 *
 * `columns` maps the DB column name to itself deliberately (not a
 * key-rename) — callers pass e.g. `['status', 'assigned_to_user_id']`,
 * the actual column names, since `field` in the log should read the same
 * as the table it came from.
 */
export function diffColumns<T extends object>(before: T, after: T, columns: string[]): ActivityChange[] {
  // Cast to an indexable shape here, at the one spot that needs it,
  // rather than widening TaskRow/etc.'s own interface with an index
  // signature just to satisfy this helper.
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;

  const changes: ActivityChange[] = [];
  for (const col of columns) {
    const oldValue = stringifyValue(b[col]);
    const newValue = stringifyValue(a[col]);
    if (oldValue !== newValue) {
      changes.push({ field: col, oldValue, newValue });
    }
  }
  return changes;
}

/** Raw insert — one row per change, single round trip. No-ops on an empty
 * change list rather than issuing a query with an empty VALUES clause. */
export async function logActivity(client: PoolClient, params: LogActivityParams): Promise<void> {
  if (params.changes.length === 0) return;

  const args: unknown[] = [];
  const rowsSql: string[] = [];
  for (const change of params.changes) {
    args.push(params.orgId, params.actorUserId, params.resourceType, params.resourceId, change.field, change.oldValue, change.newValue);
    const base = args.length - 7;
    rowsSql.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
  }

  await client.query(
    `insert into activity_log (org_id, actor_user_id, resource_type, resource_id, field, old_value, new_value)
     values ${rowsSql.join(', ')}`,
    args
  );
}

/** Convenience for whole-resource creation — logged as a single
 * `field: null` row rather than a diff against nothing, since "created"
 * isn't a field transition. */
export async function logActivityCreated(
  client: PoolClient,
  params: { orgId: string; actorUserId: string | null; resourceType: string; resourceId: string }
): Promise<void> {
  await logActivity(client, {
    orgId: params.orgId,
    actorUserId: params.actorUserId,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    changes: [{ field: null, oldValue: null, newValue: 'created' }],
  });
}
