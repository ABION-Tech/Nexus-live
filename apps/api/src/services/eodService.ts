// EOD data access (PRD §8.9, §9.1 eod_logs, §8.4 EOD-day-awareness).
// Same layering as taskService.ts — no permission logic here, that's
// routes/eod.ts's job.
import { withOrgContext } from '../db.js';
import type { AttendanceEntry, EodComplianceSummary, EodLog, MissingEodUser, SubmitEodInput } from '@nexus/shared';

interface EodLogRow {
  id: string;
  org_id: string;
  user_id: string;
  filed_by_user_id: string;
  date: Date;
  summary: string;
  moved_forward: string | null;
  key_achievement: string | null;
  blockers: string | null;
  tomorrow_plan: string | null;
  created_at: Date;
  updated_at: Date;
}

function toEodLog(row: EodLogRow): EodLog {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    filedByUserId: row.filed_by_user_id,
    // Session 58: node-postgres reads a `date` as local midnight, so the
    // local calendar parts are the stored date on any server time zone
    // (toISOString() moved it back a day anywhere east of UTC).
    date: `${row.date.getFullYear()}-${String(row.date.getMonth() + 1).padStart(2, '0')}-${String(row.date.getDate()).padStart(2, '0')}`,
    summary: row.summary,
    movedForward: row.moved_forward ?? undefined,
    keyAchievement: row.key_achievement ?? undefined,
    blockers: row.blockers ?? undefined,
    tomorrowPlan: row.tomorrow_plan ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Insert-or-amend — PRD: one EOD per person per day, re-filing amends it. */
export async function submitEod(orgId: string, filedByUserId: string, input: SubmitEodInput): Promise<EodLog> {
  const userId = input.userId ?? filedByUserId;
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<EodLogRow>(
      `insert into eod_logs (org_id, user_id, filed_by_user_id, date, summary, moved_forward, key_achievement, blockers, tomorrow_plan)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (org_id, user_id, date)
       do update set summary = excluded.summary, moved_forward = excluded.moved_forward, key_achievement = excluded.key_achievement,
                     blockers = excluded.blockers, tomorrow_plan = excluded.tomorrow_plan,
                     filed_by_user_id = excluded.filed_by_user_id, updated_at = now()
       returning *`,
      [orgId, userId, filedByUserId, input.date, input.summary, input.movedForward || null, input.keyAchievement || null, input.blockers || null, input.tomorrowPlan || null]
    );
    return toEodLog(rows[0]!);
  });
}

/** Session 58 — Activity Log: EODs between two dates, newest first,
 * optionally one person's. */
export async function listEodLogsInRange(orgId: string, from: string, to: string, userId?: string): Promise<EodLog[]> {
  return withOrgContext(orgId, async (client) => {
    const p: unknown[] = [orgId, from, to];
    const who = userId ? (p.push(userId), 'and user_id = $4') : '';
    const { rows } = await client.query<EodLogRow>(
      `select * from eod_logs where org_id = $1 and date between $2 and $3 ${who} order by date desc, created_at desc limit 1000`,
      p
    );
    return rows.map(toEodLog);
  });
}

export async function listEodLogsForDate(orgId: string, date: string): Promise<EodLog[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<EodLogRow>(
      `select * from eod_logs where org_id = $1 and date = $2 order by user_id`,
      [orgId, date]
    );
    return rows.map(toEodLog);
  });
}

export async function getEodLogForUser(orgId: string, userId: string, date: string): Promise<EodLog | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<EodLogRow>(
      `select * from eod_logs where org_id = $1 and user_id = $2 and date = $3`,
      [orgId, userId, date]
    );
    return rows[0] ? toEodLog(rows[0]) : null;
  });
}

/** By id, not (user, date) — the lookup shape fileResourceAuth.ts needs:
 * `files.resource_id` for a `resource_type = 'eod_logs'` row is this id,
 * not a (userId, date) pair, so the per-record trust check (PRD §13.3
 * check 4) has to resolve ownership from the id alone. No route calls
 * this directly today; it exists for that one call site. */
export async function getEodLogById(orgId: string, id: string): Promise<EodLog | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<EodLogRow>(`select * from eod_logs where org_id = $1 and id = $2`, [orgId, id]);
    return rows[0] ? toEodLog(rows[0]) : null;
  });
}

interface ExpectedUserRow {
  id: string;
  name: string;
}

/**
 * PRD §8.4's `getMembersExpectedToday` reference function, ported: a user
 * is expected on `date` if `date`'s day-of-week is in their `eod_days`
 * array. `extract(dow from ...)` returns 0 (Sunday) .. 6 (Saturday),
 * matching the column's own convention (0006_eod_logs.sql) — no
 * translation needed between the two.
 */
async function getMembersExpectedOn(orgId: string, date: string): Promise<ExpectedUserRow[]> {
  return withOrgContext(orgId, async (client) => {
    // 0006_org_hierarchy_memberships.sql dropped users.org_id — "does
    // this user belong to this org" is now an org_memberships lookup,
    // not a column on users itself.
    const { rows } = await client.query<ExpectedUserRow>(
      `select u.id, u.name from users u
         join org_memberships m on m.user_id = u.id and m.org_id = $1
        where extract(dow from $2::date)::smallint = any(u.eod_days)
        order by u.name`,
      [orgId, date]
    );
    return rows;
  });
}

export async function getEodCompliance(orgId: string, date: string): Promise<EodComplianceSummary> {
  const [expected, filed] = await Promise.all([
    getMembersExpectedOn(orgId, date),
    listEodLogsForDate(orgId, date),
  ]);
  const filedUserIds = new Set(filed.map((f) => f.userId));
  const expectedCount = expected.length;
  const filedCount = expected.filter((u) => filedUserIds.has(u.id)).length;
  return {
    date,
    expectedCount,
    filedCount,
    compliancePercent: expectedCount === 0 ? 0 : Math.round((filedCount / expectedCount) * 100),
  };
}

export async function getMissingEod(orgId: string, date: string): Promise<MissingEodUser[]> {
  const [expected, filed] = await Promise.all([
    getMembersExpectedOn(orgId, date),
    listEodLogsForDate(orgId, date),
  ]);
  const filedUserIds = new Set(filed.map((f) => f.userId));
  return expected.filter((u) => !filedUserIds.has(u.id)).map((u) => ({ userId: u.id, name: u.name }));
}

/** People > Attendance (PRD §8.4). Everyone expected today, each flagged
 * with whether they've filed — the per-user superset getEodCompliance's
 * count and getMissingEod's gap-only list are both derived from. */
export async function getAttendanceForDate(orgId: string, date: string): Promise<AttendanceEntry[]> {
  const [expected, filed] = await Promise.all([
    getMembersExpectedOn(orgId, date),
    listEodLogsForDate(orgId, date),
  ]);
  const filedUserIds = new Set(filed.map((f) => f.userId));
  return expected.map((u) => ({ userId: u.id, name: u.name, filed: filedUserIds.has(u.id) }));
}
