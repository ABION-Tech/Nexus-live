-- 0002_sessions.sql
-- Server-side session storage backing the httpOnly auth cookie (PRD §13.2:
-- "Auto-revocation on logout, password change, or permission downgrade" —
-- not achievable with a stateless token, needs a row we can delete).

create table sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  org_id        uuid not null references organizations(id),
  token_hash    text not null unique, -- sha256 of the opaque cookie value; raw value never stored
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz
);

create index idx_sessions_token_hash on sessions(token_hash);
create index idx_sessions_user on sessions(user_id);

-- NOTE — deliberately NOT enabling RLS on this table (unlike every other
-- tenant table in 0001_init.sql). Session lookup is how org context gets
-- established in the first place (SET LOCAL app.current_org_id happens
-- *after* the session row is read) — a chicken/egg problem RLS can't
-- solve for its own bootstrapping query. Row access is instead scoped by
-- matching the sha256 of an unguessable 32-byte random token, which is a
-- stronger guarantee for this specific table than org_id equality would
-- be. See database/schema/DECISIONS.md.

grant select, insert, update, delete on sessions to nexus_app;
