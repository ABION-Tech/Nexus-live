-- Marketing content is a task, broken into stages — not a flat record
-- with its own status field standing alone. Each marketing_content item
-- now generates real `tasks` rows (Script → Production/Shoot-Cast-Edit →
-- SMM Caption & Upload), chained via tasks' existing depends_on_task_id,
-- each independently assignable via tasks' existing assigned_to_user_id.
-- This reuses the whole Task infrastructure (status, deadlines, RBAC,
-- Failsafe/analytics queries that already scan `tasks`) instead of
-- reinventing per-stage assignment on marketing_content itself.
alter table tasks add column marketing_content_id uuid references marketing_content(id);
create index idx_tasks_marketing_content on tasks(marketing_content_id);
