-- 0028_impersonation.sql
-- ADMIN_BUILD_GUIDE.md §5 "Session 11 — Impersonation". Unblocked by
-- 0027's live-Postgres isolation pass (this session's own prerequisite,
-- per the guide's own gating note).
--
-- Two tables, deliberately not one:
--
--   impersonation_grants — the "own permission gate, distinct from both
--   platform_admins and the group-leader rule" the guide calls for.
--   Holding platform_admins or being a group leader must never be
--   sufficient on its own; this is a separate, explicitly-issued
--   capability, same shape as platform_admins itself (0016) so it gets
--   the same review/revocation story (a plain table a Super Admin can
--   insert/delete from, not a role value folded into an existing enum).
--
--   impersonation_sessions — the record of each individual act of
--   impersonation: who (actor), as whom (target), where (target org),
--   why (reason — required, not optional metadata), and read_only vs
--   write mode. Linked to a real row in `sessions` (session_id) rather
--   than adding impersonation columns to `sessions` itself — `sessions`
--   is the RLS-bootstrapping table (0002's own header: "chicken/egg
--   problem RLS can't solve for its own bootstrapping query") and stays
--   minimal on purpose. Ending an impersonation is exactly "revoke that
--   session row" (existing revokeSession) plus stamping ended_at here —
--   no new revocation mechanism needed.
--
-- Both tables are global/platform-level, not tenant data — no RLS, same
-- exemption class as `sessions`/`platform_admins` (DECISIONS.md #4):
-- these need to be answerable before/independent of any single org's
-- app.current_org_id, and are only ever reached through
-- authorizationService.isImpersonationGranted() /
-- impersonationService.ts, never a general query surface.

create table impersonation_grants (
  user_id     uuid primary key references users(id) on delete cascade,
  granted_by  uuid references users(id),
  granted_at  timestamptz not null default now()
);

grant select, insert, delete on impersonation_grants to nexus_app;

create table impersonation_sessions (
  id              uuid primary key default gen_random_uuid(),
  actor_user_id   uuid not null references users(id),
  -- Denormalized on purpose. verifySession()'s per-request lookup of
  -- this table happens on the raw pool, before any org context is set
  -- (same bootstrapping position as the sessions/users two-query split
  -- this file's own header already documents) — joining straight to
  -- `users` for the actor's display name from that position would hit
  -- `users`' RLS policy with no app.current_org_id set and silently
  -- return nothing, the identical trap already solved once for the
  -- session/user split. Captured once at start time, when the actor's
  -- own authenticated SessionUser (with .name already resolved) is
  -- available — no lookup needed later.
  actor_name      text not null,
  target_user_id  uuid not null references users(id),
  target_org_id   uuid not null references organizations(id),
  session_id      uuid references sessions(id) on delete set null,
  reason          text not null check (length(btrim(reason)) > 0),
  mode            text not null default 'read_only' check (mode in ('read_only', 'write')),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  end_reason      text check (end_reason in ('manual_exit', 'revoked', 'expired')),
  ip_address      text,
  user_agent      text
);

-- verifySession's per-request lookup (by session_id, active only) and
-- the "does this actor already have an active impersonation" guard both
-- need to be cheap; the partial index keeps it small since the vast
-- majority of rows will be ended_at is not null over time.
create unique index idx_impersonation_sessions_active_session
  on impersonation_sessions(session_id)
  where ended_at is null;

create index idx_impersonation_sessions_actor_active
  on impersonation_sessions(actor_user_id)
  where ended_at is null;

create index idx_impersonation_sessions_target_user
  on impersonation_sessions(target_user_id);

grant select, insert, update on impersonation_sessions to nexus_app;
