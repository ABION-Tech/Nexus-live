-- 0016_admin_foundation.sql
-- Session 37 (repo numbering) = ADMIN_BUILD_GUIDE.md "Session 1": auth
-- foundation + org/guest management. First migration against the locked
-- plan in ADMIN_BUILD_GUIDE.md §1/§3. Scope is exactly that session's
-- schema half — service layer + isolation tests are the accompanying
-- apps/api changes, admin UI is deferred (Sessions 40/41 per the guide).

-- ---------------------------------------------------------------------
-- platform_admins — Super Admin. NOT an org concept (guide §1: "not an
-- org concept, no platform-level row in organizations"). Checked first,
-- ahead of the org-scoped chain, same posture rbac.ts's `role === 'leader'`
-- bypass already takes for org-level full access.
-- ---------------------------------------------------------------------
create table platform_admins (
  user_id     uuid primary key references users(id) on delete cascade,
  granted_by  uuid references users(id),
  granted_at  timestamptz not null default now()
);

-- No RLS here on purpose — this table is global, not tenant-owned, and
-- the whole point is that it's checked *before* any app.current_org_id
-- is known. Least-privilege is enforced by only ever calling it from
-- authorizationService.isPlatformAdmin(), never exposed to a general
-- query surface.
grant select, insert, delete on platform_admins to nexus_app;

-- ---------------------------------------------------------------------
-- organizations: plan hook (no enforcement — guide §1: "what plans
-- exist / pricing / upgrades stays fully out of scope", this session
-- only moves the value) + active flag for organizationService's
-- create/edit/deactivate surface.
-- ---------------------------------------------------------------------
alter table organizations
  add column plan   text not null default 'free' check (plan in ('free', 'paid')),
  add column active boolean not null default true;

-- ---------------------------------------------------------------------
-- organizations RLS — widen to a symmetric parent<->child rule.
-- 0006 already allowed "a company can see its parent group's row".
-- This adds the mirror: "a group can see its direct children's rows" —
-- the single new authorization rule the guide calls out as highest-risk
-- (§1: "leader-of-a-group -> read-scoped access to companies where
-- parent_org_id = group"). This widening is scoped to the organizations
-- directory row itself (name/plan/active — not tenant business data);
-- actual task/goal/etc. data in a child company is still read via N
-- separately-scoped withOrgContext(childOrgId, ...) calls per
-- DECISIONS.md §5's corollary, never a widened policy on a business
-- table. That doctrine is unchanged by this migration.
drop policy tenant_isolation on organizations;

create policy tenant_isolation on organizations
  using (
    id = current_setting('app.current_org_id', true)::uuid
    or id = (select parent_org_id from organizations where id = current_setting('app.current_org_id', true)::uuid)
    or parent_org_id = current_setting('app.current_org_id', true)::uuid
  );

-- ---------------------------------------------------------------------
-- org_memberships: new 'guest' role value. Guide §1: "most restrictive
-- default of any role — no blanket resource-type grants" — this is
-- purely a membership label; a guest gets zero rows in `permissions`
-- by default (hasPermission's leader-bypass doesn't apply to it, and
-- nothing grants it anything automatically), so no `permissions` schema
-- change is needed for the restriction itself to hold.
-- ---------------------------------------------------------------------
alter table org_memberships drop constraint org_memberships_role_check;
alter table org_memberships add constraint org_memberships_role_check
  check (role in ('leader', 'team_member', 'intern', 'guest'));

-- ---------------------------------------------------------------------
-- users: password_hash for guest sign-in only (guide §1: "guest signs
-- in with password-capable login — not OAuth-only"). Nullable and left
-- null for every OAuth user — this is not a parallel auth system for
-- normal accounts, PRD §13.2's OAuth-only decision for leaders/team
-- members/interns is unchanged.
-- ---------------------------------------------------------------------
alter table users add column password_hash text;

-- ---------------------------------------------------------------------
-- audit_log — schema only this session (guide §1: "New audit_log table
-- (schema only)"; auditLogService.ts's write side is Session 39/40 per
-- the guide's own numbering, folded into Super Admin backend). Deliberately
-- a new table, not an extension of activity_log/permission_log — PRD
-- §13.10 needs ip_address/user_agent/previous_value/new_value on
-- administrative actions specifically, which those two tables don't carry.
-- ---------------------------------------------------------------------
create table audit_log (
  id             uuid primary key default gen_random_uuid(),
  "timestamp"    timestamptz not null default now(),
  user_id        uuid references users(id),
  org_id         uuid references organizations(id), -- null for platform-level actions (org creation, plan changes issued by Super Admin, etc.)
  action         text not null,
  resource_type  text not null,
  resource_id    uuid,
  ip_address     text,
  user_agent     text,
  session_id     text,
  result         text not null check (result in ('success', 'forbidden', 'error')),
  previous_value jsonb,
  new_value      jsonb,
  metadata       jsonb
);

create index idx_audit_log_org on audit_log(org_id);
create index idx_audit_log_user on audit_log(user_id);
create index idx_audit_log_timestamp on audit_log("timestamp");

-- RLS: org-scoped entries follow the usual tenant_isolation shape —
-- org_id is null for platform-level rows, so those simply never match
-- this policy and are invisible to any org-scoped query, by construction
-- (same "fails closed" property every other policy here has). Platform-
-- level audit reads are a Super-Admin-only raw-pool path, same exemption
-- doctrine DECISIONS.md #4 already uses for `sessions` — built in
-- Session 39/40 alongside auditLogService.ts's read side, not this one.
alter table audit_log enable row level security;
alter table audit_log force row level security;

create policy tenant_isolation on audit_log
  using (org_id = current_setting('app.current_org_id', true)::uuid);

-- Append-only per PRD §13.10 ("Application code can write to it but
-- never delete from it") — no update/delete grant at all, not even
-- restricted to app-layer discipline.
grant select, insert on audit_log to nexus_app;
