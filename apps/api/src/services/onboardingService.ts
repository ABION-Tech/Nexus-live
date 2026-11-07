// PRD §7.2 04 PEOPLE → Onboarding. Backs routes/onboarding.ts.
// 0013_leave_decision_note_and_onboarding.sql. Two-part model, kept as
// two query groups in one file (not two services) because they're
// always used together — a checklist page always needs both the
// template and the completion state, the same reasoning
// approvalService.ts's PendingAiTask/Task pair are one file.
import { withOrgContext } from '../db.js';
import type { OnboardingChecklistItem, OnboardingStep } from '@nexus/shared';

interface OnboardingStepRow {
  id: string;
  org_id: string;
  title: string;
  description: string | null;
  position: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface OnboardingProgressRow {
  step_id: string;
  user_id: string;
  completed_at: Date | null;
  completed_by_user_id: string | null;
}

function toStep(row: OnboardingStepRow): OnboardingStep {
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    description: row.description ?? undefined,
    position: row.position,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class OnboardingError extends Error {
  constructor(public code: 'not_found', message: string) {
    super(message);
    this.name = 'OnboardingError';
  }
}

// --- Template (onboarding_steps) — adjustable by leaders/authorized users ---

export async function listSteps(orgId: string, includeInactive = false): Promise<OnboardingStep[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<OnboardingStepRow>(
      includeInactive
        ? `select * from onboarding_steps where org_id = $1 order by position asc, created_at asc`
        : `select * from onboarding_steps where org_id = $1 and is_active order by position asc, created_at asc`,
      [orgId]
    );
    return rows.map(toStep);
  });
}

export interface StepInput {
  title: string;
  description?: string;
  position?: number;
  isActive?: boolean;
}

export async function createStep(orgId: string, input: StepInput): Promise<OnboardingStep> {
  return withOrgContext(orgId, async (client) => {
    // New steps default to the end of the list unless a position was
    // given explicitly — matches task_checklists' own `position` column
    // convention (0009), just computed here instead of client-supplied.
    let position = input.position;
    if (position === undefined) {
      const { rows } = await client.query<{ next: number }>(
        `select coalesce(max(position) + 1, 0) as next from onboarding_steps where org_id = $1`,
        [orgId]
      );
      position = rows[0]!.next;
    }
    const { rows } = await client.query<OnboardingStepRow>(
      `insert into onboarding_steps (org_id, title, description, position, is_active)
       values ($1, $2, $3, $4, coalesce($5, true))
       returning *`,
      [orgId, input.title, input.description ?? null, position, input.isActive ?? null]
    );
    return toStep(rows[0]!);
  });
}

export async function updateStep(orgId: string, id: string, input: Partial<StepInput>): Promise<OnboardingStep> {
  return withOrgContext(orgId, async (client) => {
    const existing = await client.query(`select 1 from onboarding_steps where org_id = $1 and id = $2`, [orgId, id]);
    if (existing.rows.length === 0) throw new OnboardingError('not_found', 'Onboarding step not found.');

    const { rows } = await client.query<OnboardingStepRow>(
      `update onboarding_steps
          set title = coalesce($3, title),
              description = coalesce($4, description),
              position = coalesce($5, position),
              is_active = coalesce($6, is_active),
              updated_at = now()
        where org_id = $1 and id = $2
        returning *`,
      [orgId, id, input.title ?? null, input.description ?? null, input.position ?? null, input.isActive ?? null]
    );
    return toStep(rows[0]!);
  });
}

/** Soft-delete only — see the migration's comment on `is_active`:
 * archiving must not erase onboarding_progress history for anyone who
 * already completed this step. */
export async function archiveStep(orgId: string, id: string): Promise<OnboardingStep> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<OnboardingStepRow>(
      `update onboarding_steps set is_active = false, updated_at = now()
        where org_id = $1 and id = $2
        returning *`,
      [orgId, id]
    );
    if (rows.length === 0) throw new OnboardingError('not_found', 'Onboarding step not found.');
    return toStep(rows[0]!);
  });
}

// --- Per-user checklist (onboarding_steps LEFT JOIN onboarding_progress) ---

export async function getChecklistForUser(orgId: string, userId: string): Promise<OnboardingChecklistItem[]> {
  return withOrgContext(orgId, async (client) => {
    const steps = await client.query<OnboardingStepRow>(
      `select * from onboarding_steps where org_id = $1 and is_active order by position asc, created_at asc`,
      [orgId]
    );
    const progress = await client.query<OnboardingProgressRow>(
      `select step_id, user_id, completed_at, completed_by_user_id
         from onboarding_progress where org_id = $1 and user_id = $2`,
      [orgId, userId]
    );
    const byStepId = new Map(progress.rows.map((p) => [p.step_id, p] as const));

    return steps.rows.map((row) => {
      const step = toStep(row);
      const p = byStepId.get(row.id);
      return {
        step,
        userId,
        completed: Boolean(p?.completed_at),
        completedAt: p?.completed_at?.toISOString(),
        completedByUserId: p?.completed_by_user_id ?? undefined,
      };
    });
  });
}

/** Upserts one checklist item's completion state. `actingUserId` is
 * whoever is making the change (self, or a leader/authorized user
 * checking it off on the new hire's behalf) — always recorded, even when
 * un-completing a step, so there's a real audit trail either way. */
export async function setStepCompletion(
  orgId: string,
  stepId: string,
  userId: string,
  completed: boolean,
  actingUserId: string
): Promise<OnboardingChecklistItem> {
  return withOrgContext(orgId, async (client) => {
    const stepResult = await client.query<OnboardingStepRow>(
      `select * from onboarding_steps where org_id = $1 and id = $2`,
      [orgId, stepId]
    );
    if (stepResult.rows.length === 0) throw new OnboardingError('not_found', 'Onboarding step not found.');
    const step = toStep(stepResult.rows[0]!);

    const { rows } = await client.query<OnboardingProgressRow>(
      `insert into onboarding_progress (org_id, user_id, step_id, completed_at, completed_by_user_id)
       values ($1, $2, $3, $4, $5)
       on conflict (org_id, user_id, step_id) do update
         set completed_at = excluded.completed_at,
             completed_by_user_id = excluded.completed_by_user_id,
             updated_at = now()
       returning step_id, user_id, completed_at, completed_by_user_id`,
      [orgId, userId, stepId, completed ? new Date() : null, actingUserId]
    );
    const p = rows[0]!;
    return {
      step,
      userId,
      completed: Boolean(p.completed_at),
      completedAt: p.completed_at?.toISOString(),
      completedByUserId: p.completed_by_user_id ?? undefined,
    };
  });
}
