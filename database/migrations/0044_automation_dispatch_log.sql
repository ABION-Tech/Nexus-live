-- Session 60 (C-04) — make a failing scheduler visible.
--
-- automation_run_log (0024) holds one row per company per run, written
-- after each company's job finishes. When the dispatch itself fails —
-- 0043's missing grant, a bad deploy, the database down — no company
-- ever runs, nothing is written, and every Automation panel kept saying
-- "Not yet run" while all seven jobs failed for weeks.
--
-- One row per scheduler call, success or failure, platform-wide (no
-- org_id: it describes the platform, not a company). `alerted_at` marks
-- the row whose failure emailed the platform admins, so the alert goes
-- out at most once a day per job.
create table automation_dispatch_log (
  id           bigserial primary key,
  job_key      text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null check (status in ('success', 'error')),
  orgs_run     integer not null default 0,
  orgs_failed  integer not null default 0,
  error        text,
  alerted_at   timestamptz
);

create index automation_dispatch_log_job_time on automation_dispatch_log (job_key, started_at desc);

grant select, insert, update on automation_dispatch_log to nexus_app;
grant usage on sequence automation_dispatch_log_id_seq to nexus_app;
