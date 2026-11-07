-- 0006_org_hierarchy_memberships.sql
-- Supersedes the "one org per user" assumption baked into 0001_init.sql.
-- See database/schema/DECISIONS.md §5 for the reasoning. Summary of the
-- shape change: organizations gain a self-referencing parent (Group →
-- Company), and users move from a single org_id column to a many-to-many
-- org_memberships table (one identity, multiple tenant memberships, each
-- with its own role) — PRD §3 role enum unchanged, just now per-membership
-- instead of per-user.

-- ---------------------------------------------------------------------
-- organizations: add hierarchy
-- ---------------------------------------------------------------------
alter table organizations
  add column org_type      text not null default 'company' check (org_type in ('group', 'company')),
  add column parent_org_id uuid references organizations(id);

-- A company's parent must be a group; a group has no parent. Enforced
-- at the app layer on write (cheap check, avoided a trigger for a v1
-- table with a handful of rows) — flagged here so it isn't forgotten.

create index idx_organizations_parent on organizations(parent_org_id);

-- ---------------------------------------------------------------------
-- org_memberships: replaces users.org_id / users.role
-- ---------------------------------------------------------------------
create table org_memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  org_id      uuid not null references organizations(id) on delete cascade,
  role        text not null check (role in ('leader', 'team_member', 'intern')),
  title       text,                    -- display-only, e.g. "CEO", "Board/Strategy" — not RBAC-bearing
  is_home     boolean not null default false, -- the one membership used as default login context
  granted_by  uuid references users(id),
  granted_at  timestamptz not null default now(),
  unique (user_id, org_id)
);

create index idx_org_memberships_user on org_memberships(user_id);
create index idx_org_memberships_org  on org_memberships(org_id);

-- Exactly one is_home = true per user — partial unique index, not a
-- check constraint (check constraints can't reference other rows).
create unique index idx_org_memberships_one_home
  on org_memberships(user_id) where is_home;

-- ---------------------------------------------------------------------
-- Backfill: every existing users.org_id/role row becomes its is_home
-- membership. Existing single-org data (v1's actual current state) is
-- preserved exactly, nothing is dropped silently.
-- ---------------------------------------------------------------------
insert into org_memberships (user_id, org_id, role, is_home, granted_at)
select id, org_id, role, true, created_at from users;

-- ---------------------------------------------------------------------
-- users: drop the now-redundant single-org columns, add home_org_id as
-- a denormalized pointer (avoids a join on every login to find "which
-- org do I land in by default" — is_home in org_memberships stays the
-- source of truth; this is a cache of it, kept in sync by the API).
-- ---------------------------------------------------------------------
alter table users add column home_org_id uuid references organizations(id);
update users set home_org_id = org_id;
alter table users alter column home_org_id set not null;

-- Must drop the old policy before dropping org_id — the policy itself
-- references that column, so Postgres refuses the column drop otherwise
-- ("policy tenant_isolation on table users depends on column org_id").
-- Moved up from where it originally sat (just before the new policy is
-- created, further below) — verified against a real Postgres instance,
-- not just re-ordered by inspection.
drop policy tenant_isolation on users;

alter table users drop constraint users_org_id_fkey;
drop index idx_users_org;
alter table users drop column org_id;
alter table users drop column role;

-- ---------------------------------------------------------------------
-- permissions: was unique(user_id, resource, action) — wrong once a
-- user can hold different grants in different orgs. A team member who
-- is a leader in Company B and a team member in Company A needs two
-- rows, not one that leaks across tenants.
-- ---------------------------------------------------------------------
alter table permissions drop constraint permissions_user_id_resource_action_key;
alter table permissions add constraint permissions_user_org_resource_action_key
  unique (user_id, org_id, resource, action);

-- ---------------------------------------------------------------------
-- sessions.org_id is now "currently active workspace", not "the user's
-- only org" — mutable via a workspace-switch endpoint. Add a guard so a
-- session can never be pointed at an org the user isn't a member of;
-- enforced at the app layer (sessions is RLS-exempt — see 0002 note —
-- so it can't be enforced by a policy here).
-- ---------------------------------------------------------------------
-- (no schema change needed on sessions itself — flagged for the API:
--  the workspace-switch handler must check org_memberships before
--  updating sessions.org_id.)

-- ---------------------------------------------------------------------
-- RLS: replace the users policy (org_id no longer exists on the table)
-- and add policies for the two new tables.
-- ---------------------------------------------------------------------
alter table org_memberships enable row level security;
alter table org_memberships force row level security;

-- Two independent reasons a membership row is visible:
--  1. It's your own membership — needed to populate the workspace
--     switcher, which by definition lists orgs outside the currently
--     active one. Scoped by app.current_user_id, a session var the API
--     must now set alongside app.current_org_id (see note below).
--  2. It's a membership inside the org you're currently scoped to —
--     needed for a leader viewing their org's Team Members directory.
create policy self_or_current_org on org_memberships
  using (
    user_id = current_setting('app.current_user_id', true)::uuid
    or org_id = current_setting('app.current_org_id', true)::uuid
  );

-- users: visible if you hold a membership in the org you're currently
-- scoped to. Same fail-closed property as every other policy — if
-- app.current_org_id is unset, current_setting(...) is null, no
-- membership row matches, zero rows returned.
create policy tenant_isolation on users
  using (
    exists (
      select 1 from org_memberships m
      where m.user_id = users.id
        and m.org_id = current_setting('app.current_org_id', true)::uuid
    )
  );

-- organizations: a company is visible if it's your current org, or
-- it's the parent group of your current org (so a company-scoped user
-- can still resolve "which group am I under" for breadcrumb/UI
-- purposes without granting them the group's own data).
alter table organizations enable row level security;
alter table organizations force row level security;

create policy tenant_isolation on organizations
  using (
    id = current_setting('app.current_org_id', true)::uuid
    or id = (
      select parent_org_id from organizations
      where id = current_setting('app.current_org_id', true)::uuid
    )
  );

grant select, insert, update, delete on org_memberships to nexus_app;
grant select, update on organizations to nexus_app;

-- ---------------------------------------------------------------------
-- find_user_by_email (0003_invites.sql) selected role/org_id straight off
-- `users`, both dropped above. Redefined here rather than in a follow-up
-- migration since this migration is what broke it. Same external
-- contract (id, org_id, role) as before, so routes/auth.ts and
-- inviteService.ts — its only two callers — need no changes: internally
-- it now resolves org_id to the user's home_org_id and role via that
-- home membership, instead of columns that no longer exist.
create or replace function find_user_by_email(p_email text)
returns table (id uuid, org_id uuid, role text)
language sql
security definer
set search_path = public
as $$
  select u.id, u.home_org_id as org_id, m.role
    from users u
    join org_memberships m on m.user_id = u.id and m.org_id = u.home_org_id
   where u.email = lower(p_email)
   limit 1;
$$;

-- ---------------------------------------------------------------------
-- REQUIRED API CHANGE (not a schema change, flagged so it isn't missed):
-- withOrgContext currently issues one SET LOCAL (app.current_org_id).
-- It must now also SET LOCAL app.current_user_id from the session's
-- user_id, at the same point in the request lifecycle, or the
-- self_or_current_org policy above can never satisfy its first branch
-- and the workspace switcher will always come back empty.
-- ---------------------------------------------------------------------
