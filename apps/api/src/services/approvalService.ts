// Review Queue (PRD §8.5 / §6.4.1 `approvals/` domain). Operates on
// `pending_ai_tasks` rows created by goalService's decomposition-input
// handling. Kept as its own file rather than folded into goalService —
// PRD §6.4.1 treats `approvals/` as its own API domain, separate from
// `goals/`, and the "AI proposes → human approves → system executes"
// contract (PRD §8.5, §4) is general enough that other agent workflows
// will eventually feed the same Review Queue, not just goal decomposition.
import { withOrgContext } from '../db.js';
import type { PendingAiTask, Task } from '@nexus/shared';

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

export async function listPendingApprovals(orgId: string, goalId?: string): Promise<PendingAiTask[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = goalId
      ? await client.query<PendingAiTaskRow>(
          `select * from pending_ai_tasks where org_id = $1 and goal_id = $2 and status = 'pending' order by created_at asc`,
          [orgId, goalId]
        )
      : await client.query<PendingAiTaskRow>(
          `select * from pending_ai_tasks where org_id = $1 and status = 'pending' order by created_at asc`,
          [orgId]
        );
    return rows.map(toPendingAiTask);
  });
}

export class ApprovalError extends Error {
  constructor(
    public code: 'not_found' | 'already_decided' | 'dependency_not_approved' | 'dependency_rejected',
    message: string
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

/** Approves one Review Queue item, creating the real task it proposed.
 *
 * Dependency-aware: PRD §8.5 says approved tasks enter Master Tasks
 * "with dependency ordering" — a task can't get a `depends_on_task_id`
 * pointing at a task that doesn't exist yet. If this proposal depends on
 * another proposal that hasn't been approved yet, this throws rather
 * than silently creating the task with no dependency link (which would
 * silently drop the ordering the decomposition asked for) or silently
 * auto-approving the dependency first (which would approve something the
 * leader hasn't reviewed). The caller — a leader working the Review
 * Queue — approves in dependency order; if a dependency was rejected
 * instead, that's a distinct, permanent failure mode (`dependency_rejected`),
 * not a "try again later" one. */
export async function approvePendingTask(orgId: string, pendingTaskId: string, actorUserId: string): Promise<Task> {
  return withOrgContext(orgId, async (client) => {
    const pendingResult = await client.query<PendingAiTaskRow>(
      `select * from pending_ai_tasks where org_id = $1 and id = $2`,
      [orgId, pendingTaskId]
    );
    if (pendingResult.rows.length === 0) throw new ApprovalError('not_found', 'Review Queue item not found.');
    const pending = pendingResult.rows[0]!;
    if (pending.status !== 'pending') {
      throw new ApprovalError('already_decided', `This item was already ${pending.status}.`);
    }

    let dependsOnTaskId: string | null = null;
    if (pending.depends_on_pending_task_id) {
      const depResult = await client.query<PendingAiTaskRow>(`select * from pending_ai_tasks where id = $1`, [
        pending.depends_on_pending_task_id,
      ]);
      const dependency = depResult.rows[0];
      if (!dependency || dependency.status === 'pending') {
        throw new ApprovalError(
          'dependency_not_approved',
          'This task depends on another Review Queue item that has not been approved yet. Approve that one first.'
        );
      }
      if (dependency.status === 'rejected') {
        throw new ApprovalError(
          'dependency_rejected',
          'This task depends on a Review Queue item that was rejected — it cannot be approved as-is.'
        );
      }
      // dependency.status === 'approved': find the real task it became.
      const depTaskResult = await client.query<TaskRow>(`select id from tasks where source_pending_task_id = $1`, [
        dependency.id,
      ]);
      dependsOnTaskId = depTaskResult.rows[0]?.id ?? null;
    }

    const taskResult = await client.query<TaskRow>(
      `insert into tasks (org_id, title, description, goal_id, source_pending_task_id, depends_on_task_id)
       values ($1, $2, $3, $4, $5, $6)
       returning *`,
      [orgId, pending.title, pending.description, pending.goal_id, pending.id, dependsOnTaskId]
    );

    await client.query(`update pending_ai_tasks set status = 'approved', reviewed_by = $2, reviewed_at = now() where id = $1`, [
      pendingTaskId,
      actorUserId,
    ]);

    return toTask(taskResult.rows[0]!);
  });
}

export async function rejectPendingTask(
  orgId: string,
  pendingTaskId: string,
  actorUserId: string,
  reason?: string
): Promise<PendingAiTask> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<PendingAiTaskRow>(
      `update pending_ai_tasks set status = 'rejected', rejection_reason = $3, reviewed_by = $4, reviewed_at = now()
        where org_id = $1 and id = $2 and status = 'pending'
        returning *`,
      [orgId, pendingTaskId, reason ?? null, actorUserId]
    );
    if (rows.length === 0) {
      // Distinguish "doesn't exist" from "already decided" for the route
      // to report accurately, same as approvePendingTask.
      const existing = await client.query<PendingAiTaskRow>(`select status from pending_ai_tasks where org_id = $1 and id = $2`, [
        orgId,
        pendingTaskId,
      ]);
      if (existing.rows.length === 0) throw new ApprovalError('not_found', 'Review Queue item not found.');
      throw new ApprovalError('already_decided', `This item was already ${existing.rows[0]!.status}.`);
    }
    return toPendingAiTask(rows[0]!);
  });
}
