-- 0034_abion_demo_seed_gaps.sql
-- Closes the schema gaps found while writing the ABION demo seed
-- (seedAbionDemo.ts) against the real legacy data. Each of these is
-- real legacy content that had nowhere to land, not a hypothetical:
--
-- 1. `interns` table never existed despite PRD §9's entity map listing
--    one (mapped from "10. Interns"). Added now, matching the shape
--    every other simple entity table in this schema uses.
-- 2. `tasks.start_date` — legacy Master Tasks.Start Date had no column.
-- 3. `marketing_content` had no caption/content-text column at all —
--    legacy Topic/Caption (the actual text of each post) was unwritable.
-- 4. `meetings` had no agenda/invitees columns — legacy Agenda,
--    Team_Invitees, and External_Emails were unwritable (previously
--    folded into `notes` as a workaround; now first-class columns).
-- 5. `pending_ai_tasks.reviewed_by`/`reviewed_at` — Review Queue
--    approve/reject had no record of who decided or when, at the
--    schema level. (approvalService.ts's own approvePendingTask route
--    didn't even have an actor to record — see that file's changes.)
-- 6. `goals.status` only allowed ('active','archived') — legacy
--    'Drafting' (6 of 9 real ABION goals) had no equivalent.

-- ---------------------------------------------------------------------
-- 1. Interns
-- ---------------------------------------------------------------------
-- Mirrors PRD §8.9's EOD pattern (a per-day activity log per person),
-- not a separate onboarding-tracking schema — matches how the legacy
-- "10. Interns" sheet is shaped (Name, Date, activity fields), and how
-- Onboarding itself already deliberately reuses the task system rather
-- than inventing a parallel HR schema (PRD §8.4).
create table interns (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  user_id       uuid not null references users(id), -- the intern, still a real `users` row (role = 'intern')
  date          date not null,
  activity      text not null,
  status        text not null default 'in_progress' check (status in ('in_progress', 'done')),
  proof_link    text,
  supervisor_user_id uuid references users(id),
  created_at    timestamptz not null default now(),
  unique (org_id, user_id, date)
);
create index idx_interns_org_date on interns(org_id, date);
create index idx_interns_user on interns(user_id);

alter table interns enable row level security;
alter table interns force row level security;
create policy tenant_isolation on interns
  using (org_id = current_setting('app.current_org_id', true)::uuid);
grant select, insert, update, delete on interns to nexus_app;

-- ---------------------------------------------------------------------
-- 2. tasks.start_date
-- ---------------------------------------------------------------------
alter table tasks add column start_date date;

-- ---------------------------------------------------------------------
-- 3. marketing_content — real content text
-- ---------------------------------------------------------------------
alter table marketing_content add column caption text;

-- ---------------------------------------------------------------------
-- 4. meetings — agenda + invitees as first-class columns
-- ---------------------------------------------------------------------
alter table meetings add column agenda text;
alter table meetings add column invitee_user_ids uuid[] not null default '{}';
alter table meetings add column external_emails text; -- free text list — external attendees aren't `users` rows

-- ---------------------------------------------------------------------
-- 5. pending_ai_tasks — reviewer identity
-- ---------------------------------------------------------------------
alter table pending_ai_tasks add column reviewed_by uuid references users(id);
alter table pending_ai_tasks add column reviewed_at timestamptz;

-- ---------------------------------------------------------------------
-- 6. goals.status — add 'drafting'
-- ---------------------------------------------------------------------
-- 'drafting': goal exists but hasn't been decomposed into proposed
-- tasks yet (or decomposition hasn't been reviewed at all) — the real
-- legacy state for 6 of the 9 real ABION goals, none of which had any
-- Pending AI Tasks rows. Kept as a genuinely distinct state from
-- 'active', not folded into it: a goal with zero reviewed tasks isn't
-- "running," it's still being set up. Default stays 'active' —
-- createGoal() always creates its proposedTasks in the same
-- transaction (PRD §8.5's decomposition flow), so a goal created
-- through the real app is decomposed by construction; 'drafting' is
-- reachable only via direct creation without proposedTasks, exactly
-- the legacy-import case this migration exists for.
alter table goals drop constraint goals_status_check;
alter table goals add constraint goals_status_check check (status in ('drafting', 'active', 'archived'));
