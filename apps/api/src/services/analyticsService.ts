// PRD §8.7 Analytics — Phase 1 of 4 (Task Trends + the two Failsafe
// categories that need no new schema: blocked, deadlines). EOD compliance
// and stale-partner-follow-ups are out of scope here — they depend on
// tables that don't exist yet (an EOD reports table, and §8.3 Network's
// partnerships table), tracked as later phases, not stubbed in this file.
//
// Note on scope overlap: §8.9 also lists Failsafe Alerts as "first-class
// nav item — not folded into Analytics", while §8.7 lists the same four
// categories as in-scope for Analytics. Both sections describe the same
// underlying data; this file is the one data-access layer either surface
// would call, so neither route has to duplicate the queries below.
import { withOrgContext } from '../db.js';
import type { Task, TaskPriority, TaskTrendPoint, TaskTrendQuery } from '@nexus/shared';
import type { TaskRow } from './taskService.js';
import { toTask } from './taskService.js';

// 0033_task_priority.sql — shared ORDER BY fragment so blocked/upcoming
// both rank urgent-first without duplicating the CASE list; matches the
// column's own check-constraint vocabulary (tasks.priority).
const PRIORITY_ORDER_SQL = `case priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`;

interface TaskTrendRow {
  date: Date;
  user_id: string | null;
  open_tasks: number;
  done_today: number;
  overdue: number;
  at_risk: number;
}

function toTaskTrendPoint(row: TaskTrendRow): TaskTrendPoint {
  return {
    // Date columns come back as JS Date at local midnight via `pg`; slicing
    // the ISO string is safer than toISOString() here, which would apply a
    // timezone offset and could roll the date backward or forward a day.
    date: row.date.toISOString().slice(0, 10),
    userId: row.user_id ?? undefined,
    openTasks: row.open_tasks,
    doneToday: row.done_today,
    overdue: row.overdue,
    atRisk: row.at_risk,
  };
}

const MAX_TREND_DAYS = 90; // matches task_trends' own self-pruning window (PRD §11)

export async function getTaskTrends(orgId: string, query: TaskTrendQuery): Promise<TaskTrendPoint[]> {
  return withOrgContext(orgId, async (client) => {
    const params: unknown[] = [orgId];
    const clauses = ['org_id = $1'];

    if (query.userId) {
      params.push(query.userId);
      clauses.push(`user_id = $${params.length}`);
    } else {
      // No userId → org-wide rows only (user_id is null), not "every
      // user's rows summed" — summing would silently double-count days
      // that also have an org-wide snapshot row.
      clauses.push('user_id is null');
    }
    if (query.from) {
      params.push(query.from);
      clauses.push(`date >= $${params.length}`);
    }
    if (query.to) {
      params.push(query.to);
      clauses.push(`date <= $${params.length}`);
    }

    const { rows } = await client.query<TaskTrendRow>(
      `select date, user_id, open_tasks, done_today, overdue, at_risk
         from task_trends
        where ${clauses.join(' and ')}
        order by date asc
        limit ${MAX_TREND_DAYS}`,
      params
    );
    return rows.map(toTaskTrendPoint);
  });
}

const FAILSAFE_LIST_LIMIT = 50; // an alert list, not a paginated table — PRD §13.4 cap applies here too

export interface FailsafeListQuery {
  /** Scope to one assignee — mirrors tasks.ts list route's own-record fallback. */
  assignedToUserId?: string;
}

export async function getBlockedTasks(orgId: string, query: FailsafeListQuery): Promise<Task[]> {
  return withOrgContext(orgId, async (client) => {
    const params: unknown[] = [orgId];
    const clauses = ['org_id = $1', "status = 'blocked'", 'archived_at is null'];
    if (query.assignedToUserId) {
      params.push(query.assignedToUserId);
      clauses.push(`assigned_to_user_id = $${params.length}`);
    }
    const { rows } = await client.query<TaskRow>(
      `select * from tasks where ${clauses.join(' and ')}
        order by ${PRIORITY_ORDER_SQL}, updated_at desc limit ${FAILSAFE_LIST_LIMIT}`,
      params
    );
    return rows.map(toTask);
  });
}

export async function getUpcomingDeadlines(
  orgId: string,
  query: FailsafeListQuery,
  withinDays = 7
): Promise<Task[]> {
  return withOrgContext(orgId, async (client) => {
    const params: unknown[] = [orgId, withinDays];
    const clauses = [
      'org_id = $1',
      "status != 'done'",
      'archived_at is null',
      'deadline is not null',
      // includes already-overdue deadlines, not just future ones — a
      // missed deadline is still something the Failsafe view needs to
      // surface, not something that should silently drop off the list
      `deadline <= now() + ($2 || ' days')::interval`,
    ];
    if (query.assignedToUserId) {
      params.push(query.assignedToUserId);
      clauses.push(`assigned_to_user_id = $${params.length}`);
    }
    const { rows } = await client.query<TaskRow>(
      `select * from tasks where ${clauses.join(' and ')}
        order by ${PRIORITY_ORDER_SQL}, deadline asc limit ${FAILSAFE_LIST_LIMIT}`,
      params
    );
    return rows.map(toTask);
  });
}

// 0033_task_priority.sql — feeds AiReportSignals.priorityBreakdown (PRD
// §8.8 Attention Queue / Predictions). Open = not done, not archived;
// zero-fills every priority so the AI never has to infer an absent key
// means zero (same "only reference figures present in the payload"
// contract as every other AiReportSignals field).
export async function getOpenTaskPriorityBreakdown(orgId: string): Promise<Record<TaskPriority, number>> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ priority: TaskPriority; count: string }>(
      `select priority, count(*)::text as count from tasks
        where org_id = $1 and archived_at is null and status != 'done'
        group by priority`,
      [orgId]
    );
    const breakdown: Record<TaskPriority, number> = { urgent: 0, high: 0, medium: 0, low: 0 };
    for (const row of rows) breakdown[row.priority] = Number(row.count);
    return breakdown;
  });
}
