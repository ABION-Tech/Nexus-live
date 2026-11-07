-- 0021_audit_log_platform_insert_fn.sql
-- Session 40, found while building auditLogService.ts's write side and
-- re-testing 0019's own audit_log fix against this session's live
-- Postgres. 0019 correctly fixed the WITH CHECK gap (platform-level,
-- null-org_id rows can now be inserted at all — confirmed live, plain
-- `insert into audit_log (...) values (..., null, ...)` with no
-- RETURNING succeeds). What's still broken, and is the exact same root
-- cause as 0020's organizations fix: any INSERT with `returning *`
-- against a null-org_id row fails, because Postgres re-checks a
-- RETURNING row against the table's SELECT policy — and
-- tenant_isolation_select's `org_id = current_setting(...)::uuid` can
-- never be true when org_id is null (NULL = anything is NULL, not
-- true). Confirmed live in this session:
--   insert into audit_log (...) values (..., null, ...)              -- succeeds
--   insert into audit_log (...) values (..., null, ...) returning id -- fails,
--     ERROR: new row violates row-level security policy for table "audit_log"
-- This is very likely what the prior session's still-open investigation
-- (SESSION_LOG's Session 40 entry, "minimal repro succeeded, audit_log
-- itself still failing") was actually running into — the minimal repro
-- table there had no RETURNING and no SELECT policy shaped this way, so
-- it never hit this interaction.
--
-- Fix, same pattern as 0020: a narrow nexus_bootstrap-owned SECURITY
-- DEFINER function for the one case that needs it — a platform-level
-- (org_id is null) audit write with its row returned to the caller.
-- Org-scoped audit writes are untouched: auditLogService.ts still does
-- a plain `withOrgContext(orgId, ...)` insert + returning for those,
-- which already works today (org_id equals the active context, so the
-- SELECT-policy recheck passes normally) — this function exists only
-- for the null-org_id branch.
grant insert on audit_log to nexus_bootstrap;

create or replace function insert_platform_audit_log(
  p_user_id uuid,
  p_action text,
  p_resource_type text,
  p_resource_id uuid,
  p_result text,
  p_ip_address text,
  p_user_agent text,
  p_session_id text,
  p_previous_value jsonb,
  p_new_value jsonb,
  p_metadata jsonb
)
returns audit_log
language sql
security definer
set search_path = public
as $$
  insert into audit_log (
    user_id, org_id, action, resource_type, resource_id, result,
    ip_address, user_agent, session_id, previous_value, new_value, metadata
  ) values (
    p_user_id, null, p_action, p_resource_type, p_resource_id, p_result,
    p_ip_address, p_user_agent, p_session_id, p_previous_value, p_new_value, p_metadata
  )
  returning *;
$$;

alter function insert_platform_audit_log(uuid, text, text, uuid, text, text, text, text, jsonb, jsonb, jsonb)
  owner to nexus_bootstrap;
revoke all on function insert_platform_audit_log(uuid, text, text, uuid, text, text, text, text, jsonb, jsonb, jsonb)
  from public;
grant execute on function insert_platform_audit_log(uuid, text, text, uuid, text, text, text, text, jsonb, jsonb, jsonb)
  to nexus_app;
