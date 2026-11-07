// Phase H (PRD §17.1 / §12) — the actual job bodies behind
// AUTOMATION_CONTROL_KEYS, triggered by routes/automationMaintenance.ts
// (shared-secret endpoint, same shape as calendarMaintenance.ts's
// /sweep — see 0024_automation_scheduling.sql's own comment for why
// that pattern, not an in-process node-cron timer).
//
// Six of the nine §12 jobs are implemented here, against real existing
// schema/data, no fabricated output:
//   - daily_task_snapshot        → writeDailyTaskSnapshot
//   - daily_dependency_sweep     → runDependencySweep
//   - daily_overdue_check        → runOverdueCheck
//   - daily_cob_reminders        → runCobReminders
//   - daily_eod_nudge            → runEodNudge
//   - daily_follow_up_escalation → runFollowUpEscalation
//   - daily_morning_digest       → runMorningDigest
//
// Two are NOT implemented — see IMPLEMENTED_JOBS below and
// routes/automationMaintenance.ts's own handling of the gap:
//   - daily_recurring_tasks — PRD §12 says "from recurring templates on
//     Master Tasks," but no recurrence-template schema exists anywhere
//     in this database (checked: no `recurrence`/`recurring` column on
//     `tasks` or any other table). There's nothing to generate from.
//   - hourly_follow_up — PRD §12 says "only tasks with Follow_Up_Hours
//     set," but no such column exists either.
// Building either against fabricated/guessed schema would be exactly
// the "features must not be built if they have no true backing data
// yet" mistake this codebase has explicitly avoided elsewhere (e.g.
// Session 31's cron-health deferral). These stay unbuilt until a real
// schema decision is made for them.
//
// Delivery: every job here notifies via notificationService.notifyInApp
// only. PRD §12 describes several of these as *emails* (COB reminders,
// follow-up escalation emails, EOD nudge "to Founder/COO", the morning
// digest) — but EmailService (PRD §10.3) doesn't exist yet in this
// codebase (no Resend/Gmail-failover integration has been built), and
// NotificationService's own push path is still a stub with no
// push_subscriptions wiring (see notificationService.ts's own TODOs).
// In-app is the one delivery channel that's actually real today. When
// EmailService exists, these jobs are the natural place to add a second
// notify call per job, not a rewrite.
import { withOrgContext, pool } from '../db.js';
import { notifyInApp } from './notifications/notificationService.js';
import { updateTask } from './taskService.js';
import { getMissingEod } from './eodService.js';
import { listOrgPeople } from './peopleService.js';
import {
  sendCobReminderEmail,
  sendEodNudgeEmail,
  sendFollowUpEscalationEmail,
  sendMorningDigestEmail,
} from './emailService.js';
import type { AutomationControlKey } from '@nexus/shared';

// This session (post-46) wires EmailService (PRD §10.3) into the four
// jobs PRD §12 actually describes as emails: daily_cob_reminders,
// daily_eod_nudge, daily_follow_up_escalation, daily_morning_digest.
// runOverdueCheck / runDependencySweep / runDailyTaskSnapshot stay
// in-app-only — the PRD doesn't call those three out as email jobs, and
// nothing above invented an email requirement for them.
//
// None of the send* calls below are `await`ed into the job's own
// success/failure path — see emailService.ts's own header note on the
// fire-and-.catch() contract. A failed email must never turn a
// successful in-app notification into a job error; each call site logs
// and swallows independently.
//
// MissingEodUser ({userId, name}) and the raw task-owner IDs these jobs
// already query don't carry email addresses, so each job below does its
// own small `select id, name, email from users where id = any($1)`
// lookup, scoped inside the same withOrgContext client the job is
// already running under. Person (from listOrgPeople) already has
// email, so runEodNudge's leader lookup needs no extra query.

/** Cross-org dispatch list for one job key — see the migration's own
 * comment on why this needs a SECURITY DEFINER function rather than a
 * normal RLS-scoped query (there is no single org_id to SET LOCAL for a
 * sweep that spans every org). */
async function listEnabledOrgIds(key: AutomationControlKey): Promise<string[]> {
  const { rows } = await pool.query<{ org_id: string }>(`select org_id from list_orgs_with_automation_enabled($1)`, [key]);
  return rows.map((r) => r.org_id);
}

export interface JobRunResult {
  orgId: string;
  status: 'success' | 'error';
  detail?: Record<string, unknown>;
  error?: string;
}

/** Runs `fn` for every org with `key` enabled, catching each org's error
 * independently — one org's failure (a bad row, a transient DB blip)
 * must never abort the sweep for every other org, same reasoning
 * calendarSyncService.ts's reconcileAllSubscriptions already applies. */
async function dispatchToEnabledOrgs(
  key: AutomationControlKey,
  fn: (orgId: string) => Promise<Record<string, unknown>>
): Promise<JobRunResult[]> {
  const orgIds = await listEnabledOrgIds(key);
  const results: JobRunResult[] = [];
  for (const orgId of orgIds) {
    try {
      const detail = await fn(orgId);
      results.push({ orgId, status: 'success', detail });
    } catch (err) {
      results.push({ orgId, status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

// ---- daily_task_snapshot (23:00) ---------------------------------------
// Writes today's row(s) to task_trends: one org-wide row (user_id null)
// plus one row per user who has at least one non-archived task assigned.
// `at_risk` — deadline within the next 48h, not done — is a reasonable
// v1 definition, not a literal port of computePredictionSignals_ (PRD
// Appendix C names that as a reference implementation to preserve, but
// its actual thresholds aren't present anywhere in this repo or in what
// was provided to build this session, so inventing exact parity would
// be guessing, not porting).
export async function runDailyTaskSnapshot(): Promise<JobRunResult[]> {
  return dispatchToEnabledOrgs('daily_task_snapshot', async (orgId) => {
    return withOrgContext(orgId, async (client) => {
      const today = new Date().toISOString().slice(0, 10);

      // Org-wide row (user_id null).
      const { rows: orgRows } = await client.query<{
        open_tasks: string;
        done_today: string;
        overdue: string;
        at_risk: string;
      }>(
        `select
           count(*) filter (where status != 'done')::text as open_tasks,
           count(*) filter (where status = 'done' and updated_at::date = current_date)::text as done_today,
           count(*) filter (where status != 'done' and deadline is not null and deadline < now())::text as overdue,
           count(*) filter (where status != 'done' and deadline is not null and deadline >= now() and deadline < now() + interval '48 hours')::text as at_risk
         from tasks where org_id = $1 and archived_at is null`,
        [orgId]
      );
      const org = orgRows[0]!;
      await client.query(
        `insert into task_trends (org_id, user_id, date, open_tasks, done_today, overdue, at_risk)
         values ($1, null, $2, $3, $4, $5, $6)`,
        [orgId, today, Number(org.open_tasks), Number(org.done_today), Number(org.overdue), Number(org.at_risk)]
      );

      // Per-user rows.
      const { rows: userRows } = await client.query<{
        assigned_to_user_id: string;
        open_tasks: string;
        done_today: string;
        overdue: string;
        at_risk: string;
      }>(
        `select
           assigned_to_user_id,
           count(*) filter (where status != 'done')::text as open_tasks,
           count(*) filter (where status = 'done' and updated_at::date = current_date)::text as done_today,
           count(*) filter (where status != 'done' and deadline is not null and deadline < now())::text as overdue,
           count(*) filter (where status != 'done' and deadline is not null and deadline >= now() and deadline < now() + interval '48 hours')::text as at_risk
         from tasks
         where org_id = $1 and archived_at is null and assigned_to_user_id is not null
         group by assigned_to_user_id`,
        [orgId]
      );
      for (const row of userRows) {
        await client.query(
          `insert into task_trends (org_id, user_id, date, open_tasks, done_today, overdue, at_risk)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [orgId, row.assigned_to_user_id, today, Number(row.open_tasks), Number(row.done_today), Number(row.overdue), Number(row.at_risk)]
        );
      }

      return { rowsWritten: 1 + userRows.length };
    });
  });
}

// ---- daily_dependency_sweep (09:00) ------------------------------------
// "Auto-blocks/unblocks tasks; restores interpolated status, not a
// blind reset" (PRD §12). Uses tasks.pre_block_status (0024) to record
// what a task's status was immediately before this sweep auto-blocked
// it, so unblocking restores that value instead of guessing
// 'not_started'. Only ever touches tasks this sweep itself blocked
// (pre_block_status is not null) — a task a human manually set to
// 'blocked' has pre_block_status = null and this sweep leaves it alone
// in both directions, since it was never the sweep's to unblock.
export async function runDependencySweep(): Promise<JobRunResult[]> {
  return dispatchToEnabledOrgs('daily_dependency_sweep', async (orgId) => {
    return withOrgContext(orgId, async (client) => {
      // Candidates to BLOCK: has an incomplete dependency, isn't already
      // blocked, hasn't already been sweep-blocked (pre_block_status null
      // is required going in, since we're about to set it).
      const { rows: toBlock } = await client.query<{ id: string; status: string }>(
        `select t.id, t.status from tasks t
           join tasks dep on dep.id = t.depends_on_task_id
          where t.org_id = $1 and t.archived_at is null
            and t.status != 'blocked' and t.pre_block_status is null
            and dep.status != 'done' and dep.archived_at is null`,
        [orgId]
      );
      let blocked = 0;
      for (const task of toBlock) {
        const result = await updateTask(orgId, task.id, { status: 'blocked', preBlockStatus: task.status }, null);
        if (result) blocked++;
      }

      // Candidates to UNBLOCK: sweep-blocked (pre_block_status set) and
      // the dependency is now done.
      const { rows: toUnblock } = await client.query<{ id: string; pre_block_status: string }>(
        `select t.id, t.pre_block_status from tasks t
           join tasks dep on dep.id = t.depends_on_task_id
          where t.org_id = $1 and t.archived_at is null
            and t.status = 'blocked' and t.pre_block_status is not null
            and dep.status = 'done'`,
        [orgId]
      );
      let unblocked = 0;
      for (const task of toUnblock) {
        const result = await updateTask(
          orgId,
          task.id,
          { status: task.pre_block_status as 'not_started' | 'in_progress' | 'blocked' | 'done', preBlockStatus: null },
          null
        );
        if (result) unblocked++;
      }

      return { tasksBlocked: blocked, tasksUnblocked: unblocked };
    });
  });
}

// ---- daily_overdue_check (08:00) ---------------------------------------
// The n8n-ping half of this job (PRD §12: "n8n ping currently
// placeholder — wire when URL exists") is deliberately not attempted
// here — N8N_AGENT_WEBHOOK_URL being unset is documented elsewhere
// (automationService.ts's AutomationService §10.6 notes) as "safe to
// ship before n8n exists," not an error to surface. This job only does
// the overdue-notification half.
export async function runOverdueCheck(): Promise<JobRunResult[]> {
  return dispatchToEnabledOrgs('daily_overdue_check', async (orgId) => {
    return withOrgContext(orgId, async (client) => {
      const { rows } = await client.query<{ id: string; title: string; assigned_to_user_id: string }>(
        `select id, title, assigned_to_user_id from tasks
          where org_id = $1 and archived_at is null and status != 'done'
            and deadline is not null and deadline < now()
            and assigned_to_user_id is not null`,
        [orgId]
      );
      let notified = 0;
      for (const task of rows) {
        // De-dupe: skip if this exact task already got an overdue
        // notification today — a job that runs more than once in a day
        // (retry, manual re-trigger) must not spam the same person with
        // duplicate rows for a task that's been overdue for a week.
        const { rows: existing } = await client.query(
          `select 1 from notifications
            where org_id = $1 and user_id = $2 and task_id = $3 and type = 'overdue'
              and created_at::date = current_date`,
          [orgId, task.assigned_to_user_id, task.id]
        );
        if (existing.length > 0) continue;

        await notifyInApp(client, {
          orgId,
          userId: task.assigned_to_user_id,
          taskId: task.id,
          type: 'overdue',
          title: 'Task overdue',
          body: `"${task.title}" is past its deadline.`,
        });
        notified++;
      }
      return { overdueTasks: rows.length, notificationsSent: notified };
    });
  });
}

// ---- daily_cob_reminders (16:00) ---------------------------------------
// EOD-day-aware (per PRD §12's own note) — reuses eodService's existing
// getMissingEod, which already does the eod_days-aware "expected today"
// join (PRD §8.4's getMembersExpectedToday reference function, already
// ported).
export async function runCobReminders(): Promise<JobRunResult[]> {
  return dispatchToEnabledOrgs('daily_cob_reminders', async (orgId) => {
    return withOrgContext(orgId, async (client) => {
      const today = new Date().toISOString().slice(0, 10);
      const missing = await getMissingEod(orgId, today);

      // MissingEodUser has no email — batch-look-up contact info for
      // everyone in this sweep once, rather than a query per person.
      const { rows: contacts } = await client.query<{ id: string; email: string }>(
        `select id, email from users where id = any($1)`,
        [missing.map((m) => m.userId)]
      );
      const emailById = new Map(contacts.map((c) => [c.id, c.email]));

      for (const person of missing) {
        await notifyInApp(client, {
          orgId,
          userId: person.userId,
          type: 'eod_reminder',
          title: "Don't forget your EOD report",
          body: "You're expected to file an EOD report today — it hasn't been submitted yet.",
        });
        const email = emailById.get(person.userId);
        if (email) {
          sendCobReminderEmail(orgId, { email, name: person.name }).catch((err) => {
            console.error('[automationJobs] daily_cob_reminders email send failed', {
              orgId,
              userId: person.userId,
              err,
            });
          });
        }
      }
      return { remindersSent: missing.length };
    });
  });
}

// ---- daily_eod_nudge (18:00) --------------------------------------------
// "Missing-EOD summary to Founder/COO" (PRD §12) — one summary
// notification per leader, not per missing person, matching the MVP's
// own framing as a digest rather than a per-person alert.
export async function runEodNudge(): Promise<JobRunResult[]> {
  return dispatchToEnabledOrgs('daily_eod_nudge', async (orgId) => {
    return withOrgContext(orgId, async (client) => {
      const today = new Date().toISOString().slice(0, 10);
      const [missing, people] = await Promise.all([getMissingEod(orgId, today), listOrgPeople(orgId)]);
      if (missing.length === 0) return { leadersNotified: 0, missingCount: 0 };

      const leaders = people.filter((p) => p.role === 'leader');
      const names = missing.map((m) => m.name).join(', ');
      const missingNames = missing.map((m) => m.name);
      for (const leader of leaders) {
        await notifyInApp(client, {
          orgId,
          userId: leader.id,
          type: 'eod_missing_summary',
          title: `${missing.length} team member${missing.length === 1 ? '' : 's'} missing today's EOD`,
          body: names,
        });
        // Person (from listOrgPeople) already has email — no extra lookup needed.
        sendEodNudgeEmail(orgId, { email: leader.email, name: leader.name }, missingNames).catch((err) => {
          console.error('[automationJobs] daily_eod_nudge email send failed', { orgId, leaderId: leader.id, err });
        });
      }
      return { leadersNotified: leaders.length, missingCount: missing.length };
    });
  });
}

// ---- daily_follow_up_escalation (18:00) ---------------------------------
// PRD §12: "Tiered staleness + deadline merged — dailyDeadlineCheck was
// folded in deliberately." The MVP's exact ESCALATION_TIERS thresholds
// aren't present anywhere in this repo or in what was provided to build
// this session, so this is a reasonable v1 tiering, not a literal port:
//   - overdue by 1+ day → escalate to the task's supervisor (if any),
//     not just the assignee (the "this is now everyone's problem"
//     escalation the name implies)
//   - due within the next 48h, not yet overdue → a heads-up to the
//     assignee only
// Genuinely-overdue-today tasks are already covered by
// runOverdueCheck's assignee notification above; this job is additive
// (the supervisor escalation + the advance heads-up), not a duplicate.
export async function runFollowUpEscalation(): Promise<JobRunResult[]> {
  return dispatchToEnabledOrgs('daily_follow_up_escalation', async (orgId) => {
    return withOrgContext(orgId, async (client) => {
      // 0033_task_priority.sql — urgent/high tasks escalate after 12h
      // overdue instead of the default 24h tier; PRD §8.2/§13.7 named
      // ESCALATION_TIERS as one of the things priority was supposed to
      // drive, so this is that wiring, not just a stored field.
      const { rows: overdue } = await client.query<{
        id: string;
        title: string;
        supervisor_user_id: string;
        assigned_to_user_id: string | null;
      }>(
        `select id, title, supervisor_user_id, assigned_to_user_id from tasks
          where org_id = $1 and archived_at is null and status != 'done'
            and deadline is not null
            and deadline < now() - (case when priority in ('urgent', 'high') then interval '12 hours' else interval '1 day' end)
            and supervisor_user_id is not null`,
        [orgId]
      );

      // Both the supervisor (recipient) and the original owner (named in
      // the email copy, not notified) only come back as raw IDs from the
      // query above — one batched lookup covers both roles across the
      // whole sweep.
      const contactIds = Array.from(
        new Set(
          overdue.flatMap((t) => [t.supervisor_user_id, t.assigned_to_user_id].filter((id): id is string => !!id))
        )
      );
      const { rows: contactRows } = await client.query<{ id: string; name: string; email: string }>(
        `select id, name, email from users where id = any($1)`,
        [contactIds]
      );
      const contactById = new Map(contactRows.map((c) => [c.id, c]));

      let escalated = 0;
      for (const task of overdue) {
        const { rows: existing } = await client.query(
          `select 1 from notifications
            where org_id = $1 and user_id = $2 and task_id = $3 and type = 'escalation'
              and created_at::date = current_date`,
          [orgId, task.supervisor_user_id, task.id]
        );
        if (existing.length > 0) continue;
        await notifyInApp(client, {
          orgId,
          userId: task.supervisor_user_id,
          taskId: task.id,
          type: 'escalation',
          title: 'Overdue task needs attention',
          body: `"${task.title}" has been overdue for more than a day.`,
        });
        const supervisor = contactById.get(task.supervisor_user_id);
        if (supervisor) {
          const ownerName = (task.assigned_to_user_id && contactById.get(task.assigned_to_user_id)?.name) || 'Unassigned';
          sendFollowUpEscalationEmail(orgId, { email: supervisor.email, name: supervisor.name }, task.title, ownerName).catch(
            (err) => {
              console.error('[automationJobs] daily_follow_up_escalation email send failed', {
                orgId,
                taskId: task.id,
                supervisorUserId: task.supervisor_user_id,
                err,
              });
            }
          );
        }
        escalated++;
      }

      const { rows: upcoming } = await client.query<{ id: string; title: string; assigned_to_user_id: string }>(
        `select id, title, assigned_to_user_id from tasks
          where org_id = $1 and archived_at is null and status != 'done'
            and deadline is not null and deadline >= now() and deadline < now() + interval '48 hours'
            and assigned_to_user_id is not null`,
        [orgId]
      );
      let headsUp = 0;
      for (const task of upcoming) {
        const { rows: existing } = await client.query(
          `select 1 from notifications
            where org_id = $1 and user_id = $2 and task_id = $3 and type = 'deadline_soon'
              and created_at::date = current_date`,
          [orgId, task.assigned_to_user_id, task.id]
        );
        if (existing.length > 0) continue;
        await notifyInApp(client, {
          orgId,
          userId: task.assigned_to_user_id,
          taskId: task.id,
          type: 'deadline_soon',
          title: 'Deadline coming up',
          body: `"${task.title}" is due within 48 hours.`,
        });
        headsUp++;
      }

      return { escalationsSent: escalated, upcomingHeadsUpSent: headsUp };
    });
  });
}

// ---- daily_morning_digest (08:00) ---------------------------------------
// "Mon=full, Tue-Fri=light" (PRD §12). Light: open + overdue task
// counts. Full (Monday): adds active goal count — the closest available
// proxy for the MVP's "full" digest without inventing content this
// session has no source for. One digest per user who has at least one
// open task; a user with zero open tasks has nothing to digest.
export async function runMorningDigest(): Promise<JobRunResult[]> {
  return dispatchToEnabledOrgs('daily_morning_digest', async (orgId) => {
    return withOrgContext(orgId, async (client) => {
      const isMonday = new Date().getUTCDay() === 1;

      const { rows } = await client.query<{ assigned_to_user_id: string; open_tasks: string; overdue: string }>(
        `select assigned_to_user_id,
                count(*) filter (where status != 'done')::text as open_tasks,
                count(*) filter (where status != 'done' and deadline is not null and deadline < now())::text as overdue
           from tasks
          where org_id = $1 and archived_at is null and assigned_to_user_id is not null
          group by assigned_to_user_id
         having count(*) filter (where status != 'done') > 0`,
        [orgId]
      );

      let goalCount: number | null = null;
      if (isMonday) {
        const { rows: goalRows } = await client.query<{ count: string }>(
          `select count(*)::text as count from goals where org_id = $1 and status = 'active'`,
          [orgId]
        );
        goalCount = Number(goalRows[0]?.count ?? 0);
      }

      const { rows: contactRows } = await client.query<{ id: string; name: string; email: string }>(
        `select id, name, email from users where id = any($1)`,
        [rows.map((r) => r.assigned_to_user_id)]
      );
      const contactById = new Map(contactRows.map((c) => [c.id, c]));

      for (const row of rows) {
        const openTasks = Number(row.open_tasks);
        const overdue = Number(row.overdue);
        const bodyParts = [`${openTasks} open task${openTasks === 1 ? '' : 's'}`, `${overdue} overdue`];
        if (isMonday && goalCount !== null) bodyParts.push(`${goalCount} active org goal${goalCount === 1 ? '' : 's'}`);

        await notifyInApp(client, {
          orgId,
          userId: row.assigned_to_user_id,
          type: 'digest',
          title: isMonday ? 'Your week ahead' : 'Your day ahead',
          body: bodyParts.join(' · '),
        });

        const contact = contactById.get(row.assigned_to_user_id);
        if (contact) {
          sendMorningDigestEmail(
            orgId,
            { email: contact.email, name: contact.name },
            { openTasks, overdue, activeGoals: isMonday ? goalCount ?? undefined : undefined },
            isMonday ? 'full' : 'light'
          ).catch((err) => {
            console.error('[automationJobs] daily_morning_digest email send failed', {
              orgId,
              userId: row.assigned_to_user_id,
              err,
            });
          });
        }
      }

      return { digestsSent: rows.length, variant: isMonday ? 'full' : 'light' };
    });
  });
}

export const IMPLEMENTED_JOBS: Record<string, () => Promise<JobRunResult[]>> = {
  daily_task_snapshot: runDailyTaskSnapshot,
  daily_dependency_sweep: runDependencySweep,
  daily_overdue_check: runOverdueCheck,
  daily_cob_reminders: runCobReminders,
  daily_eod_nudge: runEodNudge,
  daily_follow_up_escalation: runFollowUpEscalation,
  daily_morning_digest: runMorningDigest,
};

// Real, named, not silently absent — routes/automationMaintenance.ts
// checks a job key against this set to return a distinct 501 rather
// than a misleading 200 "ran successfully" for zero real effect.
export const UNIMPLEMENTED_JOBS = new Set(['daily_recurring_tasks', 'hourly_follow_up']);

// ---- billing_grace_check (Session 47) -----------------------------------
// Deliberately NOT one of the nine §12 jobs above — it has no
// AUTOMATION_CONTROL_KEYS toggle and is never org-optional the way
// daily_morning_digest etc. are (a leader can't turn off billing
// enforcement for their own org). So it doesn't go through
// dispatchToEnabledOrgs/listEnabledOrgIds (both keyed on
// automation_controls, which this has no row in) — it has its own tiny
// dispatch loop against 0025_billing.sql's own
// list_billing_past_due_for_grace_check() bootstrap function, same
// "cross-org read via SECURITY DEFINER, then per-row withOrgContext"
// shape as every other sweep in this file, just against a different
// source list. Triggered by its own route (routes/billingMaintenance.ts),
// not routes/automationMaintenance.ts's :jobKey dispatch — that route's
// isKnownAutomationKey check would reject 'billing_grace_check' outright
// since it isn't in AUTOMATION_CONTROL_KEYS, which is correct: this job
// is platform housekeeping, not a per-org automation feature.
//
// What it does: 0025's own header on `grace_period_ends_at` says the
// sweep "only acts on rows where this is in the past AND billing_status
// = 'past_due'" — this function is that sweep. On finding one, it
// transitions billing_status to 'pending_review' (0025's locked §1
// decision: grace period, THEN mandatory manual Super Admin review — not
// an automatic suspend). grace_period_ends_at is left as-is (not
// cleared) so Super Admin's review view can still see how long the org
// has been over its grace window; only a successful payment
// (upsert_org_billing_for_webhook's own p_clear_grace_period path,
// billingWebhookService.ts) or a Super Admin resolution clears it.
export async function runBillingGraceCheck(): Promise<JobRunResult[]> {
  const { rows } = await pool.query<{ org_id: string; grace_period_ends_at: string }>(
    `select org_id, grace_period_ends_at from list_billing_past_due_for_grace_check()`
  );

  const results: JobRunResult[] = [];
  for (const row of rows) {
    try {
      await withOrgContext(row.org_id, async (client) => {
        await client.query(
          `update org_billing set billing_status = 'pending_review', updated_at = now()
           where org_id = $1 and billing_status = 'past_due'`,
          [row.org_id]
        );
      });
      results.push({
        orgId: row.org_id,
        status: 'success',
        detail: { transitionedTo: 'pending_review', gracePeriodEndedAt: row.grace_period_ends_at },
      });
    } catch (err) {
      results.push({ orgId: row.org_id, status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
