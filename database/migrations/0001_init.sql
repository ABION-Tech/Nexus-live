-- 0001_init.sql
-- First-draft schema per PRD §9 + database/schema/DECISIONS.md.
-- Scope: organizations, users, permissions, tasks, goals, pending_ai_tasks,
-- task_trends. Remaining §9.1 entity map tables land in later migrations.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- organizations (multi-tenancy root — PRD §13.5, v1 has exactly one row)
-- ---------------------------------------------------------------------
create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- users — canonical identity table (PRD §9: replaces name-based FKs)
-- ---------------------------------------------------------------------
create table users (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  name        text not null,
  email       text not null unique,
  role        text not null check (role in ('leader', 'team_member', 'intern')),
  avatar_url  text,
  created_at  timestamptz not null default now()
);

create index idx_users_org on users(org_id);

-- ---------------------------------------------------------------------
-- permissions — resource+action-scoped grants (PRD §13.3)
-- ---------------------------------------------------------------------
create table permissions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  org_id      uuid not null references organizations(id),
  resource    text not null,
  action      text not null check (action in ('read', 'create', 'update', 'delete', 'approve', 'export')),
  granted_by  uuid not null references users(id),
  granted_at  timestamptz not null default now(),
  unique (user_id, resource, action)
);

create index idx_permissions_org on permissions(org_id);
create index idx_permissions_user on permissions(user_id);

-- ---------------------------------------------------------------------
-- goals (PRD §8.5)
-- ---------------------------------------------------------------------
create table goals (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id),
  title              text not null,
  status             text not null default 'active' check (status in ('active', 'archived')),
  created_by_user_id uuid not null references users(id),
  created_at         timestamptz not null default now()
);

create index idx_goals_org on goals(org_id);

-- ---------------------------------------------------------------------
-- pending_ai_tasks — goal decomposition proposals (DECISIONS.md #1)
-- ---------------------------------------------------------------------
create table pending_ai_tasks (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references organizations(id),
  goal_id                     uuid not null references goals(id) on delete cascade,
  title                       text not null,
  description                 text,
  depends_on_pending_task_id  uuid references pending_ai_tasks(id),
  reasoning                   text,
  status                      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at                  timestamptz not null default now()
);

create index idx_pending_ai_tasks_org on pending_ai_tasks(org_id);
create index idx_pending_ai_tasks_goal on pending_ai_tasks(goal_id);

-- ---------------------------------------------------------------------
-- tasks (PRD §8.2 / §9)
-- ---------------------------------------------------------------------
create table tasks (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references organizations(id),
  title                    text not null,
  description              text,
  status                   text not null default 'not_started' check (status in ('not_started', 'in_progress', 'blocked', 'done')),
  assigned_to_user_id      uuid references users(id),
  support_user_id          uuid references users(id),
  supervisor_user_id       uuid references users(id),
  depends_on_task_id       uuid references tasks(id),
  goal_id                  uuid references goals(id),
  source_pending_task_id   uuid references pending_ai_tasks(id),
  business                 text,
  department               text,
  deadline                 timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index idx_tasks_org on tasks(org_id);
create index idx_tasks_assigned on tasks(assigned_to_user_id);
create index idx_tasks_goal on tasks(goal_id);

-- ---------------------------------------------------------------------
-- task_trends — daily snapshot, plain table + date index (DECISIONS.md #2)
-- ---------------------------------------------------------------------
create table task_trends (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  user_id       uuid references users(id),
  date          date not null,
  open_tasks    integer not null default 0,
  done_today    integer not null default 0,
  overdue       integer not null default 0,
  at_risk       integer not null default 0,
  created_at    timestamptz not null default now()
);

create index idx_task_trends_org_date on task_trends(org_id, date);

-- ---------------------------------------------------------------------
-- Row-Level Security (PRD §13.5 — second, independent tenant-isolation
-- layer below the application-level permissions check)
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in select unnest(array[
    'users', 'permissions', 'goals', 'pending_ai_tasks', 'tasks', 'task_trends'
  ])
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = current_setting(''app.current_org_id'', true)::uuid)',
      t
    );
  end loop;
end $$;

-- Application role: connects with a session-scoped app.current_org_id,
-- never a superuser / BYPASSRLS role (RLS is a no-op for those).
do $$
begin
  if not exists (select from pg_roles where rolname = 'nexus_app') then
    create role nexus_app nosuperuser nobypassrls login password 'change_me_in_env';
  end if;
end $$;

grant usage on schema public to nexus_app;
grant select, insert, update, delete on
  organizations, users, permissions, goals, pending_ai_tasks, tasks, task_trends
  to nexus_app;
