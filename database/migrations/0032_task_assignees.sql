-- 0032_task_assignees.sql
-- Backs TaskDrawer.tsx's "People on this task" panel (TaskPeoplePanel) —
-- people beyond the single primary assigned_to_user_id/support_user_id
-- columns already on `tasks`. A separate table rather than array columns
-- on `tasks` because it needs its own `created_at`/`added_by_user_id`
-- per person and its own RLS-covered access path, same "join table, not
-- a column" shape as `project_memberships` (0017_projects.sql).
--
-- `role` reuses the same two values TaskDrawer.tsx's UI already offers
-- ('assignee', 'support') rather than inventing a third vocabulary next
-- to `tasks.assigned_to_user_id`/`support_user_id` — this table is
-- explicitly *additional* people in either of those two capacities, not
-- a replacement for the primary fields, so the values need to match.
--
-- unique(task_id, user_id, role) allows the same person to appear as
-- both 'assignee' and 'support' on one task (two separate rows), but not
-- twice in the same role — mirrors permissions' own
-- unique(user_id, resource, action) shape.

create table task_assignees (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id),
  task_id          uuid not null references tasks(id) on delete cascade,
  user_id          uuid not null references users(id),
  role             text not null check (role in ('assignee', 'support')),
  added_by_user_id uuid references users(id),
  created_at       timestamptz not null default now(),
  unique (task_id, user_id, role)
);

create index idx_task_assignees_task on task_assignees(task_id);
create index idx_task_assignees_org on task_assignees(org_id);
create index idx_task_assignees_user on task_assignees(user_id);

-- ---------------------------------------------------------------------
-- Row-Level Security — same tenant_isolation shape as every prior
-- migration's own loop (0001_init.sql, 0008_network.sql, 0017_projects.sql).
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in select unnest(array['task_assignees'])
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = current_setting(''app.current_org_id'', true)::uuid)',
      t
    );
  end loop;
end $$;

grant select, insert, update, delete on task_assignees to nexus_app;

-- ---------------------------------------------------------------------
-- Access rule (enforced in routes/tasks.ts, not here): reading the list
-- uses the same gate as the task thread itself — a general `tasks.read`
-- grant OR canViewTaskThread (assignee/support/supervisor on the task's
-- own primary fields), per taskService.ts's own comment on why that
-- gate is broader than isOwnTask. Adding/removing a row uses the same
-- gate as PATCH /tasks/:id — `tasks.update` OR isOwnTask — matching
-- TaskSection.tsx's `canEditTask` (the only thing that renders the
-- panel's add/remove controls client-side).
-- ---------------------------------------------------------------------
