// Session 62 — "My day": one person's day, across every company they're
// in. It's what the morning email sends and what the dashboard's My day
// panel shows, so both always agree. The old digest only gave counts
// ("12 open tasks · 3 overdue"), which tells nobody what to do next.
// This says it in words: what's late and by how long, what's due today
// and by when, what's on the calendar, how much free time is left and
// whether the work fits in it, what's coming this week, and the next
// checklist step on each task.
//
// Reading: each company is read inside its own withOrgContext, so RLS
// applies exactly as when you switch to that company. It can't show
// anything you couldn't already open.
//
// Split in two so the arithmetic is testable without a database:
//   loadDayInputs(userId, …)   the rows
//   assembleMyDay(inputs, now) the day: grouping, times, the headline
import { pool, withOrgContext } from '../db.js';
import { getMissingEod } from './eodService.js';

export const DAY_TZ = 'Africa/Lagos';
/** Working day used for "free time left". 09:00–18:00 Lagos. */
export const WORKDAY = { start: 9 * 60, end: 18 * 60 };
const UPCOMING_DAYS = 7;
const MAX_PER_GROUP = 12;

export interface DayTask {
  id: string;
  title: string;
  companyId: string;
  company: string;
  priority: string;
  status: string;
  role: 'owner' | 'support' | 'supervisor';
  /** ISO timestamp, or null. */
  deadline: string | null;
  /** True when the deadline carries a real time of day, not just a date. */
  deadlineHasTime: boolean;
  startDate: string | null;
  estimateMinutes: number | null;
  /** First unticked checklist item. */
  nextStep: string | null;
  checklistDone: number;
  checklistTotal: number;
  /** Days past the deadline (overdue only). */
  lateDays?: number;
}

export interface DayEvent {
  /** ISO timestamp (or YYYY-MM-DD for all-day). */
  start: string;
  end: string | null;
  allDay: boolean;
  title: string;
  company: string | null;
  kind: 'meeting' | 'calendar';
  location: string | null;
}

export interface TeamWatch {
  companyId: string;
  company: string;
  blocked: { id: string; title: string; owner: string | null }[];
  lateByOthers: { id: string; title: string; owner: string | null; lateDays: number }[];
  /** People who didn't file yesterday's (last working day's) EOD. */
  missingEod: string[];
  missingEodDate: string;
}

export interface MyDay {
  date: string;
  dateLabel: string;
  generatedAt: string;
  name: string;
  firstName: string;
  companies: { id: string; name: string }[];
  headline: string;
  events: DayEvent[];
  overdue: DayTask[];
  dueToday: DayTask[];
  /** Started (start date today) or in progress, with no deadline this week. */
  onTheGo: DayTask[];
  upcoming: { date: string; label: string; tasks: DayTask[] }[];
  time: {
    workdayStart: string;
    workdayEnd: string;
    /** Working minutes left today from now (all 540 before 09:00). */
    minutesLeft: number;
    /** Of those, minutes already taken by meetings and calendar events. */
    busyMinutes: number;
    freeMinutes: number;
    /** Time needed for what's due today and overdue (estimated tasks only). */
    neededMinutes: number;
    /** Tasks due today or overdue with no time estimate. */
    unestimated: number;
  };
  team: TeamWatch[];
  /** Overflow counts when a group was cut to MAX_PER_GROUP. */
  more: { overdue: number; dueToday: number; onTheGo: number };
}

export interface DayInputs {
  name: string;
  companies: { id: string; name: string; role: string }[];
  tasks: DayTask[];
  events: DayEvent[];
  team: TeamWatch[];
}

// ---- dates in Lagos --------------------------------------------------

export function lagosDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: DAY_TZ }).format(d);
}

/** Minutes since midnight, Lagos time. */
export function lagosMinutes(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: DAY_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86_400_000);
}

export function dayLabel(date: string, today: string): string {
  const diff = daysBetween(today, date);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function fmtMinutes(m: number): string {
  if (m <= 0) return '0m';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
}

export function fmtClock(iso: string): string {
  return new Date(iso)
    .toLocaleTimeString('en-GB', { timeZone: DAY_TZ, hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(':00', '')
    .replace(' ', ' ');
}

/** A deadline saved from a date picker lands on midnight (UTC or Lagos),
 * or 23:59 for "end of day"; anything else carries a real time of day. */
export function deadlineHasTime(iso: string): boolean {
  const d = new Date(iso);
  if (/T00:00:00(\.000)?Z$/.test(d.toISOString())) return false;
  const m = lagosMinutes(d);
  return m !== 0 && m < 23 * 60 + 59;
}

/** "by 4 pm, in 3h 10m" / "by end of day" / "due Fri 20 Nov" / "3 days late". */
export function dueText(t: DayTask, now: Date): string {
  if (!t.deadline) return '';
  if (t.lateDays && t.lateDays > 0) return `${t.lateDays} day${t.lateDays === 1 ? '' : 's'} late`;
  const today = lagosDate(now);
  const dl = new Date(t.deadline);
  const date = deadlineDate(t.deadline);
  if (date !== today) {
    const label = dayLabel(date, today);
    return label === 'Tomorrow' ? 'due tomorrow' : `due ${label}`;
  }
  if (!t.deadlineHasTime) return 'by end of day';
  const mins = Math.round((dl.getTime() - now.getTime()) / 60000);
  if (mins < 0) return `was due ${fmtClock(t.deadline)}`;
  return `by ${fmtClock(t.deadline)}, in ${fmtMinutes(mins)}`;
}

/** The Lagos date a deadline falls on. A date-only deadline is stored as
 * midnight (UTC from the form, Lagos from imports); either way its Lagos
 * date is the date that was picked. */
export function deadlineDate(iso: string): string {
  return lagosDate(new Date(iso));
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
function byUrgency(a: DayTask, b: DayTask): number {
  const p = (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2);
  if (p) return p;
  return (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999');
}

/** Minutes of [from, to] (minutes since midnight) covered by timed events today. */
export function busyMinutesBetween(events: DayEvent[], today: string, from: number, to: number): number {
  const spans: [number, number][] = [];
  for (const e of events) {
    if (e.allDay || !e.end) continue;
    const s = new Date(e.start);
    const en = new Date(e.end);
    const sMin = lagosDate(s) < today ? 0 : lagosMinutes(s);
    const eMin = lagosDate(en) > today ? 24 * 60 : lagosMinutes(en);
    const a = Math.max(from, sMin);
    const b = Math.min(to, eMin);
    if (b > a) spans.push([a, b]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const s of spans) {
    if (!cur || s[0] > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [s[0], s[1]];
    } else cur[1] = Math.max(cur[1], s[1]);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---- the day ---------------------------------------------------------

export function assembleMyDay(inputs: DayInputs, now: Date = new Date()): MyDay {
  const today = lagosDate(now);
  const weekEnd = addDays(today, UPCOMING_DAYS);

  const overdue: DayTask[] = [];
  const dueToday: DayTask[] = [];
  const onTheGo: DayTask[] = [];
  const upcomingMap = new Map<string, DayTask[]>();

  for (const t of inputs.tasks) {
    if (t.status === 'done') continue;
    const d = t.deadline ? deadlineDate(t.deadline) : null;
    if (d && d < today) overdue.push({ ...t, lateDays: daysBetween(d, today) });
    else if (d === today) dueToday.push(t);
    else if (d && d <= weekEnd) {
      const list = upcomingMap.get(d) ?? [];
      list.push(t);
      upcomingMap.set(d, list);
    } else if (t.status === 'in_progress' || t.status === 'blocked' || t.startDate === today) onTheGo.push(t);
  }

  overdue.sort((a, b) => (b.lateDays ?? 0) - (a.lateDays ?? 0) || byUrgency(a, b));
  dueToday.sort((a, b) => {
    // Timed deadlines first, soonest first; then end-of-day by priority.
    if (a.deadlineHasTime !== b.deadlineHasTime) return a.deadlineHasTime ? -1 : 1;
    return a.deadlineHasTime ? a.deadline!.localeCompare(b.deadline!) : byUrgency(a, b);
  });
  onTheGo.sort(byUrgency);
  const upcoming = [...upcomingMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, tasks]) => ({ date, label: dayLabel(date, today), tasks: tasks.sort(byUrgency) }));

  const events = [...inputs.events].sort((a, b) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1));

  const nowMin = lagosMinutes(now);
  const from = Math.max(WORKDAY.start, nowMin);
  const minutesLeft = Math.max(0, WORKDAY.end - from);
  const busyMinutes = busyMinutesBetween(events, today, from, WORKDAY.end);
  const freeMinutes = Math.max(0, minutesLeft - busyMinutes);
  const mustDo = [...overdue, ...dueToday].filter((t) => t.role === 'owner');
  const neededMinutes = mustDo.reduce((s, t) => s + (t.estimateMinutes ?? 0), 0);
  const unestimated = mustDo.filter((t) => !t.estimateMinutes).length;
  const timedEventsLeft = events.filter((e) => !e.allDay && e.end && Date.parse(e.end) > now.getTime()).length;

  // The headline: one or two plain sentences that say what the day holds.
  const bits: string[] = [];
  if (dueToday.length) bits.push(`${plural(dueToday.length, 'task')} due today`);
  if (overdue.length) bits.push(dueToday.length ? `${overdue.length} overdue` : `${plural(overdue.length, 'overdue task')}`);
  if (timedEventsLeft) bits.push(plural(timedEventsLeft, 'meeting'));
  let headline: string;
  if (!bits.length) {
    const next = upcoming[0];
    headline = next
      ? `Nothing is due today. Next up: ${next.tasks[0]!.title} (${next.label === 'Tomorrow' ? 'tomorrow' : next.label}).`
      : onTheGo.length
        ? `Nothing is due today. A good day to move ${onTheGo[0]!.title} forward.`
        : 'Nothing is due today and nothing is scheduled.';
  } else {
    headline = `You have ${bits.length > 1 ? bits.slice(0, -1).join(', ') + ' and ' + bits[bits.length - 1] : bits[0]}.`;
    if (minutesLeft > 0) {
      headline += ` About ${fmtMinutes(freeMinutes)} of your working day is free`;
      if (neededMinutes > 0) {
        headline += neededMinutes > freeMinutes
          ? `, and today's work needs about ${fmtMinutes(neededMinutes)}: ${fmtMinutes(neededMinutes - freeMinutes)} more than you have.`
          : `, and today's work needs about ${fmtMinutes(neededMinutes)}.`;
      } else headline += '.';
    }
  }

  const name = inputs.name || 'there';
  return {
    date: today,
    dateLabel: new Date(today + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }),
    generatedAt: now.toISOString(),
    name,
    firstName: name.split(/\s+/)[0]!,
    companies: inputs.companies.map((c) => ({ id: c.id, name: c.name })),
    headline,
    events,
    overdue: overdue.slice(0, MAX_PER_GROUP),
    dueToday: dueToday.slice(0, MAX_PER_GROUP),
    onTheGo: onTheGo.slice(0, 6),
    upcoming: upcoming.map((u) => ({ ...u, tasks: u.tasks.slice(0, 6) })),
    time: {
      workdayStart: '09:00',
      workdayEnd: '18:00',
      minutesLeft,
      busyMinutes,
      freeMinutes,
      neededMinutes,
      unestimated,
    },
    team: inputs.team.filter((t) => t.blocked.length || t.lateByOthers.length || t.missingEod.length),
    more: {
      overdue: Math.max(0, overdue.length - MAX_PER_GROUP),
      dueToday: Math.max(0, dueToday.length - MAX_PER_GROUP),
      onTheGo: Math.max(0, onTheGo.length - 6),
    },
  };
}

// ---- loading ---------------------------------------------------------

/** The last working day before `date` (Mon → Fri). */
export function previousWorkday(date: string): string {
  let d = addDays(date, -1);
  while ([0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())) d = addDays(d, -1);
  return d;
}

export async function loadDayInputs(userId: string, opts: { orgIds?: string[]; now?: Date } = {}): Promise<DayInputs> {
  const now = opts.now ?? new Date();
  const today = lagosDate(now);
  const { rows: ws } = await pool.query<{ org_id: string; name: string; role: string; active: boolean }>(
    `select org_id, name, role, active from my_workspaces($1)`,
    [userId]
  );
  const companies = ws
    .filter((w) => w.active && (!opts.orgIds || opts.orgIds.includes(w.org_id)))
    .map((w) => ({ id: w.org_id, name: w.name, role: w.role }));

  let name = '';
  const tasks: DayTask[] = [];
  const events: DayEvent[] = [];
  const team: TeamWatch[] = [];
  const seenGoogleIds = new Set<string>();
  const dayStart = `${today}T00:00:00+01:00`;
  const dayEnd = `${addDays(today, 1)}T00:00:00+01:00`;

  for (const co of companies) {
    await withOrgContext(co.id, async (c) => {
      if (!name) {
        const u = await c.query<{ name: string }>(`select name from users where id = $1`, [userId]);
        name = u.rows[0]?.name ?? '';
      }

      const { rows } = await c.query(
        `select t.id, t.title, t.priority, t.status, t.deadline, t.start_date, t.estimate_minutes,
                case when t.assigned_to_user_id = $2 then 'owner' when t.support_user_id = $2 then 'support' else 'supervisor' end as role,
                coalesce(cl.done, 0)::int as checklist_done, coalesce(cl.total, 0)::int as checklist_total,
                (select k.item_text from task_checklists k where k.task_id = t.id and not k.is_done order by k.position, k.created_at limit 1) as next_step
           from tasks t
           left join lateral (select count(*) filter (where is_done) as done, count(*) as total from task_checklists k where k.task_id = t.id) cl on true
          where t.org_id = $1 and t.archived_at is null and t.status <> 'done'
            and (t.assigned_to_user_id = $2 or t.support_user_id = $2 or t.supervisor_user_id = $2)
          order by t.deadline nulls last
          limit 400`,
        [co.id, userId]
      );
      for (const r of rows) {
        const deadline = r.deadline ? new Date(r.deadline).toISOString() : null;
        tasks.push({
          id: r.id,
          title: r.title,
          companyId: co.id,
          company: co.name,
          priority: r.priority,
          status: r.status,
          role: r.role,
          deadline,
          deadlineHasTime: deadline ? deadlineHasTime(deadline) : false,
          startDate: r.start_date ? new Date(r.start_date).toISOString().slice(0, 10) : null,
          estimateMinutes: r.estimate_minutes ?? null,
          nextStep: r.next_step ?? null,
          checklistDone: r.checklist_done,
          checklistTotal: r.checklist_total,
        });
      }

      // The company's meetings today (meetings have no attendee list, so
      // a company meeting is everyone's).
      const m = await c.query(
        `select title, start_time, end_time, location_type, location_detail, google_calendar_event_id
           from meetings
          where org_id = $1 and archived_at is null and start_time < $3::timestamptz and coalesce(end_time, start_time) >= $2::timestamptz
          order by start_time`,
        [co.id, dayStart, dayEnd]
      );
      for (const r of m.rows) {
        if (r.google_calendar_event_id) seenGoogleIds.add(r.google_calendar_event_id);
        events.push({
          start: new Date(r.start_time).toISOString(),
          end: r.end_time ? new Date(r.end_time).toISOString() : new Date(new Date(r.start_time).getTime() + 30 * 60000).toISOString(),
          allDay: false,
          title: r.title,
          company: co.name,
          kind: 'meeting',
          location: r.location_type === 'physical' ? r.location_detail : r.location_type === 'zoom' ? 'Zoom' : 'Google Meet',
        });
      }

      // Your own connected Google calendars, mirrored into this company.
      const g = await c.query(
        `select e.google_event_id, e.title, e.all_day, e.start_at, e.end_at, e.start_date, e.end_date, e.location
           from calendar_events e
           join calendar_subscriptions s on s.id = e.subscription_id and s.is_active and s.revoked_at is null
           join calendar_connections cn on cn.id = s.connection_id and cn.user_id = $2 and cn.revoked_at is null
          where e.org_id = $1 and e.status <> 'cancelled'
            and ((not e.all_day and e.start_at < $4::timestamptz and e.end_at > $3::timestamptz)
              or (e.all_day and e.start_date <= $5::date and e.end_date > $5::date))`,
        [co.id, userId, dayStart, dayEnd, today]
      );
      for (const r of g.rows) {
        if (seenGoogleIds.has(r.google_event_id)) continue;
        seenGoogleIds.add(r.google_event_id);
        events.push({
          start: r.all_day ? new Date(r.start_date).toISOString().slice(0, 10) : new Date(r.start_at).toISOString(),
          end: r.all_day ? null : new Date(r.end_at).toISOString(),
          allDay: r.all_day,
          title: r.title || '(No title)',
          company: null,
          kind: 'calendar',
          location: r.location ?? null,
        });
      }

      // Leaders: what their team needs from them.
      if (co.role === 'leader') {
        const b = await c.query(
          `select t.id, t.title, u.name as owner,
                  (t.status = 'blocked') as is_blocked,
                  ($3::date - (t.deadline at time zone '${DAY_TZ}')::date) as late_days
             from tasks t left join users u on u.id = t.assigned_to_user_id
            where t.org_id = $1 and t.archived_at is null and t.status <> 'done'
              and coalesce(t.assigned_to_user_id, '00000000-0000-0000-0000-000000000000') <> $2
              and (t.status = 'blocked' or (t.deadline is not null and (t.deadline at time zone '${DAY_TZ}')::date < $3::date))
            order by t.deadline nulls last
            limit 60`,
          [co.id, userId, today]
        );
        const missingDate = previousWorkday(today);
        const missing = await getMissingEod(co.id, missingDate).catch(() => []);
        team.push({
          companyId: co.id,
          company: co.name,
          blocked: b.rows.filter((r) => r.is_blocked).slice(0, 5).map((r) => ({ id: r.id, title: r.title, owner: r.owner })),
          lateByOthers: b.rows
            .filter((r) => !r.is_blocked && r.late_days > 0)
            .sort((x, y) => y.late_days - x.late_days)
            .slice(0, 5)
            .map((r) => ({ id: r.id, title: r.title, owner: r.owner, lateDays: Number(r.late_days) })),
          missingEod: missing.filter((p) => p.userId !== userId).map((p) => p.name),
          missingEodDate: missingDate,
        });
      }
    });
  }

  return { name, companies, tasks, events, team };
}

export async function buildMyDay(userId: string, opts: { orgIds?: string[]; now?: Date } = {}): Promise<MyDay> {
  const now = opts.now ?? new Date();
  return assembleMyDay(await loadDayInputs(userId, { ...opts, now }), now);
}
