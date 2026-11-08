-- 0039_personal_api_keys.sql
-- Session 56. Personal API keys: a person creates a key in Settings →
-- Account so another app of theirs (first: Synergia, their personal
-- planner) can read their own Nexus work.
--
-- Rules the API enforces (services/personalKeyService.ts):
--   * the key itself is shown once, at creation; only its SHA-256 is
--     stored here, the same way session tokens are (sessions, 0003);
--   * a key acts as exactly one person in exactly one organization, and
--     only for the scopes listed — v1 has one scope, 'tasks:read';
--   * revoking is immediate and permanent (revoked_at), never a delete,
--     so the audit trail of when a key existed survives.
--
-- Looked up by hash before any org context exists, like `sessions`
-- (DECISIONS.md #4): no RLS. Every query the API makes against this table
-- filters by token hash or by the signed-in user's own id.
create table personal_api_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  org_id        uuid not null references organizations(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 60),
  prefix        text not null,
  key_hash      text not null unique,
  scopes        text[] not null default array['tasks:read'],
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index personal_api_keys_user_idx on personal_api_keys (user_id) where revoked_at is null;
grant select, insert, update on personal_api_keys to nexus_app;
