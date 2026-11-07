// Task data access (PRD §8.2 / §9). First real caller of `withOrgContext`
// outside rbac.ts's own permission check (SESSION_LOG Session 6 next
// steps) — every query here runs inside it, so RLS (0001_init.sql) is the
// second, independent tenant-isolation layer per PRD §13.5; this file
// never trusts an `orgId` argument alone.
//
// No permission logic lives here — that's the route's job (requirePermission
// preHandler for the flat cases, hasPermission + an inline "own record"
// check for the ones PRD §13.3's example grants call out: `Team Member →
// tasks.own → read, update (status, notes only)`). This file only knows
// how to fetch/write rows for an org; it doesn't know who's asking.
import type { PoolClient } from 'pg';
import { withOrgContext } from '../db.js';
import { diffColumns, logActivity, logActivityCreated } from './activityLogService.js';
import type { Task, TaskListQuery, TaskPriority, TaskStatus } from '@nexus/shared';

// Exported for analyticsService.ts (PRD §8.7), which queries the same
// `tasks` table directly for its derived Failsafe lists (blocked,
// upcoming deadlines) — reusing this mapping keeps both files in sync if
// the tasks schema ever changes, instead of a second copy drifting.
export interface TaskRow {
  id: string;
  org_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority; // 0033_task_priority.sql
  start_date: Date | null; // 0034_abion_demo_seed_gaps.sql
  assigned_to_user_id: string | null;
  support_user_id: string | null;
  supervisor_user_id: string | null;
  depends_on_task_id: string | null;
  goal_id: string | null;
  source_pending_task_id: string | null;
  business: string | null;
  department: string | null;
  deadline: Date | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  marketing_content_id: string | null;
  project_id: string | null; // Session 38
  pre_block_status: string | null; // 0024 — see migration's own comment; internal to the dependency sweep, not exposed on the public Task type
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    priority: row.priority, // 0033_task_priority.sql — column has a not-null default, always present
    startDate: row.start_date ? row.start_date.toISOString().slice(0, 10) : undefined,
    assignedToUserId: row.assigned_to_user_id ?? undefined,
    supportUserId: row.support_user_id ?? undefined,
    supervisorUserId: row.supervisor_user_id ?? undefined,
    dependsOnTaskId: row.depends_on_task_id ?? undefined,
    goalId: row.goal_id ?? undefined,
    sourcePendingTaskId: row.source_pending_task_id ?? undefined,
    business: row.business ?? undefined,
    department: row.department ?? undefined,
    deadline: row.deadline?.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString(),
    marketingContentId: row.marketing_content_id ?? undefined,
    projectId: row.project_id ?? undefined, // Session 38
  };
}

const MAX_PAGE_SIZE = 100; // PRD §13.4 — no `?limit=999999`, every list endpoint caps page size.
const DEFAULT_PAGE_SIZE = 25;

/**
 * Builds the WHERE clause and its bound params in one pass, shared by the
 * count query and the select query so the two can never drift out of
 * sync with each other (the fragile version of this — renumbering
 * placeholders after the fact when count/select needed slightly
 * different clauses — is what got rewritten; see SESSION_LOG).
 *
 * `org_id = $1` is always first and always present: belt-and-suspenders
 * with RLS, per PRD §13.5, not a substitute for it.
 */
function buildWhereClause(orgId: string, query: TaskListQuery): { where: string; params: unknown[] } {
  const params: unknown[] = [orgId];
  const clauses: string[] = ['org_id = $1'];

  if (!query.includeArchived) {
    clauses.push('archived_at is null');
  }
  if (query.status) {
    params.push(query.status);
    clauses.push(`status = $${params.length}`);
  }
  if (query.priority) {
    params.push(query.priority);
    clauses.push(`priority = $${params.length}`);
  }
  if (query.assignedToUserId) {
    params.push(query.assignedToUserId);
    clauses.push(`assigned_to_user_id = $${params.length}`);
  }
  // Session 35 — "involving me": assigned OR support OR supervisor.
  // routes/tasks.ts defaults an unprivileged caller's query to this
  // filter when they didn't ask for either explicit filter themselves;
  // without this clause that default was a no-op and the query fell
  // through to org-wide, unfiltered results for that caller.
  if (query.involvingUserId) {
    params.push(query.involvingUserId);
    const p = params.length;
    clauses.push(`(assigned_to_user_id = $${p} or support_user_id = $${p} or supervisor_user_id = $${p})`);
  }
  if (query.goalId) {
    params.push(query.goalId);
    clauses.push(`goal_id = $${params.length}`);
  }
  if (query.projectId) {
    params.push(query.projectId);
    clauses.push(`project_id = $${params.length}`);
  }

  return { where: clauses.join(' and '), params };
}

export interface TaskListResult {
  tasks: Task[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listTasks(orgId: string, query: TaskListQuery): Promise<TaskListResult> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));
  const offset = (page - 1) * pageSize;

  return withOrgContext(orgId, async (client) => {
    const { where, params } = buildWhereClause(orgId, query);

    const countResult = await client.query(`select count(*)::int as total from tasks where ${where}`, params);
    const total = countResult.rows[0]?.total ?? 0;

    const listParams = [...params, pageSize, offset];
    const { rows } = await client.query<TaskRow>(
      `select * from tasks where ${where}
        order by created_at desc
        limit $${listParams.length - 1} offset $${listParams.length}`,
      listParams
    );

    return { tasks: rows.map(toTask), total, page, pageSize };
  });
}

export async function getTaskById(orgId: string, taskId: string): Promise<Task | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<TaskRow>(`select * from tasks where org_id = $1 and id = $2`, [orgId, taskId]);
    return rows[0] ? toTask(rows[0]) : null;
  });
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority; // 0033_task_priority.sql — defers to the column's 'medium' default when omitted
  startDate?: string; // 0034_abion_demo_seed_gaps.sql
  assignedToUserId?: string;
  supportUserId?: string;
  supervisorUserId?: string;
  dependsOnTaskId?: string;
  goalId?: string;
  sourcePendingTaskId?: string;
  business?: string;
  department?: string;
  deadline?: string;
  marketingContentId?: string;
  projectId?: string; // Session 38
}

/**
 * Client-level insert, no transaction of its own — used by createTask
 * (which wraps it in withOrgContext for a standalone task) and by
 * marketingService.createMarketingContent (which calls this three times
 * on the *same* client/transaction as the marketing_content insert, so
 * the calendar entry and its three stage tasks either all commit or none
 * do — nesting two independent withOrgContext calls would open a second
 * pool connection and lose that atomicity).
 */
export async function insertTaskRow(client: PoolClient, orgId: string, input: CreateTaskInput): Promise<Task> {
  const { rows } = await client.query<TaskRow>(
    `insert into tasks (
       org_id, title, description, status, priority, start_date, assigned_to_user_id, support_user_id,
       supervisor_user_id, depends_on_task_id, goal_id, source_pending_task_id,
       business, department, deadline, marketing_content_id, project_id
     ) values ($1, $2, $3, coalesce($4, 'not_started'), coalesce($5, 'medium'), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     returning *`,
    [
      orgId,
      input.title,
      input.description ?? null,
      input.status ?? null,
      input.priority ?? null, // 0033_task_priority.sql
      input.startDate ?? null, // 0034_abion_demo_seed_gaps.sql
      input.assignedToUserId ?? null,
      input.supportUserId ?? null,
      input.supervisorUserId ?? null,
      input.dependsOnTaskId ?? null,
      input.goalId ?? null,
      input.sourcePendingTaskId ?? null,
      input.business ?? null,
      input.department ?? null,
      input.deadline ?? null,
      input.marketingContentId ?? null,
      input.projectId ?? null, // Session 38
    ]
  );
  return toTask(rows[0]!);
}

export async function createTask(orgId: string, input: CreateTaskInput, actorUserId: string | null = null): Promise<Task> {
  return withOrgContext(orgId, async (client) => {
    const task = await insertTaskRow(client, orgId, input);
    await logActivityCreated(client, { orgId, actorUserId, resourceType: 'tasks', resourceId: task.id });
    return task;
  });
}

// Fields a `tasks.own` grant may touch (PRD §13.3: "Team Member →
// tasks.own → read, update (status, notes only)" — "notes" here is
// `description`, the closest existing column; there's no separate notes
// field in 0001_init.sql). The route enforces which field set a given
// caller may send; this function will update whatever's passed to it.
export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority; // 0033_task_priority.sql
  startDate?: string; // 0034_abion_demo_seed_gaps.sql
  assignedToUserId?: string | null;
  supportUserId?: string | null;
  supervisorUserId?: string | null;
  dependsOnTaskId?: string | null;
  goalId?: string | null;
  projectId?: string | null; // Session 38
  business?: string;
  department?: string;
  deadline?: string | null;
  /** 0024 — internal-only field the dependency sweep (automationJobs.ts)
   * uses to record/clear what a task's status was immediately before an
   * auto-block, so an auto-unblock can restore it rather than guessing
   * 'not_started'. No route exposes this in a request body; only
   * automationJobs.ts ever sets it. */
  preBlockStatus?: string | null;
}

const UPDATABLE_COLUMNS: Record<keyof UpdateTaskInput, string> = {
  title: 'title',
  description: 'description',
  status: 'status',
  priority: 'priority', // 0033_task_priority.sql
  startDate: 'start_date', // 0034_abion_demo_seed_gaps.sql
  assignedToUserId: 'assigned_to_user_id',
  supportUserId: 'support_user_id',
  supervisorUserId: 'supervisor_user_id',
  dependsOnTaskId: 'depends_on_task_id',
  goalId: 'goal_id',
  projectId: 'project_id',
  business: 'business',
  department: 'department',
  deadline: 'deadline',
  preBlockStatus: 'pre_block_status',
};

export async function updateTask(
  orgId: string,
  taskId: string,
  input: UpdateTaskInput,
  actorUserId: string | null = null
): Promise<Task | null> {
  const entries = Object.entries(input).filter(([, v]) => v !== undefined) as [keyof UpdateTaskInput, unknown][];
  if (entries.length === 0) return getTaskById(orgId, taskId);

  return withOrgContext(orgId, async (client) => {
    // Fetched on the same client/transaction as the update below, so this
    // is the true pre-update state — not a separate read that could race
    // against a concurrent writer.
    const { rows: beforeRows } = await client.query<TaskRow>(
      `select * from tasks where org_id = $1 and id = $2 and archived_at is null`,
      [orgId, taskId]
    );
    const before = beforeRows[0];
    if (!before) return null;

    const params: unknown[] = [orgId, taskId];
    const sets = entries.map(([key, value]) => {
      params.push(value);
      return `${UPDATABLE_COLUMNS[key]} = $${params.length}`;
    });
    sets.push('updated_at = now()');

    const { rows } = await client.query<TaskRow>(
      `update tasks set ${sets.join(', ')} where org_id = $1 and id = $2 and archived_at is null returning *`,
      params
    );
    const after = rows[0];
    if (!after) return null;

    // Only the columns actually touched by this call — not every column
    // on the row — so an update that resends an unchanged field doesn't
    // get logged, and columns nobody asked to change never enter the diff.
    const touchedColumns = entries.map(([key]) => UPDATABLE_COLUMNS[key]);
    const changes = diffColumns(before, after, touchedColumns);
    if (changes.length > 0) {
      await logActivity(client, { orgId, actorUserId, resourceType: 'tasks', resourceId: taskId, changes });
    }

    return toTask(after);
  });
}

/** PRD §6.4.1 — `DELETE /api/v1/tasks/:id → archive (not hard delete)`.
 * No route in this codebase issues a real SQL DELETE against `tasks`. */
export async function archiveTask(orgId: string, taskId: string, actorUserId: string | null = null): Promise<Task | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows: beforeRows } = await client.query<TaskRow>(
      `select * from tasks where org_id = $1 and id = $2 and archived_at is null`,
      [orgId, taskId]
    );
    const before = beforeRows[0];
    if (!before) return null;

    const { rows } = await client.query<TaskRow>(
      `update tasks set archived_at = now()
        where org_id = $1 and id = $2 and archived_at is null
        returning *`,
      [orgId, taskId]
    );
    const after = rows[0];
    if (!after) return null;

    // archived_at is the only column this mutation can touch, so it's the
    // only one worth diffing — same generic path updateTask uses, just a
    // fixed single-column list instead of the caller-chosen one.
    const changes = diffColumns(before, after, ['archived_at']);
    if (changes.length > 0) {
      await logActivity(client, { orgId, actorUserId, resourceType: 'tasks', resourceId: taskId, changes });
    }

    return toTask(after);
  });
}

// Exported for the route's inline "own record" check (PRD §13.3 check 4
// shape) — avoids a second round trip when the handler already has the
// task from getTaskById.
export function isOwnTask(task: Task, userId: string): boolean {
  return task.assignedToUserId === userId;
}

// Session 35 — task-thread visibility (routes/chat.ts's ?taskId= gate).
// Deliberately broader than isOwnTask above: a task's support and
// supervisor should be able to read/post in its chat thread even though
// neither holds the narrower `tasks.own` update grant isOwnTask exists
// for. Callers still need `getTaskById` first (this takes the task, not
// an id) — same "load then decide" shape as isOwnTask, no separate
// query.
export function canViewTaskThread(task: Task, userId: string): boolean {
  return task.assignedToUserId === userId || task.supportUserId === userId || task.supervisorUserId === userId;
}

// ---------------------------------------------------------------------
// task_assignees (0032_task_assignees.sql) — TaskDrawer.tsx's "People on
// this task" panel. Additional assignee/support people beyond the
// single primary assigned_to_user_id/support_user_id columns above; see
// the migration's own header comment for why this is a join table
// rather than array columns.
// ---------------------------------------------------------------------
export type TaskAssigneeRole = 'assignee' | 'support';

interface TaskAssigneeRow {
  id: string;
  org_id: string;
  task_id: string;
  user_id: string;
  role: TaskAssigneeRole;
  added_by_user_id: string | null;
  created_at: Date;
}

export interface TaskAssignee {
  id: string;
  taskId: string;
  userId: string;
  role: TaskAssigneeRole;
  createdAt: string;
}

function toTaskAssignee(row: TaskAssigneeRow): TaskAssignee {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listTaskAssignees(orgId: string, taskId: string): Promise<TaskAssignee[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<TaskAssigneeRow>(
      `select * from task_assignees where org_id = $1 and task_id = $2 order by created_at asc`,
      [orgId, taskId]
    );
    return rows.map(toTaskAssignee);
  });
}

/** Returns `null` (rather than throwing) when the (task_id, user_id, role)
 * triple already exists — routes/tasks.ts turns that into a 409 with the
 * same "may already be on this task" wording TaskDrawer.tsx's own error
 * copy assumes, instead of a generic 500 from a unique-constraint
 * violation. */
export async function addTaskAssignee(
  orgId: string,
  taskId: string,
  userId: string,
  role: TaskAssigneeRole,
  actorUserId: string | null = null
): Promise<TaskAssignee | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<TaskAssigneeRow>(
      `insert into task_assignees (org_id, task_id, user_id, role, added_by_user_id)
       values ($1, $2, $3, $4, $5)
       on conflict (task_id, user_id, role) do nothing
       returning *`,
      [orgId, taskId, userId, role, actorUserId]
    );
    const row = rows[0];
    if (!row) return null;
    await logActivityCreated(client, { orgId, actorUserId, resourceType: 'task_assignees', resourceId: row.id });
    return toTaskAssignee(row);
  });
}

/** Returns `false` when no matching row existed to remove (already gone,
 * or never existed) — routes/tasks.ts treats that as 404, not a silent
 * 200, so a stale client retrying a remove gets an honest answer. */
export async function removeTaskAssignee(
  orgId: string,
  taskId: string,
  userId: string,
  role: TaskAssigneeRole,
  actorUserId: string | null = null
): Promise<boolean> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `delete from task_assignees where org_id = $1 and task_id = $2 and user_id = $3 and role = $4 returning id`,
      [orgId, taskId, userId, role]
    );
    const row = rows[0];
    if (!row) return false;
    await logActivity(client, {
      orgId,
      actorUserId,
      resourceType: 'task_assignees',
      resourceId: row.id,
      changes: [{ field: null, oldValue: 'existed', newValue: 'removed' }],
    });
    return true;
  });
}

// Re-exported for tests that want to assert on client type without
// importing pg directly in the test file.
export type { PoolClient };
