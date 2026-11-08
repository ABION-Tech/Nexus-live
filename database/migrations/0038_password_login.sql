-- 0038_password_login.sql
-- Session 54. Email + password sign-in for members, alongside Google
-- (which stays available once its OAuth client is configured).
--
-- Passwords are never chosen by an admin or sent by email: a person asks
-- for a one-time "set your password" link (also how an invite is accepted
-- without Google), clicks it, and picks their own. Hashes are scrypt with
-- a per-password salt (same scheme as guest credentials, 0016).
-- users.password_hash already exists (0016, guest sign-in) in the same
-- salt:hash format; members now use it too. Guest login still requires
-- role = 'guest' and member login excludes guests, so the two paths can't
-- cross.
alter table users
  add column password_set_at timestamptz;

-- One-time links. Keyed by email, not user id, so the same flow can
-- accept a pending invite for someone who has no account yet. Only a
-- SHA-256 of the token is stored; the token itself exists only in the
-- email. Pre-authentication data, like `sessions` (DECISIONS.md #4): no
-- RLS, the API only ever looks rows up by token hash.
create table password_tokens (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index password_tokens_email_idx on password_tokens (lower(email));
grant select, insert, update, delete on password_tokens to nexus_app;

-- Pre-org-context reads/writes on `users` (FORCE RLS) go through
-- SECURITY DEFINER functions, same as find_user_by_email (0006).
create or replace function find_password_login(p_email text)
returns table (id uuid, org_id uuid, role text, password_hash text)
language sql
security definer
set search_path = public
as $$
  select u.id, u.home_org_id, m.role, u.password_hash
    from users u
    join org_memberships m on m.user_id = u.id and m.org_id = u.home_org_id
   where u.email = lower(p_email)
   limit 1;
$$;
revoke all on function find_password_login(text) from public;
grant execute on function find_password_login(text) to nexus_app;

create or replace function set_user_password(p_user_id uuid, p_hash text)
returns void
language sql
security definer
set search_path = public
as $$
  update users set password_hash = p_hash, password_set_at = now() where id = p_user_id;
$$;
revoke all on function set_user_password(uuid, text) from public;
grant execute on function set_user_password(uuid, text) to nexus_app;
