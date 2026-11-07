// Goal lifecycle data access (PRD §8.5 / §9).
//
// Scope note: PRD §8.5's lifecycle is "Create goal → AI decomposes into
// 4–10 tasks → Review Queue → approve/reject → Master Tasks → progress
// tracked." This file still just takes a `ProposedTaskInput[]` — it never
// calls AIService itself, and never needs to. The AI call now happens one
// layer up, in routes/goals.ts (see resolveProposedTasks there), which
// calls AIService.decomposeGoal() when the request didn't supply
// proposedTasks and hands this file the resulting array exactly like it
// would a caller-supplied one. AIService (services/aiService.ts, §10.2)
// itself still only has a stub provider behind it (integrations/
// aiProvider.ts) — real NIM/Gemini wiring is a provider swap there, not a
// change to this file, the route, or the shared type.
import { withOrgContext } from '../db.js';
import { diffColumns, logActivity, logActivityCreated } from './activityLogService.js';
import type { Goal, GoalStatus, GoalWithProgress, PendingAiTask, ProposedTaskInput, Task } from '@nexus/shared';
import { type PoolClient } from 'pg';

interface GoalRow {
  id: string;
  org_id: string;
  title: string;
  status: GoalStatus;
  created_by_user_id: string;
  created_at: Date;
}

interface PendingAiTaskRow {
  id: string;
  org_id: string;
  goal_id: string;
  title: string;
  description: string | null;
  depends_on_pending_task_id: string | null;
  reasoning: string | null;
  status: 'pending' | 'approved' | 'rejected';
  rejection_reason: string | null;
  reviewed_by: string | null; // 0034_abion_demo_seed_gaps.sql
  reviewed_at: Date | null;
  created_at: Date;
}

interface TaskRow {
  id: string;
  org_id: string;
  title: string;
  description: string | null;
  status: 'not_started' | 'in_progress' | 'blocked' | 'done';
  priority: 'urgent' | 'high' | 'medium' | 'low'; // 0033_task_priority.sql
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
}

function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
  };
}

function toPendingAiTask(row: PendingAiTaskRow): PendingAiTask {
  return {
    id: row.id,
    orgId: row.org_id,
    goalId: row.goal_id,
    title: row.title,
    description: row.description ?? undefined,
    dependsOnPendingTaskId: row.depends_on_pending_task_id ?? undefined,
    reasoning: row.reasoning ?? undefined,
    status: row.status,
    rejectionReason: row.rejection_reason ?? undefined,
    reviewedBy: row.reviewed_by ?? undefined,
    reviewedAt: row.reviewed_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    priority: row.priority, // 0033_task_priority.sql
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
  };
}

export class DecompositionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecompositionInputError';
  }
}

/** Inserts `proposedTasks` as `pending_ai_tasks` rows for a goal, inside
 * an already-open transaction (shared by createGoal and regenerateGoal,
 * both of which need this alongside another write in the same
 * transaction). `dependsOnIndex` must reference an earlier array entry
 * — not a UUID, since none exist until after insert, and not a forward
 * reference, since that can't express a real dependency order. */
async function insertProposedTasks(
  client: PoolClient,
  orgId: string,
  goalId: string,
  proposedTasks: ProposedTaskInput[]
): Promise<PendingAiTask[]> {
  const insertedIds: string[] = [];
  const results: PendingAiTask[] = [];

  for (let i = 0; i < proposedTasks.length; i++) {
    const proposal = proposedTasks[i]!;
    let dependsOnPendingTaskId: string | null = null;

    if (proposal.dependsOnIndex !== undefined) {
      if (proposal.dependsOnIndex < 0 || proposal.dependsOnIndex >= i) {
        throw new DecompositionInputError(
          `Task ${i} ("${proposal.title}") has dependsOnIndex ${proposal.dependsOnIndex}, which must refer to an earlier task in the same list.`
        );
      }
      dependsOnPendingTaskId = insertedIds[proposal.dependsOnIndex]!;
    }

    const { rows } = await client.query<PendingAiTaskRow>(
      `insert into pending_ai_tasks (org_id, goal_id, title, description, depends_on_pending_task_id, reasoning)
       values ($1, $2, $3, $4, $5, $6)
       returning *`,
      [orgId, goalId, proposal.title, proposal.description ?? null, dependsOnPendingTaskId, proposal.reasoning ?? null]
    );
    const row = rows[0]!;
    insertedIds.push(row.id);
    results.push(toPendingAiTask(row));
  }

  return results;
}

export interface CreateGoalInput {
  title: string;
  createdByUserId: string;
  proposedTasks?: ProposedTaskInput[];
}

export async function createGoal(
  orgId: string,
  input: CreateGoalInput
): Promise<{ goal: Goal; pendingTasks: PendingAiTask[] }> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<GoalRow>(
      `insert into goals (org_id, title, created_by_user_id) values ($1, $2, $3) returning *`,
      [orgId, input.title, input.createdByUserId]
    );
    const goal = toGoal(rows[0]!);
    // Creator doubles as actor — same reasoning leaveService.createLeaveRequest
    // gives for falling back to the requester when no separate actor is
    // passed: the common case is one person doing both.
    await logActivityCreated(client, { orgId, actorUserId: input.createdByUserId, resourceType: 'goals', resourceId: goal.id });

    const pendingTasks = input.proposedTasks?.length
      ? await insertProposedTasks(client, orgId, goal.id, input.proposedTasks)
      : [];

    return { goal, pendingTasks };
  });
}

export async function listGoals(orgId: string, status?: GoalStatus): Promise<Goal[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = status
      ? await client.query<GoalRow>(`select * from goals where org_id = $1 and status = $2 order by created_at desc`, [
          orgId,
          status,
        ])
      : await client.query<GoalRow>(`select * from goals where org_id = $1 order by created_at desc`, [orgId]);
    return rows.map(toGoal);
  });
}

export async function getGoalById(orgId: string, goalId: string): Promise<Goal | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<GoalRow>(`select * from goals where org_id = $1 and id = $2`, [orgId, goalId]);
    return rows[0] ? toGoal(rows[0]) : null;
  });
}

/** PRD §6.4.1: `GET /goals/:id → goal + constituent tasks + completion %`.
 * Completion is computed from non-archived constituent tasks — an
 * archived task was never really "done or not done" toward the goal, it
 * was removed from consideration. `taskCount === 0` yields 0%, not 100%
 * — a goal with no approved tasks yet isn't complete, it hasn't started. */
export async function getGoalWithProgress(orgId: string, goalId: string): Promise<GoalWithProgress | null> {
  return withOrgContext(orgId, async (client) => {
    const goalResult = await client.query<GoalRow>(`select * from goals where org_id = $1 and id = $2`, [orgId, goalId]);
    if (goalResult.rows.length === 0) return null;
    const goal = toGoal(goalResult.rows[0]!);

    const [tasksResult, pendingResult] = await Promise.all([
      client.query<TaskRow>(
        `select * from tasks where org_id = $1 and goal_id = $2 and archived_at is null order by created_at asc`,
        [orgId, goalId]
      ),
      client.query<PendingAiTaskRow>(`select * from pending_ai_tasks where org_id = $1 and goal_id = $2 order by created_at asc`, [
        orgId,
        goalId,
      ]),
    ]);

    const tasks = tasksResult.rows.map(toTask);
    const doneTaskCount = tasks.filter((t) => t.status === 'done').length;
    const taskCount = tasks.length;

    return {
      ...goal,
      tasks,
      pendingTasks: pendingResult.rows.map(toPendingAiTask),
      taskCount,
      doneTaskCount,
      completionPercent: taskCount === 0 ? 0 : Math.round((doneTaskCount / taskCount) * 100),
    };
  });
}

export async function archiveGoal(orgId: string, goalId: string, actorUserId: string | null = null): Promise<Goal | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows: beforeRows } = await client.query<GoalRow>(`select * from goals where org_id = $1 and id = $2`, [orgId, goalId]);
    const before = beforeRows[0];
    if (!before) return null;

    const { rows } = await client.query<GoalRow>(
      `update goals set status = 'archived' where org_id = $1 and id = $2 and status = 'active' returning *`,
      [orgId, goalId]
    );
    const after = rows[0];
    if (!after) return null;

    const changes = diffColumns(before, after, ['status']);
    if (changes.length > 0) {
      await logActivity(client, { orgId, actorUserId, resourceType: 'goals', resourceId: goalId, changes });
    }
    return toGoal(after);
  });
}

/** Inverse of `archiveGoal`. Not in the original PRD §6.4.1 route list —
 * that section only specifies archive (`DELETE /:id`), not a way back —
 * but leaving archived goals with no return path was a real UX dead
 * end, so this adds one. Same guard shape as `archiveGoal`: the `where
 * ... and status = 'archived'` clause makes restoring an already-active
 * goal a no-op 404 rather than a silent double-update, exactly the way
 * `archiveGoal`'s `status = 'active'` clause guards the other direction. */
export async function restoreGoal(orgId: string, goalId: string, actorUserId: string | null = null): Promise<Goal | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows: beforeRows } = await client.query<GoalRow>(`select * from goals where org_id = $1 and id = $2`, [orgId, goalId]);
    const before = beforeRows[0];
    if (!before) return null;

    const { rows } = await client.query<GoalRow>(
      `update goals set status = 'active' where org_id = $1 and id = $2 and status = 'archived' returning *`,
      [orgId, goalId]
    );
    const after = rows[0];
    if (!after) return null;

    const changes = diffColumns(before, after, ['status']);
    if (changes.length > 0) {
      await logActivity(client, { orgId, actorUserId, resourceType: 'goals', resourceId: goalId, changes });
    }
    return toGoal(after);
  });
}

export class GoalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalStateError';
  }
}

/** PRD §6.4.1: `POST /goals/:id/regenerate → re-trigger decomposition`.
 * Still-`pending` proposals from the prior round are superseded, not
 * left dangling alongside a second batch — marked `rejected` with a
 * fixed reason so the Review Queue doesn't show two competing
 * generations of the same goal at once. Already-`approved`/`rejected`
 * rows are untouched: approved ones already became real tasks, and
 * re-running decomposition doesn't undo work that already happened. */
export async function regenerateGoal(
  orgId: string,
  goalId: string,
  proposedTasks: ProposedTaskInput[]
): Promise<{ goal: Goal; pendingTasks: PendingAiTask[] }> {
  return withOrgContext(orgId, async (client) => {
    const goalResult = await client.query<GoalRow>(`select * from goals where org_id = $1 and id = $2`, [orgId, goalId]);
    if (goalResult.rows.length === 0) throw new GoalStateError('not_found');
    const goal = toGoal(goalResult.rows[0]!);
    if (goal.status !== 'active') throw new GoalStateError('goal_archived');

    await client.query(
      `update pending_ai_tasks
          set status = 'rejected', rejection_reason = 'Superseded by regenerated decomposition.'
        where org_id = $1 and goal_id = $2 and status = 'pending'`,
      [orgId, goalId]
    );

    const pendingTasks = await insertProposedTasks(client, orgId, goalId, proposedTasks);
    return { goal, pendingTasks };
  });
}
