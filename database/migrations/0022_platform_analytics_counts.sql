-- 0022_platform_analytics_counts.sql
-- Session 43 (ADMIN_BUILD_GUIDE.md §3 "Session 5 — Super Admin UI"),
-- found while building the dashboard that actually calls
-- `GET /admin/super/analytics/overview` for the first time against a
-- live, RLS-enforced connection.
--
-- routes/admin/superAdmin.ts's analytics/overview handler runs three
-- raw `pool.query` calls directly against `organizations`, `users`, and
-- `platform_admins`. That's the same raw-pool pattern used elsewhere in
-- this file (investigate/*), but those routes go through 0019's
-- nexus_bootstrap-owned search functions specifically *because* a plain
-- pool connection has no `app.current_org_id` set and both `organizations`
-- and `users` carry `force row level security`. Under a real production
-- connection (`nexus_app` — NOBYPASSRLS, per this repo's own
-- `DECISIONS.md` posture and 0001_init.sql's own comment: "never a
-- superuser / BYPASSRLS role") that means:
--   select org_type, active, count(*) from organizations group by ...
--   select count(*) from users
-- both silently return zero rows, always — not an error, just an empty
-- result, because tenant_isolation's `org_id = current_setting(...)`
-- (or `id = current_setting(...)` for organizations) is never true with
-- no context set. This has been masked in every session up to now
-- because local dev's own DATABASE_URL (apps/api/.env, docker-compose's
-- POSTGRES_USER=nexus) is the Postgres superuser, which bypasses RLS
-- unconditionally regardless of the `nexus_app` role's own
-- nobypassrls flag — so nothing in dev ever exercised the code path a
-- real `nexus_app` production connection would.
--
-- Confirmed live this session, against `nexus_app` specifically (not the
-- dev-only superuser):
--   select count(*) from users;                                   -- 0, with real rows present
--   select org_type, active, count(*) from organizations group by ...; -- 0 rows, with real rows present
--
-- `platform_admins` is unaffected — that table has RLS disabled
-- entirely (0016_admin_foundation.sql never enabled it), confirmed via
-- pg_class.relrowsecurity, so its count in the same route already works.
--
-- Fix, same shape as 0019/0020/0021's own narrow nexus_bootstrap-owned
-- SECURITY DEFINER functions: one function per aggregate, not a general
-- query helper (this file's own established "reviewed as its own
-- isolated unit" doctrine, restated once per addition rather than
-- loosened).

create or replace function platform_organization_counts()
returns table (
  org_type    text,
  active      boolean,
  org_count   bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select org_type, active, count(*) as org_count
    from organizations
   group by org_type, active;
$$;

alter function platform_organization_counts() owner to nexus_bootstrap;
revoke all on function platform_organization_counts() from public;
grant execute on function platform_organization_counts() to nexus_app;

create or replace function platform_user_count()
returns bigint
language sql
security definer
set search_path = public
stable
as $$
  select count(*) from users;
$$;

alter function platform_user_count() owner to nexus_bootstrap;
revoke all on function platform_user_count() from public;
grant execute on function platform_user_count() to nexus_app;
