-- 0029_fix_guc_empty_string_uuid_cast.sql
--
-- Root cause (Session 11 impersonation debugging — live-Postgres repro):
-- once a custom GUC placeholder for app.current_org_id / app.current_user_id
-- has been created on a backend connection (which happens the first time
-- withOrgContext issues `select set_config('app.current_org_id', $1,
-- true)` on that connection), current_setting(name, true) never returns
-- NULL again for the lifetime of that backend session. Verified directly
-- against Postgres 16.15:
--
--   * before the GUC is ever touched: current_setting(name, true) is NULL.
--   * after a `SET LOCAL`-style set_config(..., true) transaction commits
--     (or rolls back): current_setting(name, true) is '' (empty string),
--     not NULL.
--   * explicit RESET and even DISCARD ALL on the same backend do NOT
--     restore NULL — '' persists for the rest of that session.
--
-- node-pg pools reuse backend connections indefinitely, so any pooled
-- connection that has EVER served a withOrgContext() call returns '' —
-- not NULL — for this GUC on every later query outside of an active
-- withOrgContext transaction on that same connection. Every RLS policy
-- in this schema does `current_setting('app.current_org_id',
-- true)::uuid`, which assumes an unset GUC reads as NULL (so the
-- comparison is never true and the policy fails closed). ''::uuid does
-- not evaluate to NULL — it raises a hard `invalid input syntax for
-- type uuid` error. So any raw pool.query() against an RLS-protected
-- table intermittently crashes (rather than the intended "no rows
-- visible") depending on which pooled connection it happens to land on.
-- This is what live-verification hit on the audit_log select after
-- impersonation start.
--
-- Fix: two SQL helper functions that fold '' back to NULL before the
-- cast, and every existing policy is repointed at them in place via
-- ALTER POLICY (scanned live off pg_policies, not a hand-maintained
-- table list) — no policy is dropped and recreated, so names,
-- ownership, and grants are untouched.
--
-- current_org_parent_id() (0019_super_admin_backend.sql) has the same
-- bare-cast bug, but it is NOT a policy — it's a SECURITY DEFINER
-- function owned by nexus_bootstrap (BYPASSRLS), and that privilege
-- escalation is the ONLY reason organizations' own tenant_isolation
-- policy doesn't recurse (0019's "BUG 1"). It is fixed here as its own
-- explicit `create or replace function`, re-stating `security definer`,
-- `set search_path = public`, ownership, and grants exactly as 0019 set
-- them. An earlier attempt at this migration folded the same nullif fix
-- into current_org_parent_id() via a bare `create or replace function
-- ... language sql stable as $$ ... $$` with no `security definer`
-- clause — CREATE OR REPLACE FUNCTION does NOT preserve security
-- attributes that aren't re-specified, so that silently downgraded the
-- function back to SECURITY INVOKER. Its internal `select ... from
-- organizations` then ran as nexus_app (NOBYPASSRLS) instead of
-- nexus_bootstrap, which put it back under organizations' own
-- `force row level security` policy — the exact "infinite recursion
-- detected in policy for relation organizations" bug 0019 already fixed
-- once, reintroduced by omission. Confirmed by reproducing it live and
-- fixing it by re-adding the clause, not by working around the table.
--
-- New policies going forward should be written against
-- app_current_org_id() / app_current_user_id() directly
-- (org_id = app_current_org_id()) instead of the raw
-- current_setting(...)::uuid pattern.

create or replace function app_current_org_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.current_org_id', true), '')::uuid
$$;

create or replace function app_current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

-- Re-created in place, same signature/owner/grants as 0019 — only the
-- internal cast changes (bare current_setting(...)::uuid -> nullif'd).
create or replace function current_org_parent_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select parent_org_id from organizations
  where id = nullif(current_setting('app.current_org_id', true), '')::uuid;
$$;

alter function current_org_parent_id() owner to nexus_bootstrap;
revoke all on function current_org_parent_id() from public;
grant execute on function current_org_parent_id() to nexus_app;

do $$
declare
  pol record;
  new_qual text;
  new_check text;
  sql text;
  changed boolean;
begin
  for pol in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (
        qual ilike '%current_setting(%app.current_org_id%'
        or qual ilike '%current_setting(%app.current_user_id%'
        or with_check ilike '%current_setting(%app.current_org_id%'
        or with_check ilike '%current_setting(%app.current_user_id%'
      )
  loop
    new_qual := pol.qual;
    new_check := pol.with_check;
    changed := false;

    if new_qual is not null then
      if new_qual like '%current_setting(%app.current_org_id%' or new_qual like '%current_setting(%app.current_user_id%' then
        changed := true;
      end if;
      new_qual := replace(new_qual, 'current_setting(''app.current_org_id''::text, true)', 'app_current_org_id()');
      new_qual := replace(new_qual, 'current_setting(''app.current_user_id''::text, true)', 'app_current_user_id()');
    end if;
    if new_check is not null then
      if new_check like '%current_setting(%app.current_org_id%' or new_check like '%current_setting(%app.current_user_id%' then
        changed := true;
      end if;
      new_check := replace(new_check, 'current_setting(''app.current_org_id''::text, true)', 'app_current_org_id()');
      new_check := replace(new_check, 'current_setting(''app.current_user_id''::text, true)', 'app_current_user_id()');
    end if;

    if not changed then
      continue;
    end if;

    sql := format('alter policy %I on %I.%I', pol.policyname, pol.schemaname, pol.tablename);
    if new_qual is not null then
      sql := sql || format(' using (%s)', new_qual);
    end if;
    if new_check is not null then
      sql := sql || format(' with check (%s)', new_check);
    end if;

    raise notice 'Repointing policy %.%: %', pol.tablename, pol.policyname, sql;
    execute sql;
  end loop;
end $$;

-- Sanity check: no policy should still contain a bare
-- current_setting('app.current_org_id'...) / current_setting('app.current_user_id'...) call.
do $$
declare
  leftover_count int;
begin
  select count(*) into leftover_count
  from pg_policies
  where schemaname = 'public'
    and (
      qual ilike '%current_setting(%app.current_org_id%'
      or qual ilike '%current_setting(%app.current_user_id%'
      or with_check ilike '%current_setting(%app.current_org_id%'
      or with_check ilike '%current_setting(%app.current_user_id%'
    );
  if leftover_count > 0 then
    raise exception '% polic(ies) still reference current_setting(...) directly for app.current_org_id/app.current_user_id — migration did not fully repoint them', leftover_count;
  end if;
end $$;
