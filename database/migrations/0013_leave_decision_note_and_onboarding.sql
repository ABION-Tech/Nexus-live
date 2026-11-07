-- 0013_leave_decision_note_and_onboarding.sql
-- PRD §7.2 04 PEOPLE → Leave + Onboarding, closing the two remaining gaps
-- flagged in ia.ts (Leave had a table but no route/service; Onboarding had
-- no schema at all). Attendance is deliberately left alone here — per
-- Session 15/20's own notes it's derived entirely from eod_logs
-- (0007_eod_logs.sql), not a separate record type, so there's nothing to
-- migrate for it.
--
-- Same conventions as every prior migration: uuid pk, non-null org_id FK,
-- RLS via the tenant_isolation policy loop (DECISIONS.md §3).

-- ---------------------------------------------------------------------
-- leave_requests — additive column only. The table itself already
-- exists (0009_remaining_entities.sql) with RLS + grants already applied;
-- this just adds somewhere for a leader's approve/reject decision to
-- carry a short note ("approved, cover confirmed" / "too close to the
-- Q3 deadline"), which the original table had no column for. Nullable,
-- additive, no backfill needed — every existing row simply has no note.
-- ---------------------------------------------------------------------
alter table leave_requests add column decision_note text;

-- ---------------------------------------------------------------------
-- onboarding_steps — the adjustable checklist template itself (PRD §7.2
-- 04 PEOPLE → Onboarding). Org-scoped, not global: each org defines its
-- own onboarding checklist. `is_active` is a soft-delete/hide flag
-- rather than a hard delete — archiving a step must not silently erase
-- onboarding_progress history for anyone who already completed it, the
-- same reasoning tasks/goals archive instead of deleting.
-- ---------------------------------------------------------------------
create table onboarding_steps (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  title       text not null,
  description text,
  position    integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index idx_onboarding_steps_org on onboarding_steps(org_id, position);

-- ---------------------------------------------------------------------
-- onboarding_progress — one row per (user, step) once that step has been
-- touched. No row at all = not started, same "absence means not-yet"
-- convention leave_requests/pending_ai_tasks already use elsewhere in
-- this schema, rather than a redundant `not_started` status value.
-- `completed_by_user_id` is nullable and distinct from `user_id`
-- precisely because a leader can check something off on a new hire's
-- behalf (PRD's "by leaders, or those authorized" requirement) — when
-- that happens this records who actually did it, not just whose
-- checklist it was.
-- ---------------------------------------------------------------------
create table onboarding_progress (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organizations(id),
  user_id               uuid not null references users(id) on delete cascade,
  step_id               uuid not null references onboarding_steps(id) on delete cascade,
  completed_at          timestamptz,
  completed_by_user_id  uuid references users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, user_id, step_id)
);
create index idx_onboarding_progress_user on onboarding_progress(org_id, user_id);

-- ---------------------------------------------------------------------
-- RLS — same tenant_isolation loop every prior migration uses.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['onboarding_steps', 'onboarding_progress']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = current_setting(''app.current_org_id'', true)::uuid)',
      t
    );
  end loop;
end $$;

grant select, insert, update, delete on onboarding_steps, onboarding_progress to nexus_app;
