// PRD §8.9 Marketing content calendar (0009_remaining_entities.sql's
// marketing_content, ← "6. Marketing" sheet). The calendar entry itself
// (what/where/when) lives here; the actual work is three real `tasks`
// rows — Script → Production (Shoot/Cast/Edit) → SMM (Caption & Upload),
// chained via tasks' own depends_on_task_id and linked back here via
// 0014_marketing_content_tasks.sql's marketing_content_id. Reuses the
// existing Task infrastructure (per-stage assignee, deadline, status,
// RBAC) instead of a second, parallel assignment model — same reasoning
// GoalWithProgress gives for goals' relationship to tasks.
import type { PoolClient } from 'pg';
import { withOrgContext } from '../db.js';
import { diffColumns, logActivity, logActivityCreated } from './activityLogService.js';
import { insertTaskRow, toTask, type CreateTaskInput, type TaskRow } from './taskService.js';
import {
  MARKETING_STAGE_LABELS,
  type CreateMarketingContentInput,
  type MarketingContentInput,
  type MarketingContentItem,
  type MarketingContentListQuery,
  type MarketingContentWithStages,
  type MarketingStage,
  type Task,
} from '@nexus/shared';

interface MarketingContentRow {
  id: string;
  org_id: string;
  content_type: string | null;
  platform: string | null;
  caption: string | null;
  due_date: Date | null;
  status: string;
  post_link: string | null;
  owner_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

function toMarketingContentItem(row: MarketingContentRow): MarketingContentItem {
  return {
    id: row.id,
    orgId: row.org_id,
    contentType: row.content_type ?? undefined,
    platform: row.platform ?? undefined,
    caption: row.caption ?? undefined,
    // See eodService.ts's toEodLog for why not row.due_date.toISOString()
    // alone — that would shift the date under non-UTC offsets. slice(0,
    // 10) on a `date` column's driver value avoids that.
    dueDate: row.due_date ? row.due_date.toISOString().slice(0, 10) : undefined,
    status: row.status as MarketingContentItem['status'],
    postLink: row.post_link ?? undefined,
    ownerUserId: row.owner_user_id ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString(),
  };
}

const STAGE_ORDER: MarketingStage[] = ['script', 'production', 'smm'];

async function insertContentRow(
  client: PoolClient,
  orgId: string,
  input: MarketingContentInput
): Promise<MarketingContentItem> {
  const { rows } = await client.query<MarketingContentRow>(
    `insert into marketing_content (org_id, content_type, platform, caption, due_date, status, post_link, owner_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning *`,
    [
      orgId,
      input.contentType ?? null,
      input.platform ?? null,
      input.caption ?? null,
      input.dueDate ?? null,
      input.status ?? 'planned',
      input.postLink ?? null,
      input.ownerUserId ?? null,
    ]
  );
  return toMarketingContentItem(rows[0]!);
}

export async function listMarketingContent(
  orgId: string,
  query: MarketingContentListQuery
): Promise<MarketingContentItem[]> {
  return withOrgContext(orgId, async (client) => {
    const params: unknown[] = [orgId];
    const clauses = ['org_id = $1'];
    if (!query.includeArchived) clauses.push('archived_at is null');
    if (query.status) {
      params.push(query.status);
      clauses.push(`status = $${params.length}`);
    }
    if (query.platform) {
      params.push(query.platform);
      clauses.push(`platform = $${params.length}`);
    }
    const { rows } = await client.query<MarketingContentRow>(
      `select * from marketing_content where ${clauses.join(' and ')}
       order by due_date nulls last, created_at desc`,
      params
    );
    return rows.map(toMarketingContentItem);
  });
}

export async function getMarketingContentById(orgId: string, id: string): Promise<MarketingContentItem | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<MarketingContentRow>(
      `select * from marketing_content where org_id = $1 and id = $2`,
      [orgId, id]
    );
    return rows[0] ? toMarketingContentItem(rows[0]) : null;
  });
}

/**
 * GET /marketing/:id shape — the calendar entry plus its three stage
 * tasks, keyed by stage rather than left for the UI to sort out from
 * titles. A stage is missing from `stages` only if that individual task
 * was later archived on its own (Tasks module) — normal creation always
 * produces all three.
 */
export async function getMarketingContentWithStages(
  orgId: string,
  id: string
): Promise<MarketingContentWithStages | null> {
  return withOrgContext(orgId, async (client) => {
    const contentResult = await client.query<MarketingContentRow>(
      `select * from marketing_content where org_id = $1 and id = $2`,
      [orgId, id]
    );
    if (contentResult.rows.length === 0) return null;
    const content = toMarketingContentItem(contentResult.rows[0]!);

    const { rows: taskRows } = await client.query(
      `select * from tasks where org_id = $1 and marketing_content_id = $2 and archived_at is null
       order by created_at asc`,
      [orgId, id]
    );
    const tasks: Task[] = taskRows.map(toTask);

    // Stage identity is carried by title (each created with a fixed
    // MARKETING_STAGE_LABELS value, never renamed by anything else in
    // this codebase) rather than a dedicated column — same trade-off
    // task_checklists' plain item_text makes; adding a `stage` enum
    // column to the general-purpose tasks table for one caller's benefit
    // isn't worth it when the label set is small and fixed.
    const labelToStage = new Map(STAGE_ORDER.map((s) => [MARKETING_STAGE_LABELS[s], s]));
    const stages: Partial<Record<MarketingStage, Task>> = {};
    for (const task of tasks) {
      const stage = labelToStage.get(task.title);
      if (stage) stages[stage] = task;
    }

    const doneStageCount = Object.values(stages).filter((t) => t?.status === 'done').length;

    return {
      ...content,
      stages,
      stageCount: Object.keys(stages).length,
      doneStageCount,
    };
  });
}

/**
 * Creates the calendar entry and its three chained stage tasks
 * (Script → Production → SMM, each depending on the previous) in one
 * transaction — same atomicity goal as `withOrgContext`'s own docstring,
 * so a crash mid-creation never leaves a content item with only one or
 * two of its three stages.
 */
export async function createMarketingContent(
  orgId: string,
  input: CreateMarketingContentInput,
  actorUserId: string | null = null
): Promise<MarketingContentWithStages> {
  return withOrgContext(orgId, async (client) => {
    const content = await insertContentRow(client, orgId, input);
    await logActivityCreated(client, { orgId, actorUserId, resourceType: 'marketing_content', resourceId: content.id });

    const stageInputs: Record<MarketingStage, CreateTaskInput> = {
      script: {
        title: MARKETING_STAGE_LABELS.script,
        assignedToUserId: input.script?.assignedToUserId,
        deadline: input.script?.deadline,
        department: 'marketing',
        marketingContentId: content.id,
      },
      production: {
        title: MARKETING_STAGE_LABELS.production,
        assignedToUserId: input.production?.assignedToUserId,
        deadline: input.production?.deadline,
        department: 'marketing',
        marketingContentId: content.id,
      },
      smm: {
        title: MARKETING_STAGE_LABELS.smm,
        assignedToUserId: input.smm?.assignedToUserId,
        // SMM (post/upload) is the last stage — if no stage-specific
        // deadline was given, it inherits the content's own due date,
        // since "due" on the calendar means "must be posted by".
        deadline: input.smm?.deadline ?? input.dueDate,
        department: 'marketing',
        marketingContentId: content.id,
      },
    };

    // insertTaskRow is the raw insert helper — unlike taskService.createTask,
    // it doesn't log on its own (it's also used inside an already-open
    // transaction here, not a standalone one), so each stage task's
    // creation is logged explicitly, same resourceType ('tasks') a
    // directly-created task would get via createTask.
    const scriptTask = await insertTaskRow(client, orgId, stageInputs.script);
    await logActivityCreated(client, { orgId, actorUserId, resourceType: 'tasks', resourceId: scriptTask.id });

    const productionTask = await insertTaskRow(client, orgId, {
      ...stageInputs.production,
      dependsOnTaskId: scriptTask.id,
    });
    await logActivityCreated(client, { orgId, actorUserId, resourceType: 'tasks', resourceId: productionTask.id });

    const smmTask = await insertTaskRow(client, orgId, {
      ...stageInputs.smm,
      dependsOnTaskId: productionTask.id,
    });
    await logActivityCreated(client, { orgId, actorUserId, resourceType: 'tasks', resourceId: smmTask.id });

    return {
      ...content,
      stages: { script: scriptTask, production: productionTask, smm: smmTask },
      stageCount: 3,
      doneStageCount: 0,
    };
  });
}

const MARKETING_CONTENT_COLUMNS = ['content_type', 'platform', 'caption', 'due_date', 'status', 'post_link', 'owner_user_id'];

export async function updateMarketingContent(
  orgId: string,
  id: string,
  input: Partial<MarketingContentInput>,
  actorUserId: string | null = null
): Promise<MarketingContentItem | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows: beforeRows } = await client.query<MarketingContentRow>(
      `select * from marketing_content where org_id = $1 and id = $2 and archived_at is null`,
      [orgId, id]
    );
    const before = beforeRows[0];
    if (!before) return null;

    const { rows } = await client.query<MarketingContentRow>(
      `update marketing_content set
         content_type  = coalesce($3, content_type),
         platform      = coalesce($4, platform),
         caption       = coalesce($5, caption),
         due_date      = coalesce($6, due_date),
         status        = coalesce($7, status),
         post_link     = coalesce($8, post_link),
         owner_user_id = coalesce($9, owner_user_id),
         updated_at    = now()
       where org_id = $1 and id = $2 and archived_at is null
       returning *`,
      [
        orgId,
        id,
        input.contentType,
        input.platform,
        input.caption,
        input.dueDate,
        input.status,
        input.postLink,
        input.ownerUserId,
      ]
    );
    const after = rows[0];
    if (!after) return null;

    const changes = diffColumns(before, after, MARKETING_CONTENT_COLUMNS);
    if (changes.length > 0) {
      await logActivity(client, { orgId, actorUserId, resourceType: 'marketing_content', resourceId: id, changes });
    }
    return toMarketingContentItem(after);
  });
}

/**
 * Reassign, reschedule, or change status on a single stage's task
 * without touching the others — the common edit ("swap the editor",
 * "push the shoot back a day", "mark script done") shouldn't require
 * resubmitting all three stages.
 */
const STAGE_TASK_COLUMNS: Record<'assignedToUserId' | 'deadline' | 'status', string> = {
  assignedToUserId: 'assigned_to_user_id',
  deadline: 'deadline',
  status: 'status',
};

export async function updateMarketingStage(
  orgId: string,
  contentId: string,
  stage: MarketingStage,
  input: { assignedToUserId?: string; deadline?: string; status?: Task['status'] },
  actorUserId: string | null = null
): Promise<Task | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows: beforeRows } = await client.query<TaskRow>(
      `select * from tasks where org_id = $1 and marketing_content_id = $2 and title = $3 and archived_at is null`,
      [orgId, contentId, MARKETING_STAGE_LABELS[stage]]
    );
    const before = beforeRows[0];
    if (!before) return null;

    const { rows } = await client.query<TaskRow>(
      `update tasks set
         assigned_to_user_id = coalesce($4, assigned_to_user_id),
         deadline            = coalesce($5, deadline),
         status              = coalesce($6, status),
         updated_at          = now()
       where org_id = $1 and marketing_content_id = $2 and title = $3 and archived_at is null
       returning *`,
      [orgId, contentId, MARKETING_STAGE_LABELS[stage], input.assignedToUserId, input.deadline, input.status]
    );
    const after = rows[0];
    if (!after) return null;

    // Same "only the columns this call touched" filtering taskService's
    // own updateTask uses — resourceType is 'tasks' here too, since this
    // is a real tasks row, just reached through the marketing_content_id
    // + title lookup instead of an id.
    const touchedColumns = (Object.keys(input) as (keyof typeof STAGE_TASK_COLUMNS)[])
      .filter((key) => input[key] !== undefined)
      .map((key) => STAGE_TASK_COLUMNS[key]);
    const changes = diffColumns(before, after, touchedColumns);
    if (changes.length > 0) {
      await logActivity(client, { orgId, actorUserId, resourceType: 'tasks', resourceId: after.id, changes });
    }
    return toTask(after);
  });
}

// Archives the calendar entry only — the three stage tasks are left
// alone (still visible/actionable in the Tasks module) so archiving a
// content item that already has completed work doesn't erase whoever
// did that work's record of it. Matches knowledge_entries/goals'
// "DELETE archives" convention for the parent record itself.
export async function archiveMarketingContent(
  orgId: string,
  id: string,
  actorUserId: string | null = null
): Promise<MarketingContentItem | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows: beforeRows } = await client.query<MarketingContentRow>(
      `select * from marketing_content where org_id = $1 and id = $2 and archived_at is null`,
      [orgId, id]
    );
    const before = beforeRows[0];
    if (!before) return null;

    const { rows } = await client.query<MarketingContentRow>(
      `update marketing_content set archived_at = now(), updated_at = now()
       where org_id = $1 and id = $2 and archived_at is null
       returning *`,
      [orgId, id]
    );
    const after = rows[0];
    if (!after) return null;

    const changes = diffColumns(before, after, ['archived_at']);
    if (changes.length > 0) {
      await logActivity(client, { orgId, actorUserId, resourceType: 'marketing_content', resourceId: id, changes });
    }
    return toMarketingContentItem(after);
  });
}
