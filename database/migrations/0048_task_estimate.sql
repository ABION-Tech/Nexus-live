-- Session 62 — how long a task should take, in minutes (optional).
-- The morning email and the dashboard's "My day" add these up against the
-- free time left in the day, so a person can see whether today's work fits.
-- Up to a week (10,080 minutes); null means "not estimated".
alter table tasks
  add column estimate_minutes integer check (estimate_minutes between 1 and 10080);
