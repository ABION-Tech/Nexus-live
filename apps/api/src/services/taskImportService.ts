// Session 59 — bring tasks in from another system you use (Synergia, the
// original Google Sheet) into a company you belong to.
//
// Safe to run again: each task carries an `externalRef` and a company
// holds at most one task per ref (0042). A task whose title already exists
// in that company is matched instead of duplicated. Runs inside
// withOrgContext, so RLS keeps it to that one company; the caller must be
// a member of it (checked here with my_workspaces).
import type { TaskPriority, TaskStatus } from '@nexus/shared';
import { pool, withOrgContext } from '../db.js';

export interface ImportTaskInput {
  externalRef: string;
  title: string;
  notes?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  startDate?: string; // YYYY-MM-DD
  deadline?: string; // ISO date or timestamp
  business?: string;
  department?: string;
  /** Short id people know it by (T-031). */
  ref?: string;
  /** Assigned to the key owner (default true). */
  assignToMe?: boolean;
  checklist?: { text: string; done?: boolean }[];
}

export interface ImportResult {
  externalRef: string;
  id: string;
  outcome: 'created' | 'existing' | 'matched_title';
}

export class TaskImportError extends Error {
  constructor(public code: 'not_member' | 'invalid', message: string) {
    super(message);
  }
}

const STATUSES: TaskStatus[] = ['not_started', 'in_progress', 'blocked', 'done'];
const PRIORITIES: TaskPriority[] = ['urgent', 'high', 'medium', 'low'];
const clip = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const isoDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v : null);

/** The company (by name) among the caller's own memberships. */
export async function findMyCompany(userId: string, name: string): Promise<{ orgId: string; name: string }> {
  const { rows } = await pool.query<{ org_id: string; name: string }>(
    `select org_id, name from my_workspaces($1) where active and lower(name) = lower($2)`,
    [userId, name.trim()]
  );
  if (!rows[0]) throw new TaskImportError('not_member', `You aren't a member of a company called "${name}".`);
  return { orgId: rows[0].org_id, name: rows[0].name };
}

export async function importTasks(userId: string, orgId: string, tasks: ImportTaskInput[]): Promise<ImportResult[]> {
  return withOrgContext(orgId, async (c) => {
    const out: ImportResult[] = [];
    for (const t of tasks) {
      const ref = clip(t.externalRef, 200);
      const title = clip(t.title, 500);
      if (!ref || !title) throw new TaskImportError('invalid', 'Every task needs an externalRef and a title.');

      const existing = await c.query<{ id: string }>(`select id from tasks where org_id = $1 and external_ref = $2`, [orgId, ref]);
      if (existing.rows[0]) {
        out.push({ externalRef: ref, id: existing.rows[0].id, outcome: 'existing' });
        continue;
      }
      // Same title already in this company (created here, or brought in by
      // another import): that's the same task. Only an unclaimed one takes
      // this ref, so a second source never steals the first one's link.
      const same = await c.query<{ id: string }>(
        `select id from tasks where org_id = $1 and archived_at is null and lower(btrim(title)) = lower($2)
          order by (external_ref is null) desc, created_at limit 1`,
        [orgId, title]
      );
      if (same.rows[0]) {
        await c.query(`update tasks set external_ref = $2 where id = $1 and external_ref is null`, [same.rows[0].id, ref]);
        out.push({ externalRef: ref, id: same.rows[0].id, outcome: 'matched_title' });
        continue;
      }

      const status = STATUSES.includes(t.status as TaskStatus) ? t.status : 'not_started';
      const priority = PRIORITIES.includes(t.priority as TaskPriority) ? t.priority : 'medium';
      const { rows } = await c.query<{ id: string }>(
        `insert into tasks (org_id, title, description, status, priority, start_date, deadline, assigned_to_user_id, business, department, legacy_sheet_id, external_ref)
         values ($1, $2, $3, $4, $5, $6::date, $7::timestamptz, $8, $9, $10, $11, $12)
         returning id`,
        [
          orgId,
          title,
          clip(t.notes, 8000),
          status,
          priority,
          isoDate(t.startDate),
          // A bare date means end of that working day in Abuja, not midnight UTC.
          /^\d{4}-\d{2}-\d{2}$/.test(t.deadline ?? '') ? `${t.deadline}T17:00:00+01:00` : isoDate(t.deadline),
          t.assignToMe === false ? null : userId,
          clip(t.business, 120),
          clip(t.department, 120),
          clip(t.ref, 40),
          ref,
        ]
      );
      const id = rows[0]!.id;
      let pos = 0;
      for (const item of (t.checklist ?? []).slice(0, 50)) {
        const text = clip(item.text, 500);
        if (!text) continue;
        await c.query(`insert into task_checklists (org_id, task_id, item_text, is_done, position) values ($1, $2, $3, $4, $5)`, [
          orgId,
          id,
          text,
          Boolean(item.done),
          pos++,
        ]);
      }
      out.push({ externalRef: ref, id, outcome: 'created' });
    }
    return out;
  });
}
