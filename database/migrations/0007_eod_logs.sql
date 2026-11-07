-- 0007_eod_logs.sql (renumbered from 0006 during reconciliation with the
-- org_hierarchy_memberships branch, which claimed 0006 first)
-- PRD §9.1: `eod_logs` (from "5. KPI Log" sheet). Phase 2 of the Analytics
-- build (SESSION_LOG) — EOD compliance summary + the `eod` Failsafe
-- category (§8.7, §8.9) both need this table; neither existed before.

-- PRD §8.4 Attendance: "EOD-day-aware — only flags members scheduled to
-- report today (EOD_Days column)." Ported onto `users` rather than a
-- separate schedule table — it's a per-user setting with no history
-- requirement (unlike eod_logs itself, which is an append/amend log),
-- so a column is the straight-line port of the sheet's own EOD_Days
-- column, not an under-abstraction.
-- 0 = Sunday .. 6 = Saturday (Postgres extract(dow) convention — kept
-- consistent so getMembersExpectedToday's query below doesn't need a
-- day-numbering translation layer).
alter table users add column eod_days smallint[] not null default '{1,2,3,4,5}';

create table eod_logs (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id),
  user_id            uuid not null references users(id), -- who the EOD is filed for
  filed_by_user_id   uuid not null references users(id), -- who submitted it (self, or a supervisor filing on someone's behalf — PRD §8.9 "who am I filing for" selector)
  date               date not null,
  summary            text not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, user_id, date) -- one EOD per person per day; re-filing amends it, not a duplicate row
);

create index idx_eod_logs_org_date on eod_logs(org_id, date);
create index idx_eod_logs_user on eod_logs(user_id);

-- Same RLS pattern as 0001_init.sql's tenant tables (DECISIONS.md #3) —
-- applied individually here since that migration's table array is fixed
-- history, not something later migrations edit in place.
alter table eod_logs enable row level security;
alter table eod_logs force row level security;
create policy tenant_isolation on eod_logs
  using (org_id = current_setting('app.current_org_id', true)::uuid);

grant select, insert, update, delete on eod_logs to nexus_app;
