-- 0037_platform_admin_invites.sql
-- Session 53. Lets a Super Admin be added by email before that person
-- has ever signed in: the invite that creates their account also carries
-- the Super Admin grant, applied in inviteService.acceptInvite() in the
-- same transaction that creates the users row. Existing accounts are
-- granted directly (platform_admins insert) and never need this flag.
--
-- Also the path for a Super Admin inviting a new company's first admin:
-- that invite is an ordinary leader invite into the target org; nothing
-- here is needed for it beyond the existing invites table.
alter table invites
  add column grant_platform_admin boolean not null default false;

comment on column invites.grant_platform_admin is
  'When true, accepting this invite also inserts the new user into platform_admins (granted_by = invited_by).';

-- ---------------------------------------------------------------------
-- list_platform_admins() — Platform > Super Admins. `users` has FORCE
-- RLS and the raw pool (nexus_app, NOBYPASSRLS) has no app.current_org_id,
-- so a plain join from platform_admins to users returns zero rows. Same
-- nexus_bootstrap SECURITY DEFINER pattern as search_users_platform()
-- (0019). Only ever called after isPlatformAdmin() has passed.
-- ---------------------------------------------------------------------
grant select on platform_admins to nexus_bootstrap;

create or replace function list_platform_admins()
returns table (user_id uuid, name text, email text, granted_at timestamptz, granted_by_name text)
language sql
security definer
set search_path = public
as $$
  select pa.user_id, u.name, u.email, pa.granted_at, g.name
    from platform_admins pa
    join users u on u.id = pa.user_id
    left join users g on g.id = pa.granted_by
   order by pa.granted_at asc;
$$;

alter function list_platform_admins() owner to nexus_bootstrap;
revoke all on function list_platform_admins() from public;
grant execute on function list_platform_admins() to nexus_app;
