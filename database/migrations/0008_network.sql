-- 0008_network.sql (renumbered from 0007 during reconciliation —
-- eod_logs already claimed 0007 in this branch)
-- PRD §9 entity map: network_cos (← 2. COS), partnerships (← 3.
-- Partnerships), org_contacts (← 4. Org Database) — the three
-- subsections PRD §8.3/§7.2 describe as "three CRM-ish views
-- consolidated into one section with subsections" sharing a
-- RelationshipTable/RelationshipCard component set on the frontend.
-- Backend follows the same consolidation: one migration, one service
-- file (networkService.ts), one route file — not three copy-pasted
-- verticals, per PRD §6.2's "only abstract repeated things" rule
-- applied to the thing that's actually repeated here (org/contact +
-- status + follow-up-date shape), while keeping each table's real
-- differences (COS has no per-row owner; Partnerships/Org do) as
-- actual separate tables, not one polymorphic one — same reasoning
-- DECISIONS.md #1 already applied to goals/pending_ai_tasks/tasks.

-- ---------------------------------------------------------------------
-- network_cos (← 2. COS — state admin contacts)
-- No per-row owner column, matching the MVP exactly: code.gs's
-- updateRow OWNERSHIP_TABS list is ['1. Master Tasks', '3.
-- Partnerships'] only — COS "has no per-row owner (it tracks state
-- records, not individual assignments)... protected purely by
-- field-level locks", per the MVP's own comment. Carried forward as:
-- no ownership-based access path for this table at all, only the flat
-- `network.cos` resource grant (see networkService.ts / routes/network.ts).
-- ---------------------------------------------------------------------
create table network_cos (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations(id),
  state                   text not null,
  admin_name              text,
  admin_phone             text,
  admin_email             text,
  whatsapp_group_created  boolean not null default false,
  members_count           integer,
  -- Ladder matches PROGRESS_LADDERS['2. COS'] in code.gs, snake_cased to
  -- match this schema's tasks/goals status convention.
  status                  text not null default 'not_started'
                            check (status in ('not_started', 'acknowledged', 'in_progress', 'follow_up_needed', 'active')),
  last_report_date        date,
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  archived_at             timestamptz,
  -- State was the MVP's natural ID (TAB_ID_COL['2. COS'] = 'State') —
  -- one row per state per org, enforced here rather than left as an
  -- accidental-uniqueness convention.
  unique (org_id, state)
);

create index idx_network_cos_org on network_cos(org_id);

-- ---------------------------------------------------------------------
-- partnerships (← 3. Partnerships)
-- Has a per-row owner (assigned_to_user_id) — one of the MVP's two
-- OWNERSHIP_TABS, same "own record" access shape tasks.ts already
-- implements (PRD §13.3: "Team Member → tasks.own → read, update").
-- ---------------------------------------------------------------------
create table partnerships (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organizations(id),
  assigned_to_user_id  uuid references users(id),
  organisation         text not null,
  contact_name         text,
  contact_email        text,
  category             text, -- free text (NGO/Government/Corporate/...) — a
                              -- growing classification list, not a fixed
                              -- enum; PRD §6.2 don't over-constrain what
                              -- isn't actually stable.
  -- Ladder matches PROGRESS_LADDERS['3. Partnerships'].
  current_status       text not null default 'not_started'
                          check (current_status in ('not_started', 'in_discussion', 'negotiating', 'cold', 'active', 'declined')),
  document_status      text not null default 'not_started'
                          check (document_status in ('not_started', 'draft_sent', 'under_review', 'signed', 'na')),
  last_contact_date    date,
  follow_up_date       date,
  remarks              text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  archived_at          timestamptz
);

create index idx_partnerships_org on partnerships(org_id);
create index idx_partnerships_assigned on partnerships(assigned_to_user_id);
-- Failsafe Alerts' "stale partner follow-ups" sub-table (PRD §8.7/§8.9)
-- queries exactly this shape — overdue, not-yet-resolved follow-ups.
create index idx_partnerships_followup on partnerships(org_id, follow_up_date)
  where archived_at is null and current_status not in ('active', 'declined');

-- ---------------------------------------------------------------------
-- org_contacts (← 4. Org Database — visitor/org intake, onboarding)
-- Has a per-row owner (contact_owner_user_id), same reasoning as
-- Partnerships — the MVP's own updateRow OWNERSHIP_TABS list didn't
-- include '4. Org Database', but that omission tracks the MVP audit's
-- "protect what's actually protected" note more than a deliberate design
-- choice, and PRD §13.3's ownership pattern is the correct default for
-- any table with a real per-row assignee column. Applied here rather
-- than silently ported as an open table.
-- ---------------------------------------------------------------------
create table org_contacts (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organizations(id),
  contact_owner_user_id  uuid references users(id),
  visitor_name           text not null,
  "position"             text,
  company_org            text,
  email                  text,
  phone                  text,
  state                  text,
  staff_size             text,
  date_visited           date,
  -- Matches formatRescueTapSheet's data-validation lists in code.gs.
  letter_status          text not null default 'not_sent'
                            check (letter_status in ('not_sent', 'sent', 'acknowledged')),
  onboarding_status      text not null default 'pending'
                            check (onboarding_status in ('pending', 'in_progress', 'active', 'declined')),
  whatsapp_added         boolean not null default false,
  follow_up_date         date,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  archived_at            timestamptz
);

create index idx_org_contacts_org on org_contacts(org_id);
create index idx_org_contacts_owner on org_contacts(contact_owner_user_id);

-- ---------------------------------------------------------------------
-- Row-Level Security — same tenant_isolation shape as 0001_init.sql's
-- loop, applied to these three new tables.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in select unnest(array['network_cos', 'partnerships', 'org_contacts'])
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = current_setting(''app.current_org_id'', true)::uuid)',
      t
    );
  end loop;
end $$;

grant select, insert, update, delete on network_cos, partnerships, org_contacts to nexus_app;

-- ---------------------------------------------------------------------
-- Read access is deliberately NOT open-by-default (see PRD §13.1 issue
-- S4: "readTab/readFiltered return full unfiltered rows to any
-- authenticated user... any team member can read the full Team Members
-- roster" — the exact bug class this schema/permissions model exists to
-- close). In the MVP, any authenticated user could read all of COS via
-- readAll(); in production, reading network_cos/partnerships/org_contacts
-- requires an explicit `network.cos` / `network.partnerships` /
-- `network.org` `read` grant (or the leader role), same shape as every
-- other resource in `permissions`. This is a deliberate behavior change
-- from the MVP, not an oversight — flagged here so it isn't mistaken for
-- one during Phase L security testing (PRD §13.14).
-- ---------------------------------------------------------------------
