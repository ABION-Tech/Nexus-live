-- Session 60 (C-11) — the two scheduled jobs that were never built,
-- because the columns they need didn't exist (automationJobs.ts header):
--
-- daily_recurring_tasks (10:00 Lagos)
--   A task with `recurrence` set repeats. Each day it's due, the job
--   makes a fresh copy: same title, notes, priority, people, business,
--   department, goal and project, checklist unticked, status Not started,
--   starting that day. The original is never changed. A copy remembers
--   its original in recurrence_source_id, and the unique index below
--   means a task can never get two copies for the same day — re-running
--   the job, or a retry, makes nothing new.
--     daily     every day
--     weekdays  Monday to Friday
--     weekly    the same weekday as the original's start date
--     monthly   the same day of the month (the last day, in shorter months)
--   The first copy is the day after the original's start date (or
--   creation date): the original covers its own day.
--
-- hourly_follow_up (on the hour, 08:00–19:00 Lagos, weekdays)
--   A task with follow_up_hours set nudges its assignee when nobody has
--   updated it for that many hours, then again only after another
--   follow_up_hours without an update. last_follow_up_at is when it last
--   nudged; it's written without touching updated_at, so a nudge isn't
--   mistaken for an update.
alter table tasks
  add column recurrence text check (recurrence in ('daily', 'weekdays', 'weekly', 'monthly')),
  add column recurrence_source_id uuid references tasks(id) on delete set null,
  add column follow_up_hours integer check (follow_up_hours between 1 and 720),
  add column last_follow_up_at timestamptz;

create unique index tasks_one_copy_per_day on tasks (recurrence_source_id, start_date)
  where recurrence_source_id is not null;
create index tasks_recurring on tasks (org_id) where recurrence is not null and archived_at is null;
create index tasks_follow_up on tasks (org_id) where follow_up_hours is not null and archived_at is null and status <> 'done';
