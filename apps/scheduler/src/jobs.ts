// The schedule itself — kept as plain data, separate from index.ts's
// runner, so "what runs when" can be read/changed without touching any
// cron-loop or fetch logic.
//
// Every time here is sourced from an existing comment already in the
// tree, not invented for this file:
//   - the seven implemented §12 jobs: packages/shared/src/index.ts's own
//     AUTOMATION_CONTROL_KEYS comment (08:00 / 08:00 / 09:00 / 16:00 /
//     18:00 / 18:00 / 23:00).
//   - daily_recurring_tasks (10:00) and hourly_follow_up (hourly,
//     8am–7pm weekdays) are listed too, `implemented: false`, straight
//     from that same comment — present so the schedule is the complete
//     nine-job picture at a glance, but skipped at runtime (see
//     index.ts) because automationJobs.ts's own UNIMPLEMENTED_JOBS
//     still has nothing behind either key (no recurrence-template or
//     Follow_Up_Hours schema exists — a schema gap, not a wiring gap).
//     Flip `implemented` to true here the same day someone adds them to
//     automationJobs.ts's IMPLEMENTED_JOBS, not before.
//   - the calendar sweep and billing grace check have no PRD-specified
//     cadence (neither §10.5 nor §10.9 names one) — the intervals below
//     are this scheduler's own reasonable default, not a spec value, and
//     both are overridable via env without touching this file (see
//     index.ts's readCronOverride).

export type MaintenanceKind = 'automation' | 'calendar' | 'calendar-renew' | 'billing';

export interface ScheduledJob {
  /** Log-friendly identifier. For automation jobs this is the real
   * AutomationControlKey (used verbatim in the URL); for the other two
   * kinds it's just a label. */
  name: string;
  kind: MaintenanceKind;
  /** Whether a real job body exists behind this yet. Mirrors
   * automationJobs.ts's IMPLEMENTED_JOBS / UNIMPLEMENTED_JOBS split —
   * kept as a literal here rather than imported because this package
   * deliberately has no dependency on @nexus/api (it only ever talks to
   * the API over HTTP, never imports its source — see README.md). If
   * that split ever drifts, the API side's own 501 response is the
   * backstop: an `implemented: true` job hitting a not-yet-real
   * endpoint still just logs a 501 and moves on, it doesn't crash the
   * scheduler. */
  implemented: boolean;
  /** Standard 5-field cron expression, evaluated in TZ (index.ts). */
  cron: string;
  /** Env var name that can override `cron` above without a code change
   * or redeploy — same "env overrides a sane built-in default" posture
   * STORAGE_MAX_UPLOAD_BYTES etc. already use elsewhere in this repo. */
  cronOverrideEnvVar: string;
  humanSchedule: string;
}

export const AUTOMATION_JOBS: ScheduledJob[] = [
  { name: 'daily_overdue_check', kind: 'automation', implemented: true, cron: '0 8 * * *', cronOverrideEnvVar: 'CRON_DAILY_OVERDUE_CHECK', humanSchedule: '08:00 daily' },
  { name: 'daily_morning_digest', kind: 'automation', implemented: true, cron: '5 8 * * *', cronOverrideEnvVar: 'CRON_DAILY_MORNING_DIGEST', humanSchedule: '08:05 daily (5 min after overdue-check, so the digest can reflect today\'s freshly-flagged overdue tasks rather than racing it)' },
  { name: 'daily_dependency_sweep', kind: 'automation', implemented: true, cron: '0 9 * * *', cronOverrideEnvVar: 'CRON_DAILY_DEPENDENCY_SWEEP', humanSchedule: '09:00 daily' },
  { name: 'daily_recurring_tasks', kind: 'automation', implemented: false, cron: '0 10 * * *', cronOverrideEnvVar: 'CRON_DAILY_RECURRING_TASKS', humanSchedule: '10:00 daily — NOT SCHEDULED (automationJobs.ts has no implementation: no recurrence-template schema exists yet)' },
  { name: 'daily_cob_reminders', kind: 'automation', implemented: true, cron: '0 16 * * *', cronOverrideEnvVar: 'CRON_DAILY_COB_REMINDERS', humanSchedule: '16:00 daily' },
  { name: 'daily_follow_up_escalation', kind: 'automation', implemented: true, cron: '0 18 * * *', cronOverrideEnvVar: 'CRON_DAILY_FOLLOW_UP_ESCALATION', humanSchedule: '18:00 daily' },
  { name: 'daily_eod_nudge', kind: 'automation', implemented: true, cron: '5 18 * * *', cronOverrideEnvVar: 'CRON_DAILY_EOD_NUDGE', humanSchedule: '18:05 daily (5 min after follow-up escalation, same same-minute-collision avoidance as the morning pair above)' },
  { name: 'hourly_follow_up', kind: 'automation', implemented: false, cron: '0 8-19 * * 1-5', cronOverrideEnvVar: 'CRON_HOURLY_FOLLOW_UP', humanSchedule: 'hourly 08:00-19:00 weekdays — NOT SCHEDULED (no Follow_Up_Hours-equivalent column exists yet)' },
  { name: 'daily_task_snapshot', kind: 'automation', implemented: true, cron: '0 23 * * *', cronOverrideEnvVar: 'CRON_DAILY_TASK_SNAPSHOT', humanSchedule: '23:00 daily (last job of the day, by design — a snapshot of the day\'s task state)' },
];

export const CALENDAR_SWEEP_JOB: ScheduledJob = {
  name: 'calendar_reconciliation_sweep',
  kind: 'calendar',
  implemented: true,
  cron: '*/30 * * * *',
  cronOverrideEnvVar: 'CRON_CALENDAR_SWEEP',
  humanSchedule: 'every 30 minutes (this scheduler\'s own default — PRD §10.5 names no cadence; a webhook-delivery reconciliation pass is inexpensive enough to run often)',
};

export const CALENDAR_CHANNEL_RENEWAL_JOB: ScheduledJob = {
  name: 'calendar_channel_renewal',
  kind: 'calendar-renew',
  implemented: true,
  // Daily at 02:00 — well outside the 30-min sweep window so the two
  // calendar maintenance passes don't overlap, and early enough that
  // any channel expiring today is renewed before business hours.
  // 0036's list_expiring_channel_subscriptions looks 48 h ahead, so
  // this once-a-day cadence has ample margin even if the scheduler
  // misses one run.
  cron: '0 2 * * *',
  cronOverrideEnvVar: 'CRON_CALENDAR_CHANNEL_RENEWAL',
  humanSchedule: '02:00 daily (renews Google push-notification channels expiring within 48 hours — 0036_calendar_channel_uniqueness.sql)',
};

export const BILLING_GRACE_CHECK_JOB: ScheduledJob = {
  name: 'billing_grace_check',
  kind: 'billing',
  implemented: true,
  cron: '0 7 * * *',
  cronOverrideEnvVar: 'CRON_BILLING_GRACE_CHECK',
  humanSchedule: '07:00 daily — ahead of the 08:00 automation jobs so a same-day past_due → pending_review transition lands before anything Founder-facing runs; grace windows are day-granularity (7 days, per billingWebhookService.ts) so once a day is enough',
};

export const ALL_JOBS: ScheduledJob[] = [...AUTOMATION_JOBS, CALENDAR_SWEEP_JOB, CALENDAR_CHANNEL_RENEWAL_JOB, BILLING_GRACE_CHECK_JOB];
