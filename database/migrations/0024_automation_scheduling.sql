-- 0024_automation_scheduling.sql
-- Phase H (PRD §17.1) — wiring the §12 scheduled jobs to a real trigger,
-- closing the gap automationService.ts's own header has flagged since
-- Session 31 ("no job is actually wired to n8n/a scheduler yet").
--
-- Trigger shape: same external-scheduler-calls-a-shared-secret-endpoint
-- pattern 0012_calendar.sql's list_active_subscriptions_for_sync already
-- established for calendarMaintenance.ts's /sweep — not a new
-- in-process node-cron dependency. Reasons this repo already settled:
-- PRD §5/§10.6 puts scheduled workflows behind n8n, never as ad-hoc
-- in-process timers; and an in-process timer has no guarantee of firing
-- on a free-tier host that can idle/restart (Railway/Render), where an
-- external caller (n8n Cloud's own scheduler, or a plain cron-job.org
-- hit) does not have that problem.

-- ---------------------------------------------------------------------
-- automation_run_log — real backing data for the cron-job-health half of
-- §8.10 that Session 31 explicitly declined to build a fake version of
-- ("don't stub fake last-run data before [a scheduler] exists"). One row
-- per (job_key, org_id) per invocation of the maintenance endpoint —
-- written under that org's own RLS context (routes/automationMaintenance.ts
-- iterates orgs and logs each inside withOrgContext), not as a single
-- cross-org row, so a leader reading their own automation log only ever
-- sees their own org's run history, same tenant boundary automation_log
-- itself already gives toggle-change history.
-- ---------------------------------------------------------------------
create table automation_run_log (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id),
  job_key        text not null, -- one of AUTOMATION_CONTROL_KEYS (packages/shared) — not FK'd to automation_controls since a log row must survive even if the control row is later deleted/reset
  started_at     timestamptz not null,
  finished_at    timestamptz not null,
  status         text not null check (status in ('success', 'error')),
  detail         jsonb, -- job-specific summary, e.g. {"tasksBlocked": 2, "tasksUnblocked": 1} — shape varies per job_key, deliberately not normalized into columns per PRD §6.2's "abstract repeated things, not hypothetical future things"
  error          text
);
create index idx_automation_run_log_org_job on automation_run_log(org_id, job_key, started_at desc);

-- ---------------------------------------------------------------------
-- tasks.pre_block_status — PRD §12's own note on dailyDependencyCheck:
-- "restores interpolated status, not a blind reset." Without storing
-- what the status was immediately before the sweep auto-blocked a task,
-- "restore" has nothing to restore to except a hardcoded guess
-- ('not_started'), which is exactly the blind reset the PRD is warning
-- against. Nullable: null means "this task was never auto-blocked by
-- the sweep" (the common case) or "already restored."
-- ---------------------------------------------------------------------
alter table tasks add column pre_block_status text
  check (pre_block_status is null or pre_block_status in ('not_started', 'in_progress', 'blocked', 'done'));

-- ---------------------------------------------------------------------
-- list_orgs_with_automation_enabled — same shape as 0012's
-- list_active_subscriptions_for_sync: automation_controls has RLS
-- FORCEd (0009), so the maintenance route (no session, no single
-- org_id to SET LOCAL) cannot see any rows through the normal pool
-- connection. This is the one cross-org read the sweep needs; it
-- returns only org_id, the sweep re-enters withOrgContext per row for
-- the actual job logic, same "identity step, never the privileged
-- action itself" reasoning 0012's own comment gives.
--
-- An org with no automation_controls row at all for this key is
-- excluded, not defaulted to enabled — listAutomationControls already
-- seeds all 9 keys on first read (default enabled=true), so a genuinely
-- new org that has never opened its Automation panel yet simply hasn't
-- been seeded; this function is a dispatch list, not a seeding path,
-- and silently running an unseeded org's jobs would bypass the toggle
-- panel's own default-provisioning step.
-- ---------------------------------------------------------------------
create or replace function list_orgs_with_automation_enabled(p_key text)
returns table (org_id uuid)
language sql
security definer
set search_path = public
as $$
  select org_id from automation_controls where key = p_key and enabled;
$$;

alter function list_orgs_with_automation_enabled(text) owner to nexus_bootstrap;
revoke all on function list_orgs_with_automation_enabled(text) from public;
grant execute on function list_orgs_with_automation_enabled(text) to nexus_app;

-- ---------------------------------------------------------------------
-- Row-Level Security — automation_run_log, same tenant_isolation shape
-- as automation_log itself (0009).
-- ---------------------------------------------------------------------
alter table automation_run_log enable row level security;
alter table automation_run_log force row level security;
create policy tenant_isolation on automation_run_log
  using (org_id = current_setting('app.current_org_id', true)::uuid);

grant select, insert, update, delete on automation_run_log to nexus_app;
