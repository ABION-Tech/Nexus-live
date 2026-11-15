// Session 60 (C-12) — a task's history: who created it, who changed
// what (before → after), who archived it, who was added or removed.
//
// Kept in audit_log (resource_type 'task', resource_id = task id), the
// company's own RLS-isolated log, rather than a new table: it already
// carries user, time, before/after values and the impersonation trail.
// Written by routes/tasks.ts for changes people make in the app, and by
// the import endpoint. Changes made by automations aren't recorded here.
import { withOrgContext } from '../db.js';
import { logOrgAction } from './auditLogService.js';
import type { SessionUser } from './sessionService.js';
import type { Task, TaskHistoryEntry } from '@nexus/shared';

/** The fields a person can change that are worth showing in history. */
export const TRACKED_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'startDate',
  'deadline',
  'assignedToUserId',
  'supportUserId',
  'supervisorUserId',
  'dependsOnTaskId',
  'business',
  'department',
] as const satisfies readonly (keyof Task)[];

type Tracked = (typeof TRACKED_FIELDS)[number];
type Snapshot = Partial<Record<Tracked, string | null>>;

const norm = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

/** Only the tracked fields that actually changed, as before/after pairs. */
export function diffTask(before: Partial<Task>, after: Partial<Task>): { previous: Snapshot; next: Snapshot } | null {
  const previous: Snapshot = {};
  const next: Snapshot = {};
  for (const f of TRACKED_FIELDS) {
    const a = norm(before[f]);
    const b = norm(after[f]);
    if (a !== b) {
      previous[f] = a;
      next[f] = b;
    }
  }
  return Object.keys(next).length ? { previous, next } : null;
}

export type TaskHistoryAction = 'task.created' | 'task.updated' | 'task.archived' | 'task.assignee_added' | 'task.assignee_removed';

/** Records one event. Never throws: history must not fail the change. */
export async function recordTaskEvent(
  user: SessionUser,
  taskId: string,
  action: TaskHistoryAction,
  values: { previous?: unknown; next?: unknown } = {}
): Promise<void> {
  try {
    await logOrgAction(user.orgId, {
      userId: user.userId,
      action,
      resourceType: 'task',
      resourceId: taskId,
      result: 'success',
      previousValue: values.previous ?? undefined,
      newValue: values.next ?? undefined,
      impersonatedBy: user.impersonatedBy
        ? {
            impersonationId: user.impersonatedBy.impersonationId,
            actorUserId: user.impersonatedBy.actorUserId,
            actorName: user.impersonatedBy.actorName,
            mode: user.impersonatedBy.mode,
          }
        : undefined,
    });
  } catch {
    // best effort
  }
}

/** Newest first, at most 200 entries. */
export async function listTaskHistory(orgId: string, taskId: string): Promise<TaskHistoryEntry[]> {
  return withOrgContext(orgId, async (c) => {
    const { rows } = await c.query<{
      id: string; action: string; at: Date; user_id: string | null; user_name: string | null;
      previous_value: Snapshot | null; new_value: Snapshot | null; metadata: Record<string, unknown> | null;
    }>(
      `select a.id, a.action, a."timestamp" as at, a.user_id, u.name as user_name, a.previous_value, a.new_value, a.metadata
         from audit_log a left join users u on u.id = a.user_id
        where a.org_id = $1 and a.resource_type = 'task' and a.resource_id = $2
        order by a."timestamp" desc
        limit 200`,
      [orgId, taskId]
    );
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      at: r.at.toISOString(),
      userId: r.user_id ?? undefined,
      userName: r.user_name ?? undefined,
      previous: r.previous_value ?? undefined,
      next: r.new_value ?? undefined,
      viaImpersonation: Boolean(r.metadata && 'impersonatedBy' in r.metadata),
    }));
  });
}
