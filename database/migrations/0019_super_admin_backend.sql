-- 0019_super_admin_backend.sql
-- ADMIN_BUILD_GUIDE.md §3 "Session 4 — Super Admin backend" (repo Session
-- 40): "Super Admin cross-org read path built and reviewed as its own
-- isolated unit — not folded into a general query helper." This
-- migration IS that isolated unit's schema half, and it starts by fixing
-- two bugs in 0016_admin_foundation.sql that a real Postgres round-trip
-- surfaced immediately once this session actually exercised those code
-- paths for the first time (Sessions 37-39 never ran organizationService
-- or a platform-level audit_log insert against a live database — see
-- SESSION_LOG's Session 40 entry for the "before/after" of this
-- discovery). Both are genuine correctness bugs, not new session 40
-- scope creep; fixing them is a prerequisite for anything superAdmin.ts
-- calls this session.

-- ---------------------------------------------------------------------
-- BUG 1: organizations' own tenant_isolation policy (0016) is
-- self-referencing — its USING clause runs a SELECT against
-- `organizations` itself to resolve the current org's parent, and
-- `organizations` has `force row level security` set. Under FORCE, that
-- inner SELECT is *also* subject to the very policy being evaluated,
-- which Postgres detects and refuses to run:
--   ERROR: infinite recursion detected in policy for relation "organizations"
-- Confirmed live: `select * from organizations` — with a valid
-- app.current_org_id set — fails with exactly this error as `nexus_app`
-- (NOBYPASSRLS). This has been broken since 0016 landed; nothing in
-- Sessions 37-39 happened to run a real query against `organizations`
-- under RLS to notice.
--
-- Fix follows this repo's own established pattern for "a query that
-- must run ahead of / underneath its own RLS policy" — a nexus_bootstrap
-- (BYPASSRLS) -owned SECURITY DEFINER function, same shape as
-- find_user_by_email/find_invite_by_email (0003_invites.sql). The
-- function's own internal SELECT runs as nexus_bootstrap and is exempt
-- from organizations' RLS entirely, breaking the recursion; the policy
-- itself still only ever admits the same three cases 0016 intended.
-- ---------------------------------------------------------------------
grant select on organizations to nexus_bootstrap;

create or replace function current_org_parent_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select parent_org_id from organizations where id = current_setting('app.current_org_id', true)::uuid;
$$;

alter function current_org_parent_id() owner to nexus_bootstrap;
revoke all on function current_org_parent_id() from public;
grant execute on function current_org_parent_id() to nexus_app;

drop policy tenant_isolation on organizations;

create policy tenant_isolation on organizations
  using (
    id = current_setting('app.current_org_id', true)::uuid
    or id = current_org_parent_id()
    or parent_org_id = current_setting('app.current_org_id', true)::uuid
  );

-- ---------------------------------------------------------------------
-- BUG 2: audit_log's tenant_isolation policy (0016) has no WITH CHECK,
-- so Postgres uses the USING expression for both reads and writes.
-- `org_id = current_setting(...)` is never true when org_id is NULL
-- (NULL = anything is NULL, not TRUE), so a platform-level audit row
-- (org creation, plan change, any Super-Admin action with no single
-- owning org — exactly what 0016's own `org_id` column comment says
-- this is *for*) can never actually be inserted. Confirmed live:
--   insert into audit_log (..., org_id, ...) values (..., null, ...)
--   ERROR: new row violates row-level security policy for table "audit_log"
-- Org-scoped inserts (org_id = the active org) already work today —
-- only the platform-level case was unreachable.
--
-- Fix: split the one ALL-command policy into a SELECT policy (unchanged
-- behavior — org-scoped rows only, null-org rows still invisible to any
-- org-scoped reader, exactly as 0016's own comment describes) and a
-- separate INSERT policy whose WITH CHECK explicitly admits org_id IS
-- NULL. This does not widen what any org-scoped caller can ever *read*
-- — it only lets the write actually land.
-- ---------------------------------------------------------------------
drop policy tenant_isolation on audit_log;

create policy tenant_isolation_select on audit_log
  for select
  using (org_id = current_setting('app.current_org_id', true)::uuid);

create policy tenant_isolation_insert on audit_log
  for insert
  with check (org_id is null or org_id = current_setting('app.current_org_id', true)::uuid);

-- ---------------------------------------------------------------------
-- Super Admin cross-org READ path, part 2: canReadOrg()'s
-- platform_admin branch (authorizationService.ts, Session 37) already
-- authorizes a platform admin to read any *single* org by id — that
-- case needs no new plumbing, since withAuthorizedOrgContext sets
-- app.current_org_id to exactly the target, satisfying tenant_isolation's
-- own first branch. What canReadOrg's app-layer check can't do anything
-- about is a genuinely cross-org, no-single-target query: "list every
-- organization" (investigation search) or "find every user matching
-- this name/email, in any org" (Users investigation) or "every audit
-- row platform-wide" (Audit & Security). Each of those needs exactly one
-- more nexus_bootstrap-owned SECURITY DEFINER function — same trust
-- model as current_org_parent_id() above: the DB grants the *function*
-- broad read access, and routes/admin/superAdmin.ts is the only caller,
-- gated by isPlatformAdmin() before it ever runs. Not a general-purpose
-- query helper (guide's own "reviewed as its own isolated unit" — three
-- narrow, named, single-purpose functions, not one generic escape hatch).
-- ---------------------------------------------------------------------
create or replace function search_organizations(p_query text default null)
returns setof organizations
language sql
security definer
set search_path = public
stable
as $$
  select * from organizations
   where p_query is null or name ilike '%' || p_query || '%'
   order by org_type, name
   limit 200;
$$;

alter function search_organizations(text) owner to nexus_bootstrap;
revoke all on function search_organizations(text) from public;
grant execute on function search_organizations(text) to nexus_app;

-- users/org_memberships select on nexus_bootstrap already exist
-- (0003_invites.sql, 0010_dev_login_roster.sql) — reused here, not
-- re-granted.
create or replace function search_users_platform(p_query text default null)
returns table (
  id uuid,
  name text,
  email text,
  home_org_id uuid,
  home_org_name text,
  role text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select u.id, u.name, u.email, u.home_org_id, o.name as home_org_name, m.role, u.created_at
    from users u
    left join organizations o on o.id = u.home_org_id
    left join org_memberships m on m.user_id = u.id and m.is_home = true
   where p_query is null or u.name ilike '%' || p_query || '%' or u.email ilike '%' || p_query || '%'
   order by u.name asc
   limit 200;
$$;

alter function search_users_platform(text) owner to nexus_bootstrap;
revoke all on function search_users_platform(text) from public;
grant execute on function search_users_platform(text) to nexus_app;

grant select on audit_log to nexus_bootstrap;

-- language plpgsql (not sql) so each filter can be independently
-- optional via `p_x is null or ...` without needing dynamic SQL —
-- superAdmin.ts's own audit query/filter endpoint passes through
-- whatever subset of these the caller supplied, nulls for the rest.
create or replace function search_audit_log(
  p_org_id uuid default null,
  p_user_id uuid default null,
  p_action text default null,
  p_resource_type text default null,
  p_result text default null,
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_limit integer default 100
)
returns setof audit_log
language sql
security definer
set search_path = public
stable
as $$
  select * from audit_log
   where (p_org_id is null or org_id = p_org_id)
     and (p_user_id is null or user_id = p_user_id)
     and (p_action is null or action = p_action)
     and (p_resource_type is null or resource_type = p_resource_type)
     and (p_result is null or result = p_result)
     and (p_since is null or "timestamp" >= p_since)
     and (p_until is null or "timestamp" <= p_until)
   order by "timestamp" desc
   limit least(coalesce(p_limit, 100), 500);
$$;

alter function search_audit_log(uuid, uuid, text, text, text, timestamptz, timestamptz, integer)
  owner to nexus_bootstrap;
revoke all on function search_audit_log(uuid, uuid, text, text, text, timestamptz, timestamptz, integer)
  from public;
grant execute on function search_audit_log(uuid, uuid, text, text, text, timestamptz, timestamptz, integer)
  to nexus_app;
