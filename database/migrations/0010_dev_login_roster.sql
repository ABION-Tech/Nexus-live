-- ---------------------------------------------------------------------
-- Dev-only login: "pick your roster name" fallback for local testing
-- when Google OAuth isn't reachable (no OAuth client set up on this
-- machine, testing on a device that isn't signed into the developer's
-- own Google account, etc). PRD §10.1 is unchanged: Google OAuth remains
-- the ONLY login path in production. This migration only adds a
-- pre-login *lookup* — issuing a session from it is gated entirely in
-- the API layer (routes/devAuth.ts), which refuses to even mount unless
-- DEV_LOGIN=true and NODE_ENV !== 'production'. If both those app-layer
-- gates ever fail open, this function still only returns id/name/email/
-- org_id/role — the same "narrow SECURITY DEFINER, never select *"
-- shape as find_user_by_email (0003_invites.sql) — never a password
-- hash (there isn't one; this bypasses password auth entirely rather
-- than adding one, since PRD §10.1 never specifies a password path).
-- ---------------------------------------------------------------------

create or replace function list_users_for_dev_login()
returns table (id uuid, name text, email text, org_id uuid, role text)
language sql
security definer
set search_path = public
as $$
  select u.id, u.name, u.email, m.org_id, m.role
    from users u
    join org_memberships m on m.user_id = u.id
   order by u.name;
$$;

alter function list_users_for_dev_login() owner to nexus_bootstrap;
revoke all on function list_users_for_dev_login() from public;
grant execute on function list_users_for_dev_login() to nexus_app;

-- nexus_bootstrap already has `select on users` from 0003_invites.sql,
-- but this is the first SECURITY DEFINER function to also join
-- org_memberships, which nexus_bootstrap has never been granted (0006
-- only granted it to nexus_app). Without this, the function 500s with
-- "permission denied for table org_memberships" the moment it's called
-- — caught by actually calling it against a real Postgres instance
-- (same lesson as 0003_invites.sql's own header comment: this class of
-- bug is invisible by inspection, RLS/grant errors only surface at
-- call time).
grant select on org_memberships to nexus_bootstrap;
