-- 0020_organizations_platform_writes.sql
-- Session 40, discovered while wiring routes/admin/superAdmin.ts's org
-- CRUD endpoints to organizationService.ts against this session's live
-- Postgres (same discipline as 0019's own two bugs) — a third, related
-- gap, distinct from the two 0019 already fixed.
--
-- organizationService.ts's write functions (createOrganization,
-- updateOrganization, assignCompanyToGroup) all run on the RAW pool,
-- never withOrgContext — deliberately: these are platform-admin actions
-- with no single owning org context to set (creating a brand-new group,
-- changing a company's plan, moving a company between groups).
-- Authorization is checked in JS first (isPlatformAdmin() / canReadOrg())
-- before any query runs.
--
-- Confirmed live, as nexus_app, this session's actual code path:
--   insert into organizations (name, org_type) values (...) returning *
--   ERROR: new row violates row-level security policy for table "organizations"
-- First attempt (granting INSERT + a permissive `with check (true)`
-- write policy) still failed on the exact same error even though the
-- INSERT's own WITH CHECK now passed — because organizationService.ts's
-- queries all use `returning *`, and Postgres re-checks a written row
-- against the table's SELECT policy for any RETURNING clause. A
-- freshly-created org (or one updated with no app.current_org_id set)
-- never satisfies tenant_isolation_select's USING clause, so the
-- RETURNING itself raised the same RLS error — granting broader
-- INSERT/UPDATE alone does not fix this shape.
--
-- Fix: this codebase's own established pattern for "a query that must
-- run ahead of / underneath its own RLS policy" (current_org_parent_id,
-- search_organizations, search_users_platform, search_audit_log — all
-- 0019) — a nexus_bootstrap (BYPASSRLS) -owned SECURITY DEFINER
-- function per write operation. The function's internal insert/update +
-- returning runs as nexus_bootstrap and is exempt from organizations'
-- RLS entirely; nexus_app only ever gets EXECUTE on these three named
-- functions, never table-level INSERT/UPDATE — narrower than the first
-- attempt, and consistent with "three narrow, named, single-purpose
-- functions, not one generic escape hatch" (0019's own phrasing).
-- organizationService.ts is updated in this same session to call these
-- instead of a raw insert/update, exactly as it already does for
-- listCompaniesInGroup via withOrgContext for the tenant-scoped read.
--
-- organizations' SELECT policy (tenant_isolation_select, from 0019) is
-- unchanged by this migration — tenant-scoped reads stay exactly as
-- restrictive as before; only these three named write paths change.

-- The three SECURITY DEFINER functions below run their insert/update as
-- nexus_bootstrap. BYPASSRLS exempts them from organizations' RLS
-- policies, but table-level grants are a separate mechanism entirely —
-- nexus_bootstrap had neither before this line (0019 only ever granted
-- it SELECT, for current_org_parent_id/search_organizations' read-only
-- needs). Confirmed live: without this grant, calling
-- create_organization_row as nexus_app fails with
-- "permission denied for table organizations" even though the function
-- owner has BYPASSRLS — RLS-bypass and privilege grants are independent
-- checks, and a SECURITY DEFINER function still needs the latter.
grant select, insert, update on organizations to nexus_bootstrap;

create or replace function create_organization_row(
  p_name text,
  p_org_type text,
  p_parent_org_id uuid
)
returns organizations
language sql
security definer
set search_path = public
as $$
  insert into organizations (name, org_type, parent_org_id)
  values (p_name, p_org_type, p_parent_org_id)
  returning *;
$$;

alter function create_organization_row(text, text, uuid) owner to nexus_bootstrap;
revoke all on function create_organization_row(text, text, uuid) from public;
grant execute on function create_organization_row(text, text, uuid) to nexus_app;

-- `null` sentinel means "leave unchanged" for each of the three
-- optional fields — matches organizationService.updateOrganization's
-- own existing partial-patch shape (only build the SET clauses for
-- fields actually present in `patch`), just expressed as coalesce here
-- instead of dynamic SQL. Safe for the boolean `active` column too:
-- coalesce(false, active) still correctly yields false when the caller
-- explicitly passes false — "unchanged" is represented by an absent/
-- null parameter, not by the value false.
create or replace function update_organization_row(
  p_id uuid,
  p_name text,
  p_plan text,
  p_active boolean
)
returns organizations
language sql
security definer
set search_path = public
as $$
  update organizations
     set name   = coalesce(p_name, name),
         plan   = coalesce(p_plan, plan),
         active = coalesce(p_active, active)
   where id = p_id
   returning *;
$$;

alter function update_organization_row(uuid, text, text, boolean) owner to nexus_bootstrap;
revoke all on function update_organization_row(uuid, text, text, boolean) from public;
grant execute on function update_organization_row(uuid, text, text, boolean) to nexus_app;

create or replace function assign_company_to_group_row(
  p_company_id uuid,
  p_group_id uuid
)
returns organizations
language sql
security definer
set search_path = public
as $$
  update organizations
     set parent_org_id = p_group_id
   where id = p_company_id
   returning *;
$$;

alter function assign_company_to_group_row(uuid, uuid) owner to nexus_bootstrap;
revoke all on function assign_company_to_group_row(uuid, uuid) from public;
grant execute on function assign_company_to_group_row(uuid, uuid) to nexus_app;
