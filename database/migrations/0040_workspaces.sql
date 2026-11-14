-- 0040_workspaces.sql
-- Session 57. One person, many companies.
--
-- 0006 already made identity and membership separate (users +
-- org_memberships, sessions.org_id = "the company you're in right now").
-- What was missing is everything a person needs to actually live in more
-- than one company:
--
--   * an invite to someone who already has an account. It no longer
--     fails with "already has a NEXUS account": it waits in the app until
--     they Join or Decline. No company can add you without your say.
--   * listing your own companies (the switcher) and your own pending
--     invitations. Both cross company lines by definition, so they are
--     SECURITY DEFINER functions owned by nexus_bootstrap, always called
--     with the user id from a verified session, and they return only
--     that person's own rows. Companies still cannot see each other:
--     nothing here is reachable from inside one company's context.
--   * choosing which company you land in when you sign in.

alter table invites add column declined_at timestamptz;

comment on column invites.declined_at is
  'Set when an existing account holder declines an invitation. revoked_at is set at the same time so the live-invite unique index frees up.';

grant select on invites, users to nexus_bootstrap;
grant update on org_memberships, users to nexus_bootstrap;

-- ---------------------------------------------------------------------
-- my_workspaces(user) — every company this person belongs to.
-- ---------------------------------------------------------------------
create or replace function my_workspaces(p_user uuid)
returns table (org_id uuid, name text, org_type text, parent_name text, role text, is_home boolean, active boolean, joined_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.name, o.org_type, p.name, m.role, m.is_home, o.active, m.granted_at
    from org_memberships m
    join organizations o on o.id = m.org_id
    left join organizations p on p.id = o.parent_org_id
   where m.user_id = p_user
   order by m.is_home desc, o.name asc;
$$;

alter function my_workspaces(uuid) owner to nexus_bootstrap;
revoke all on function my_workspaces(uuid) from public;
grant execute on function my_workspaces(uuid) to nexus_app;

-- ---------------------------------------------------------------------
-- my_pending_invites(user) — invitations addressed to this person's
-- email from companies they are not in yet.
-- ---------------------------------------------------------------------
create or replace function my_pending_invites(p_user uuid)
returns table (id uuid, org_id uuid, org_name text, role text, invited_by_name text, created_at timestamptz, expires_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select i.id, i.org_id, o.name, i.role, g.name, i.created_at, i.expires_at
    from users u
    join invites i on lower(i.email) = lower(u.email)
    join organizations o on o.id = i.org_id
    left join users g on g.id = i.invited_by
   where u.id = p_user
     and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
     and o.active
     and not exists (select 1 from org_memberships m where m.user_id = p_user and m.org_id = i.org_id)
   order by i.created_at desc;
$$;

alter function my_pending_invites(uuid) owner to nexus_bootstrap;
revoke all on function my_pending_invites(uuid) from public;
grant execute on function my_pending_invites(uuid) to nexus_app;

-- ---------------------------------------------------------------------
-- set_home_workspace(user, org) — the company you land in at sign-in.
-- Keeps users.home_org_id (the cache) and org_memberships.is_home (the
-- source of truth) in step. Returns false if you aren't a member.
-- ---------------------------------------------------------------------
create or replace function set_home_workspace(p_user uuid, p_org uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from org_memberships where user_id = p_user and org_id = p_org) then
    return false;
  end if;
  update org_memberships set is_home = false where user_id = p_user and is_home and org_id <> p_org;
  update org_memberships set is_home = true where user_id = p_user and org_id = p_org;
  update users set home_org_id = p_org where id = p_user;
  return true;
end $$;

alter function set_home_workspace(uuid, uuid) owner to nexus_bootstrap;
revoke all on function set_home_workspace(uuid, uuid) from public;
grant execute on function set_home_workspace(uuid, uuid) to nexus_app;
