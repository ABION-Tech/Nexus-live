-- 0027_fix_users_insert_rls.sql
-- Session 9 hardening pass — live-Postgres isolation pass, item #1.
--
-- Bug: 0006_org_hierarchy_memberships.sql's `tenant_isolation` policy on
-- `users` was declared with only a USING clause and no explicit command
-- (i.e. `FOR ALL`). Postgres reuses USING as the implicit WITH CHECK for
-- ALL-command policies when none is given, so the same visibility check
-- also gated INSERT:
--
--   using (exists (select 1 from org_memberships m
--                  where m.user_id = users.id
--                    and m.org_id = current_setting('app.current_org_id', true)::uuid))
--
-- That check requires an org_memberships row referencing the user's id —
-- which cannot exist yet for a brand-new user at insert time (every real
-- signup path inserts the users row before the matching org_memberships
-- row: see inviteService.ts's acceptInvite and guestService.ts's
-- createGuestCredential). Under a properly RLS-enforced connection (the
-- nexus_app role, NOSUPERUSER NOBYPASSRLS — see 0001_init.sql and this
-- same hardening pass's DEPLOYMENT.md/.env.example fix), every new-user
-- insert fails closed with "new row violates row-level security policy
-- for table users" (42501). Confirmed empirically against real Postgres
-- 16: seedClickthrough.ts's makeUser() failed on exactly this insert
-- once DATABASE_URL was corrected to point at nexus_app instead of the
-- superuser role that had silently masked this since 0006 shipped.
--
-- Fix: split into command-specific policies. INSERT gets its own WITH
-- CHECK based on home_org_id: every insertion path in this codebase sets
-- home_org_id to the org being joined and runs inside
-- withOrgContext(thatSameOrgId, ...), so home_org_id matching
-- app.current_org_id is the correct, and only sensible, invariant for a
-- brand-new row that by definition has no org_memberships yet. Same
-- fail-closed property is preserved: if app.current_org_id is unset,
-- current_setting(...) is null, home_org_id (not-null on the column)
-- can never equal it, and the insert is rejected.
--
-- One more layer to this bug, found by actually re-running the fixed
-- policy against real Postgres rather than inspecting by eye: every
-- real insert path uses `insert into users (...) values (...) returning
-- id` (inviteService.ts, guestService.ts, seedClickthrough.ts). Per
-- Postgres RLS semantics, a RETURNING clause on INSERT also requires
-- the just-inserted row to satisfy the table's SELECT policy — not just
-- WITH CHECK — or the whole statement raises the same 42501 "new row
-- violates row-level security policy" error. The original
-- membership-EXISTS SELECT check has the identical chicken-and-egg gap
-- as the old combined policy did (no org_memberships row yet), so
-- fixing INSERT alone wasn't sufficient; confirmed by reproducing this
-- exact failure with `insert ... returning` after the INSERT-only fix,
-- and confirming the same statement without RETURNING succeeded.
-- SELECT therefore gets an added `or home_org_id = app.current_org_id`
-- branch. This doesn't widen real access: home_org_id is kept in sync
-- with exactly one is_home org_memberships row per user (0006's own
-- doc comment), so this branch is true in every case the EXISTS branch
-- already would be — it only additionally covers the narrow window
-- between a user's INSERT and its matching org_memberships INSERT
-- within the same transaction, which is exactly the gap being closed.
drop policy tenant_isolation on users;

create policy tenant_isolation_select on users
  for select
  using (
    exists (
      select 1 from org_memberships m
      where m.user_id = users.id
        and m.org_id = current_setting('app.current_org_id', true)::uuid
    )
    or home_org_id = current_setting('app.current_org_id', true)::uuid
  );

create policy tenant_isolation_insert on users
  for insert
  with check (
    home_org_id = current_setting('app.current_org_id', true)::uuid
  );

create policy tenant_isolation_update on users
  for update
  using (
    exists (
      select 1 from org_memberships m
      where m.user_id = users.id
        and m.org_id = current_setting('app.current_org_id', true)::uuid
    )
  )
  with check (
    exists (
      select 1 from org_memberships m
      where m.user_id = users.id
        and m.org_id = current_setting('app.current_org_id', true)::uuid
    )
  );

create policy tenant_isolation_delete on users
  for delete
  using (
    exists (
      select 1 from org_memberships m
      where m.user_id = users.id
        and m.org_id = current_setting('app.current_org_id', true)::uuid
    )
  );
