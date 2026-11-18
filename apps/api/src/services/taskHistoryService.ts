// Session 60 (C-12) — a task's history: who created it, who changed what
// (before → after), who archived it, who was added or removed.
//
// Read from activity_log (0009, PRD §13.10 "field-level change history"),
// which taskService already writes in the same transaction as every
// change — including changes made by automations (actor = none) and
// imports. One row per changed column; rows written by one change share
// a timestamp and actor, so they're grouped back into one entry here.
import { withOrgContext } from '../db.js';
import type { TaskHistoryEntry } from '@nexus/shared';

/** activity_log stores column names; the app speaks Task field names. */
const FIELD: Record<string, string> = {
  title: 'title',
  description: 'description',
  status: 'status',
  priority: 'priority',
  start_date: 'startDate',
  deadline: 'deadline',
  assigned_to_user_id: 'assignedToUserId',
  support_user_id: 'supportUserId',
  supervisor_user_id: 'supervisorUserId',
  depends_on_task_id: 'dependsOnTaskId',
  goal_id: 'goalId',
  project_id: 'projectId',
  business: 'business',
  department: 'department',
  archived_at: 'archivedAt',
  recurrence: 'recurrence', // Session 60 (0047)
  follow_up_hours: 'followUpHours',
  estimate_minutes: 'estimateMinutes',
  'people:assignee': 'people:assignee',
  'people:support': 'people:support',
};
/** Bookkeeping columns that mean nothing to a reader. */
const HIDDEN = new Set(['pre_block_status']);

interface Row {
  changed_at: Date;
  actor_user_id: string | null;
  actor_name: string | null;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
}

/** Groups one-row-per-column into one entry per change. Exported for tests. */
export function groupHistory(rows: Row[]): TaskHistoryEntry[] {
  const out: TaskHistoryEntry[] = [];
  let cur: TaskHistoryEntry | null = null;
  let curKey = '';
  for (const r of rows) {
    if (r.field && HIDDEN.has(r.field)) continue;
    const key = `${r.changed_at.toISOString()}|${r.actor_user_id ?? ''}`;
    if (r.field === null) {
      // Whole-task events: "created" (or legacy markers).
      out.push({
        id: `${key}|${r.new_value}`,
        action: r.new_value === 'created' ? 'task.created' : 'task.updated',
        at: r.changed_at.toISOString(),
        userId: r.actor_user_id ?? undefined,
        userName: r.actor_name ?? undefined,
      });
      cur = null;
      continue;
    }
    const field = FIELD[r.field] ?? r.field;
    if (field === 'archivedAt') {
      out.push({ id: `${key}|archived`, action: r.new_value ? 'task.archived' : 'task.restored', at: r.changed_at.toISOString(), userId: r.actor_user_id ?? undefined, userName: r.actor_name ?? undefined });
      cur = null;
      continue;
    }
    if (field.startsWith('people:')) {
      const role = field.slice('people:'.length);
      out.push({
        id: `${key}|${field}|${r.old_value ?? r.new_value}`,
        action: r.new_value ? 'task.assignee_added' : 'task.assignee_removed',
        at: r.changed_at.toISOString(),
        userId: r.actor_user_id ?? undefined,
        userName: r.actor_name ?? undefined,
        previous: r.old_value ? { userId: r.old_value, role } : undefined,
        next: r.new_value ? { userId: r.new_value, role } : undefined,
      });
      cur = null;
      continue;
    }
    if (!cur || curKey !== key || cur.action !== 'task.updated') {
      cur = {
        id: `${key}|u`,
        action: 'task.updated',
        at: r.changed_at.toISOString(),
        userId: r.actor_user_id ?? undefined,
        userName: r.actor_name ?? undefined,
        previous: {},
        next: {},
      };
      curKey = key;
      out.push(cur);
    }
    cur.previous![field] = r.old_value;
    cur.next![field] = r.new_value;
  }
  return out;
}

/** Newest first, from the last 500 changes. */
export async function listTaskHistory(orgId: string, taskId: string): Promise<TaskHistoryEntry[]> {
  return withOrgContext(orgId, async (c) => {
    const { rows } = await c.query<Row>(
      `select a.changed_at, a.actor_user_id, u.name as actor_name, a.field, a.old_value, a.new_value
         from activity_log a left join users u on u.id = a.actor_user_id
        where a.org_id = $1 and a.resource_type = 'tasks' and a.resource_id = $2
        order by a.changed_at desc, a.field nulls first
        limit 500`,
      [orgId, taskId]
    );
    return groupHistory(rows);
  });
}
