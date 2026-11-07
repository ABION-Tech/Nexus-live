-- 0003_invites.sql
-- Invites table (PRD §3 invite-and-approval flow) + the identity-
-- resolution bootstrap functions needed to look `users`/`invites` up BY
-- EMAIL before any org context is known. Closes SESSION_LOG Session 5's
-- `not_invited` interim gap.
--
-- ---------------------------------------------------------------------
-- Bug found while building this (by testing against a real Postgres
-- instance, not by inspection — same practice as Session 4/5): the
-- existing OAuth callback's
--   pool.query('select id, org_id from users where email = $1', ...)
-- in routes/auth.ts LOOKS fine, but `users` has RLS FORCE'd
-- (0001_init.sql) and `nexus_app` is NOBYPASSRLS. With no
-- app.current_org_id set — which is the whole point, resolving the org
-- is what this query is FOR — the tenant_isolation policy's USING clause
-- never matches, so this query has always silently returned zero rows,
-- for every email, recognized or not. Session 5's own testing didn't
-- catch this because it only exercised the *session* → users chain (a
-- real session row, org already known via withOrgContext) — it never
-- had real Google credentials to drive the callback's *email* → users
-- lookup end to end. Confirmed empirically here: seeded a real user row
-- as postgres, then queried it as nexus_app with no org context set —
-- 0 rows back, exactly the false-negative "not_invited" a legitimate
-- user would have hit.
--
-- This is the same chicken-and-egg shape DECISIONS.md #4 solved for
-- `sessions` — but `sessions` could just opt out of RLS entirely because
-- it has nothing in it worth protecting beyond the unguessable token
-- hash. `users` and `invites` can't take that same exemption: turning
-- RLS off table-wide would let one leaked raw connection dump every
-- org's full roster, not just resolve the one row a login needs.
--
-- Fix: a dedicated `nexus_bootstrap` role (NOLOGIN — it never connects
-- directly, it only exists to *own* these functions) that holds
-- BYPASSRLS, owning two narrow SECURITY DEFINER functions. Each returns
-- only the columns a pre-login lookup actually needs (id/org_id/role, or
-- an invite's org_id/role/expiry) — never `select *` — so the bypass
-- surface is exactly "resolve which org this email belongs to," not
-- "read any row." `nexus_app` is granted EXECUTE on the functions, never
-- SELECT on the tables directly, so a compromised API process still
-- can't dump `users`/`invites` outside this one lookup shape.
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (select from pg_roles where rolname = 'nexus_bootstrap') then
    create role nexus_bootstrap nosuperuser bypassrls nologin;
  end if;
end $$;

grant select on users to nexus_bootstrap;

create or replace function find_user_by_email(p_email text)
returns table (id uuid, org_id uuid, role text)
language sql
security definer
set search_path = public
as $$
  select id, org_id, role from users where email = lower(p_email) limit 1;
$$;

alter function find_user_by_email(text) owner to nexus_bootstrap;
revoke all on function find_user_by_email(text) from public;
grant execute on function find_user_by_email(text) to nexus_app;

-- ---------------------------------------------------------------------
-- invites
--
-- PRD §3: "Leader sends invite → invitee completes Google OAuth →
-- pending until leader approves." Modelled here as: the invite itself
-- (leader-created, scoped to one email + one role) IS the approval —
-- there's no separate post-signup queue. Acceptance is just the invitee
-- completing OAuth while a matching invite is still pending.
-- ---------------------------------------------------------------------
create table invites (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id),
  email             text not null,
  role              text not null check (role in ('leader', 'team_member', 'intern')),
  invited_by        uuid not null references users(id),
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '14 days'),
  accepted_at       timestamptz,
  accepted_user_id  uuid references users(id),
  revoked_at        timestamptz
);

create index idx_invites_org on invites(org_id);

-- At most one *live* (unaccepted, unrevoked) invite per email per org.
-- Deliberately can't also condition this on `expires_at > now()` — index
-- predicates must be immutable, and now() isn't — so an expired-but-
-- never-revoked row still counts as "live" here. inviteService.createInvite
-- sweeps expired-but-live rows to revoked before inserting, specifically
-- so re-inviting after expiry doesn't collide with this index.
create unique index idx_invites_pending_email
  on invites (org_id, lower(email))
  where accepted_at is null and revoked_at is null;

alter table invites enable row level security;
alter table invites force row level security;
create policy tenant_isolation on invites
  using (org_id = current_setting('app.current_org_id', true)::uuid);

grant select, insert, update, delete on invites to nexus_app;

-- Same bootstrap problem as users: resolving a pending invite by email
-- happens before the invitee has any org context of their own.
grant select on invites to nexus_bootstrap;

create or replace function find_invite_by_email(p_email text)
returns table (id uuid, org_id uuid, role text, expires_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select id, org_id, role, expires_at
    from invites
   where lower(email) = lower(p_email)
     and accepted_at is null
     and revoked_at is null
   order by created_at desc
   limit 1;
$$;

alter function find_invite_by_email(text) owner to nexus_bootstrap;
revoke all on function find_invite_by_email(text) from public;
grant execute on function find_invite_by_email(text) to nexus_app;
