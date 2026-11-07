-- 0017_projects.sql
-- Session 38 (repo numbering) = ADMIN_BUILD_GUIDE.md "Session 2":
-- Projects & project memberships. Builds the schema DECISIONS.md §5
-- explicitly sketched and deferred: "a `projects` table with `org_id`
-- (owning org) plus its own `project_memberships` (allowing a `user_id`/
-- `org_id` pair from a *different* org to hold project-scoped access)".
-- Same shape used twice already (goals; marketing_content) — see
-- ADMIN_BUILD_GUIDE.md §2 for why this is "the Goals precedent, applied
-- a third time" rather than a new pattern.

create table projects (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id), -- owning org
  title              text not null,
  description        text,
  status             text not null default 'active' check (status in ('active', 'archived')),
  created_by_user_id uuid not null references users(id),
  created_at         timestamptz not null default now()
);

create index idx_projects_org on projects(org_id);

-- ---------------------------------------------------------------------
-- project_memberships — the cross-org access grant DECISIONS.md §5
-- deferred out of 0006. `org_id` here mirrors the project's own owning
-- org (kept redundant, same as every other tenant-owned table, so this
-- table's own RLS policy is the same one-line `org_id = current_org`
-- shape as everywhere else) — it is NOT the member's org. A member from
-- a different org (a guest, or per DECISIONS.md's sketch, an actual
-- collaborator from Company B on a Company A-owned project) is still
-- represented correctly: `user_id` identifies them regardless of which
-- org they call home, and the actual cross-org read path
-- (projectService.getProjectForMember, apps/api) authorizes against
-- this row on the raw pool *before* establishing org context, then
-- reads the rest of that one project's data inside
-- withOrgContext(<project's own org_id>, ...) — the same
-- "N separately-scoped queries, never a widened business-table policy"
-- doctrine DECISIONS.md §5 already commits to for the group/company
-- read case. No widening of `projects`' or `tasks`' RLS policy was
-- needed for this — that's the point of keeping this table's role
-- narrow: it's the one thing checked outside RLS, not a reason to loosen
-- RLS itself.
-- ---------------------------------------------------------------------
create table project_memberships (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references projects(id) on delete cascade,
  org_id           uuid not null references organizations(id), -- the project's own owning org, not the member's
  user_id          uuid not null references users(id),
  added_by_user_id uuid references users(id),
  created_at       timestamptz not null default now(),
  unique (project_id, user_id)
);

create index idx_project_memberships_project on project_memberships(project_id);
create index idx_project_memberships_org on project_memberships(org_id);
create index idx_project_memberships_user on project_memberships(user_id);

-- tasks: project_id alongside the existing goal_id — same "a task
-- belongs to at most one container of a given kind, nullable" shape,
-- not a variant of goal_id (a task could in principle sit under both a
-- goal and a project; that's not disallowed here, matching how nothing
-- disallows a task with both business and department set today).
alter table tasks add column project_id uuid references projects(id);
create index idx_tasks_project on tasks(project_id);

do $$
declare
  t text;
begin
  foreach t in array array['projects', 'project_memberships'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = current_setting(''app.current_org_id'', true)::uuid)',
      t
    );
  end loop;
end $$;

grant select, insert, update, delete on projects, project_memberships to nexus_app;
