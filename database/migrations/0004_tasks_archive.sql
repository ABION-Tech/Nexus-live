-- 0004_tasks_archive.sql
-- PRD §6.4.1: `DELETE /api/v1/tasks/:id → archive (not hard delete)`.
-- 0001_init.sql's `tasks` table had no way to represent "archived" —
-- fixed here rather than retrofitted silently once the tasks routes
-- needed it (SESSION_LOG: "Add archived_at to tasks — DELETE is
-- archive-not-delete per PRD §6.4.1").

alter table tasks add column archived_at timestamptz;

-- Every list/count query in taskService filters `archived_at is null` by
-- default, so that's the index that matters — not a plain column index.
create index idx_tasks_org_active on tasks(org_id) where archived_at is null;
