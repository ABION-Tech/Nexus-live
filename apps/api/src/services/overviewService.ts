// Session 58 — the real Dashboard and the sidebar counts, restored from
// the original HTML app ("KPI Dashboard"): alert bars for blocked and
// stale work, four headline numbers, and the latest tasks. Every number
// is a live count from this company's own rows (inside withOrgContext,
// so RLS applies). Replaces the hard-coded placeholder dashboard.
import { withOrgContext } from '../db.js';
import { getMissingEod } from './eodService.js';

export const STALE_DAYS = 2;
const TZ = 'Africa/Lagos';

export function todayIn(tz = TZ): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

export interface OverviewCounts {
  activeTasks: number;
  blocked: number;
  overdue: number;
  /** Overdue, or due within the next 3 days. */
  atRisk: number;
  /** Open and not updated for STALE_DAYS or more. */
  stale: number;
  partnerships: number;
  partnerFollowUps: number;
  /** Follow-Up Tracker badge: stale tasks + partnerships past follow-up. */
  followUps: number;
  missingEod: number;
  /** Failsafe badge: blocked + overdue + missing EOD + partners past follow-up. */
  failsafe: number;
  reviewPending: number;
  upcomingMeetings: number;
  marketingOpen: number;
}

export interface RecentTask {
  id: string;
  ref: string | null;
  title: string;
  status: string;
  priority: string;
  assignee: string | null;
  deadline: string | null;
  notes: string | null;
  checklistDone: number;
  checklistTotal: number;
}

/** `scopeUserId`: a member without org-wide task access sees counts for
 * their own work only (same rule as routes/tasks.ts). */
export async function getOverview(
  orgId: string,
  opts: { scopeUserId?: string; includeEod: boolean; recent?: number }
): Promise<{ counts: OverviewCounts; recentTasks: RecentTask[]; today: string }> {
  const today = todayIn();
  const counts = await withOrgContext(orgId, async (c) => {
    const p: unknown[] = [orgId, today, STALE_DAYS];
    const mine = opts.scopeUserId
      ? (p.push(opts.scopeUserId), `and (assigned_to_user_id = $4 or support_user_id = $4 or supervisor_user_id = $4)`)
      : '';
    const t = await c.query(
      `select
         count(*) filter (where status <> 'done')::int as active,
         count(*) filter (where status = 'blocked')::int as blocked,
         count(*) filter (where status <> 'done' and deadline is not null and (deadline at time zone '${TZ}')::date < $2::date)::int as overdue,
         count(*) filter (where status <> 'done' and deadline is not null and (deadline at time zone '${TZ}')::date <= $2::date + 3)::int as at_risk,
         count(*) filter (where status <> 'done' and updated_at < now() - make_interval(days => $3::int))::int as stale
       from tasks where org_id = $1 and archived_at is null ${mine}`,
      p
    );
    const other = await c.query(
      `select
         (select count(*)::int from partnerships where org_id = $1 and archived_at is null) as partnerships,
         (select count(*)::int from partnerships where org_id = $1 and archived_at is null
             and current_status not in ('active','declined') and follow_up_date is not null and follow_up_date < now()) as partner_follow_ups,
         (select count(*)::int from pending_ai_tasks where org_id = $1 and status = 'pending') as review_pending,
         (select count(*)::int from meetings where org_id = $1 and archived_at is null and start_time >= now()) as upcoming_meetings,
         (select count(*)::int from marketing_content where org_id = $1 and archived_at is null and status not in ('posted','cancelled')) as marketing_open`,
      [orgId]
    );
    return { ...t.rows[0], ...other.rows[0] };
  });

  const missingEod = opts.includeEod ? (await getMissingEod(orgId, today).catch(() => [])).length : 0;

  const recentTasks = await withOrgContext(orgId, async (c) => {
    const p: unknown[] = [orgId, Math.min(50, opts.recent ?? 10)];
    const mine = opts.scopeUserId
      ? (p.push(opts.scopeUserId), `and (t.assigned_to_user_id = $3 or t.support_user_id = $3 or t.supervisor_user_id = $3)`)
      : '';
    const { rows } = await c.query(
      `select t.id, t.legacy_sheet_id as ref, t.title, t.status, t.priority, u.name as assignee, t.deadline, t.description as notes,
              coalesce(cl.done, 0)::int as checklist_done, coalesce(cl.total, 0)::int as checklist_total
         from tasks t
         left join users u on u.id = t.assigned_to_user_id
         left join lateral (select count(*) filter (where is_done) as done, count(*) as total from task_checklists k where k.task_id = t.id) cl on true
        where t.org_id = $1 and t.archived_at is null ${mine}
        order by t.created_at desc
        limit $2`,
      p
    );
    return rows.map(
      (r): RecentTask => ({
        id: r.id,
        ref: r.ref,
        title: r.title,
        status: r.status,
        priority: r.priority,
        assignee: r.assignee,
        deadline: r.deadline ? new Date(r.deadline).toISOString() : null,
        notes: r.notes,
        checklistDone: r.checklist_done,
        checklistTotal: r.checklist_total,
      })
    );
  });

  return {
    today,
    recentTasks,
    counts: {
      activeTasks: counts.active,
      blocked: counts.blocked,
      overdue: counts.overdue,
      atRisk: counts.at_risk,
      stale: counts.stale,
      partnerships: counts.partnerships,
      partnerFollowUps: counts.partner_follow_ups,
      followUps: counts.stale + counts.partner_follow_ups,
      missingEod,
      failsafe: counts.blocked + counts.overdue + missingEod + counts.partner_follow_ups,
      reviewPending: counts.review_pending,
      upcomingMeetings: counts.upcoming_meetings,
      marketingOpen: counts.marketing_open,
    },
  };
}
