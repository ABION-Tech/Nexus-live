-- 0009_remaining_entities.sql
-- Closes out PRD §9.1's entity map. 0001–0008 covered organizations,
-- users, permissions, goals/pending_ai_tasks/tasks, task_trends,
-- sessions, invites, org_memberships, eod_logs, and Network (cos/
-- partnerships/org_contacts) — 8 of the 24 source sheets. This migration
-- adds the remaining 16: Knowledge Base, Chat (messages + read state),
-- Notifications, Leave, Meetings, Marketing, Automation (controls + log),
-- Task Checklists, Agent Handoffs, Push Subscriptions, Interns, Email
-- Accounts, and the two audit tables (Activity Log, Permission Log).
--
-- Same conventions as every prior migration: uuid pk, non-null org_id FK
-- to organizations, RLS via the tenant_isolation policy loop (DECISIONS.md
-- §3 — "denormalizing org_id onto every tenant-owned table is the rule,
-- not an exception"), created_at/updated_at where the row is mutable,
-- archived_at only where PRD §6.4.1's "archive, never hard-delete" rule
-- actually applies (entries a user edits over time — knowledge, meetings
-- — not append-only logs).

-- ---------------------------------------------------------------------
-- knowledge_entries (← 23. Knowledge Base, PRD §8.6)
-- ---------------------------------------------------------------------
create table knowledge_entries (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id),
  title            text not null,
  content          text not null,
  category         text,
  updated_by_user_id uuid references users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  archived_at      timestamptz
);
create index idx_knowledge_entries_org on knowledge_entries(org_id);

-- ---------------------------------------------------------------------
-- meetings (← 7. Meetings, PRD §8.2)
-- `title` is not-null per the PRD's own audit note: "the audit confirmed
-- this is not date-related; empty or mismatched Title is the bug" for
-- the Google Meet "Find in Calendar" search-by-title link. Enforced here
-- at the schema level, not just a form validation.
-- ---------------------------------------------------------------------
create table meetings (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organizations(id),
  title                  text not null,
  location_type          text not null check (location_type in ('physical', 'zoom', 'google_meet')),
  location_detail        text, -- address, Zoom link, or blank for Meet (found by title search)
  start_time             timestamptz not null,
  end_time               timestamptz,
  organizer_user_id      uuid references users(id),
  google_calendar_event_id text, -- PRD §10.5 — each meeting gets a synced Calendar event id
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  archived_at            timestamptz
);
create index idx_meetings_org on meetings(org_id);
create index idx_meetings_start on meetings(org_id, start_time);

-- ---------------------------------------------------------------------
-- marketing_content (← 6. Marketing, PRD §8.9 — content calendar)
-- ---------------------------------------------------------------------
create table marketing_content (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  content_type  text,
  platform      text,
  due_date      date,
  status        text not null default 'planned'
                  check (status in ('planned', 'in_progress', 'posted', 'skipped')),
  post_link     text,
  owner_user_id uuid references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz
);
create index idx_marketing_content_org on marketing_content(org_id);

-- ---------------------------------------------------------------------
-- automation_controls (← 8. Automation Controls, PRD §8.10)
-- Key/value feature flags — one row per automation type per org.
-- ---------------------------------------------------------------------
create table automation_controls (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  key         text not null, -- e.g. 'daily_morning_digest', 'cob_reminders' — PRD §12's 9 jobs
  enabled     boolean not null default true,
  updated_by_user_id uuid references users(id),
  updated_at  timestamptz not null default now(),
  unique (org_id, key)
);

-- ---------------------------------------------------------------------
-- automation_log (← 13. Automation Log — audit trail for toggle changes)
-- Append-only, no archived_at (PRD §13.10: "audit log is append-only").
-- ---------------------------------------------------------------------
create table automation_log (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  control_key   text not null,
  previous_value boolean,
  new_value     boolean not null,
  changed_by_user_id uuid references users(id),
  changed_at    timestamptz not null default now()
);
create index idx_automation_log_org on automation_log(org_id, changed_at desc);

-- ---------------------------------------------------------------------
-- chat_messages (← 10. Chat Messages, PRD §8.11)
-- Three channel types per §8.11: task-scoped threads, team-wide, and
-- AI/agent messages injected into a task thread (author_user_id null in
-- that case — the message is attributed to the system, not a person).
-- ---------------------------------------------------------------------
create table chat_messages (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id),
  channel         text not null check (channel in ('task', 'team', 'ai')),
  task_id         uuid references tasks(id), -- required when channel = 'task', null for 'team'
  author_user_id  uuid references users(id), -- null for system/AI-injected messages
  body            text not null,
  created_at      timestamptz not null default now()
);
create index idx_chat_messages_org on chat_messages(org_id);
create index idx_chat_messages_task on chat_messages(task_id, created_at);

-- ---------------------------------------------------------------------
-- chat_read_state (← 12. Chat Read State — per-user, per-channel last-read)
-- ---------------------------------------------------------------------
create table chat_read_state (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  user_id     uuid not null references users(id),
  channel     text not null check (channel in ('task', 'team', 'ai')),
  task_id     uuid references tasks(id),
  last_read_at timestamptz not null default now(),
  unique (org_id, user_id, channel, task_id)
);

-- ---------------------------------------------------------------------
-- notifications (← 18. Notifications, PRD §10.4)
-- ---------------------------------------------------------------------
create table notifications (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  user_id     uuid not null references users(id),
  task_id     uuid references tasks(id),
  type        text not null, -- e.g. 'assignment', 'deadline', 'digest' — PRD §10.4's notification-type axis
  channel     text not null check (channel in ('email', 'in_app', 'push', 'whatsapp')),
  title       text not null,
  body        text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index idx_notifications_org_user on notifications(org_id, user_id, read_at);

-- ---------------------------------------------------------------------
-- push_subscriptions (← 11. Push Subscriptions — web push endpoints)
-- ---------------------------------------------------------------------
create table push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  user_id     uuid not null references users(id),
  endpoint    text not null,
  p256dh_key  text not null,
  auth_key    text not null,
  created_at  timestamptz not null default now(),
  unique (user_id, endpoint)
);
create index idx_push_subscriptions_user on push_subscriptions(user_id);

-- ---------------------------------------------------------------------
-- leave_requests (← 21. Leave Requests, PRD §8.4)
-- ---------------------------------------------------------------------
create table leave_requests (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id),
  user_id          uuid not null references users(id),
  start_date       date not null,
  end_date         date not null,
  reason           text,
  status           text not null default 'pending'
                     check (status in ('pending', 'approved', 'rejected')),
  approved_by_user_id uuid references users(id),
  decided_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index idx_leave_requests_org_user on leave_requests(org_id, user_id);

-- ---------------------------------------------------------------------
-- task_checklists (← 17. Task Checklists)
-- ---------------------------------------------------------------------
create table task_checklists (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  task_id     uuid not null references tasks(id),
  item_text   text not null,
  is_done     boolean not null default false,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index idx_task_checklists_task on task_checklists(task_id, position);

-- ---------------------------------------------------------------------
-- agent_handoffs (← 20. Agent Handoffs, PRD §10.6 / §6.4.3)
-- This is also the execution log referenced in §6.4.3 ("Every execution
-- is persisted — this becomes the Agent Handoffs table... formalized as
-- a first-class execution log across all agent types"). `status` mirrors
-- the QUEUED → RUNNING → COMPLETE/FAILED/CANCELLED state machine.
-- ---------------------------------------------------------------------
create table agent_handoffs (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id),
  task_id             uuid references tasks(id),
  requested_by_user_id uuid references users(id),
  instructions        text,
  status              text not null default 'queued'
                        check (status in ('queued', 'running', 'complete', 'failed', 'cancelled')),
  n8n_execution_ref   text, -- n8n's own id, when the n8n-first path handled this (§10.6)
  result              text,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz
);
create index idx_agent_handoffs_org on agent_handoffs(org_id, created_at desc);

-- ---------------------------------------------------------------------
-- interns (← 10. Interns in the source sheet — same number as Chat
-- there, per PRD §9.1's own note; unrelated tables here)
-- Interns are users with role='intern' (PRD §3) — this table is their
-- EOD/task-progress/proof-link activity log, not a second identity
-- table. `intern_user_id` FKs to the same `users` table everyone else
-- is in.
-- ---------------------------------------------------------------------
create table intern_activity_logs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id),
  intern_user_id  uuid not null references users(id),
  task_id         uuid references tasks(id),
  proof_link      text,
  note            text,
  submitted_at    timestamptz not null default now()
);
create index idx_intern_activity_org on intern_activity_logs(org_id, intern_user_id);

-- ---------------------------------------------------------------------
-- email_accounts (← 10. Resend Accounts, PRD §10.3)
-- The multi-account rotation pool — Priority/Daily_Limit/Used_Today/
-- Last_Reset_Date/Enabled carried forward exactly, per the PRD's
-- explicit "do not simplify to a single Resend key" instruction.
-- ---------------------------------------------------------------------
create table email_accounts (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id),
  provider        text not null check (provider in ('resend', 'gmail')),
  email_address   text not null,
  priority        integer not null default 0,
  daily_limit     integer,
  used_today      integer not null default 0,
  last_reset_date date,
  enabled         boolean not null default true
);
create index idx_email_accounts_org on email_accounts(org_id, priority);

-- ---------------------------------------------------------------------
-- activity_log (← 14. Auto Activity — field-level change history)
-- Append-only (PRD §13.10). Feeds the unified audit log §13.10
-- describes; not itself the full `audit_log` table (that also needs
-- ip_address/session_id/result, which belong to the auth/request layer
-- rather than a field-diff table) — deliberately scoped to what the MVP's
-- own Auto Activity tracked, extendable later without reshaping this one.
-- ---------------------------------------------------------------------
create table activity_log (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  actor_user_id uuid references users(id),
  resource_type text not null,
  resource_id   uuid not null,
  field         text,
  old_value     text,
  new_value     text,
  changed_at    timestamptz not null default now()
);
create index idx_activity_log_org on activity_log(org_id, changed_at desc);
create index idx_activity_log_resource on activity_log(resource_type, resource_id);

-- ---------------------------------------------------------------------
-- permission_log (← 15. Permission Log — RBAC grant/revoke audit trail,
-- PRD §3 "already exists and should be carried forward")
-- ---------------------------------------------------------------------
create table permission_log (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id),
  target_user_id uuid not null references users(id),
  resource       text not null,
  action         text not null,
  granted        boolean not null, -- true = grant, false = revoke
  changed_by_user_id uuid references users(id),
  changed_at     timestamptz not null default now()
);
create index idx_permission_log_org on permission_log(org_id, changed_at desc);

-- ---------------------------------------------------------------------
-- Row-Level Security — same tenant_isolation shape as 0001/0008's loops,
-- applied to all 16 new tables. Append-only log tables get RLS too (PRD
-- §13.5's rule is "every tenant-owned record," not "every mutable one" —
-- a log row is still tenant-owned data an org must not read across).
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in select unnest(array[
    'knowledge_entries', 'meetings', 'marketing_content',
    'automation_controls', 'automation_log',
    'chat_messages', 'chat_read_state', 'notifications', 'push_subscriptions',
    'leave_requests', 'task_checklists', 'agent_handoffs',
    'intern_activity_logs', 'email_accounts',
    'activity_log', 'permission_log'
  ])
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = current_setting(''app.current_org_id'', true)::uuid)',
      t
    );
  end loop;
end $$;

grant select, insert, update, delete on
  knowledge_entries, meetings, marketing_content,
  automation_controls, automation_log,
  chat_messages, chat_read_state, notifications, push_subscriptions,
  leave_requests, task_checklists, agent_handoffs,
  intern_activity_logs, email_accounts,
  activity_log, permission_log
to nexus_app;
